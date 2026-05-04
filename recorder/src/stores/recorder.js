import { create } from "zustand";
import { getBitrates, getResolutionForQuality } from "../utils/recorderConfig";
import { getUserMediaWithFallback } from "../utils/mediaDeviceFallback";

const DEFAULT_QUALITY = "4k";
const DEFAULT_FPS = 60;

const createRecorderWorker = () =>
  new Worker(new URL("../workers/recorder.js", import.meta.url), {
    type: "module",
  });

const stopStream = (stream) => {
  stream?.getTracks?.().forEach((track) => track.stop());
};

const closeAudioContext = async (audioContext) => {
  if (!audioContext || audioContext.state === "closed") return;

  try {
    await audioContext.close();
  } catch (error) {
    if (error?.name !== "InvalidStateError") {
      throw error;
    }
  }
};

const disconnectNode = (node) => {
  try {
    node?.disconnect?.();
  } catch (error) {
    void error;
  }
};

const cleanupAudioGraph = async (audioGraph) => {
  if (!audioGraph) return;

  disconnectNode(audioGraph.audioInputSource);
  disconnectNode(audioGraph.audioOutputSource);
  disconnectNode(audioGraph.audioInputGain);
  disconnectNode(audioGraph.audioOutputGain);
  audioGraph.mixedTrack?.stop?.();
  await closeAudioContext(audioGraph.audioContext);
};

const createTrackReadable = (track) => {
  if (!track) return null;
  const processor = new MediaStreamTrackProcessor({ track });
  return {
    processor,
    readable: processor.readable,
  };
};

const getCaptureProfile = () => {
  const cores = Number(navigator.hardwareConcurrency || 0);
  const memory = Number(navigator.deviceMemory || 0);
  const memoryKnown = memory > 0;
  const highEnd = memoryKnown ? cores >= 8 && memory >= 8 : cores >= 6;

  if (highEnd) {
    return {
      quality: DEFAULT_QUALITY,
      fps: DEFAULT_FPS,
    };
  }

  // Keep recording smooth on low-end devices.
  return {
    quality: "1080p",
    fps: 30,
  };
};

const computeAdaptiveVideoBitrate = ({ width, height, fps }) => {
  const safeWidth = Number(width) || 1920;
  const safeHeight = Number(height) || 1080;
  const safeFps = Number(fps) || 30;
  const pixelsPerSecond = safeWidth * safeHeight * safeFps;
  const bitrate = Math.round(pixelsPerSecond * 0.12);

  // Keep quality high while bounding extreme values.
  return Math.min(45_000_000, Math.max(8_000_000, bitrate));
};

const createMixedAudioGraph = async ({ systemStream, micStream }) => {
  const systemTrack = systemStream?.getAudioTracks?.()[0] || null;
  const micTrack = micStream?.getAudioTracks?.()[0] || null;

  if (!systemTrack && !micTrack) {
    return {
      audioContext: null,
      destination: null,
      audioInputSource: null,
      audioOutputSource: null,
      audioInputGain: null,
      audioOutputGain: null,
      mixedTrack: null,
    };
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextCtor();
  const destination = audioContext.createMediaStreamDestination();
  let audioInputSource = null;
  let audioOutputSource = null;
  let audioInputGain = null;
  let audioOutputGain = null;

  if (systemTrack) {
    audioOutputSource = audioContext.createMediaStreamSource(
      new MediaStream([systemTrack])
    );
    audioOutputGain = audioContext.createGain();
    audioOutputGain.gain.value = 1;
    audioOutputSource.connect(audioOutputGain).connect(destination);
  }

  if (micTrack) {
    audioInputSource = audioContext.createMediaStreamSource(
      new MediaStream([micTrack])
    );
    audioInputGain = audioContext.createGain();
    audioInputGain.gain.value = 1;
    audioInputSource.connect(audioInputGain).connect(destination);
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return {
    audioContext,
    destination,
    audioInputSource,
    audioOutputSource,
    audioInputGain,
    audioOutputGain,
    mixedTrack: destination.stream.getAudioTracks()[0] || null,
  };
};

export const useRecorderStore = create((set, get) => ({
  isRecording: false,
  isStarting: false,
  status: "idle",
  error: null,
  videoUrl: null,
  blob: null,
  worker: null,
  mediaRecorder: null,
  fallbackDB: null,
  useMediaRecorderFallback: false,
  chunks: [],
  capabilities: null,
  recordCamera: false,
  recordMic: true,
  // PiP customization
  pipPosition: "bottom-left",
  pipSize: 12,
  pipOpacity: 100,
  pipBorderRadius: 8,
  pipShape: "circle",
  pipHidden: false,
  displayStream: null,
  cameraStream: null,
  micStream: null,
  audioContext: null,
  audioGraph: null,
  mixedAudioTrack: null,

  startRecording: async () => {
    if (get().isRecording || get().isStarting) return;

    const previousUrl = get().videoUrl;
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
    }

    set({
      isStarting: true,
      status: "requesting-permissions",
      error: null,
      blob: null,
      videoUrl: null,
    });

    let displayStream = null;
    let cameraStream = null;
    let micStream = null;
    let worker = null;
    let audioGraph = null;

    try {
      // Runtime capability detection
      const capabilities = {
        opfs: Boolean(navigator.storage?.getDirectory),
        idb: typeof indexedDB !== "undefined",
        webcodecs:
          typeof window.VideoEncoder !== "undefined" &&
          typeof window.AudioEncoder !== "undefined" &&
          typeof window.MediaStreamTrackProcessor !== "undefined",
      };

      // Expose capabilities in state for UI
      set({ capabilities });
      const profile = getCaptureProfile();
      const quality = getResolutionForQuality(profile.quality);
      const bitrates = getBitrates(profile.quality);

      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: profile.fps, max: profile.fps },
          width: { ideal: Math.max(3840, quality.width), max: 7680 },
          height: { ideal: Math.max(2160, quality.height), max: 4320 },
          displaySurface: "monitor",
        },
        audio: true,
      });

      const displayVideoTrack = displayStream.getVideoTracks()[0] || null;
      const displaySettings = displayVideoTrack?.getSettings?.() || {};
      const targetWidth = displaySettings.width || quality.width;
      const targetHeight = displaySettings.height || quality.height;
      const targetFps = Math.round(displaySettings.frameRate || profile.fps);
      const targetVideoBitrate = computeAdaptiveVideoBitrate({
        width: targetWidth,
        height: targetHeight,
        fps: targetFps,
      });

      // Conditionally acquire camera stream based on user selection
      if (get().recordCamera) {
        cameraStream = await getUserMediaWithFallback({
          constraints: {
            video: {
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              frameRate: { ideal: profile.fps, max: profile.fps },
            },
            audio: false,
          },
        });
      }

      // Conditionally acquire mic stream based on user selection
      if (get().recordMic) {
        try {
          micStream = await getUserMediaWithFallback({
            constraints: {
              video: false,
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            },
          });
        } catch (err) {
          micStream = null;
        }
      }

      audioGraph = await createMixedAudioGraph({
        systemStream: displayStream,
        micStream,
      });

      // If WebCodecs not available, use MediaRecorder fallback that writes chunks to IndexedDB
      let useMediaRecorderFallback = !capabilities.webcodecs;

      worker = null;
      let mediaRecorder = null;
      let fallbackDB = null;
      const fallbackStoreName = `mr_chunks_${Date.now()}`;

      // Helpers for IndexedDB in main thread (used by MediaRecorder fallback)
      const openIdb = (name) =>
        new Promise((resolve, reject) => {
          try {
            const req = indexedDB.open(name, 1);
            req.onupgradeneeded = (ev) => {
              const db = ev.target.result;
              if (!db.objectStoreNames.contains("chunks")) {
                db.createObjectStore("chunks", { autoIncrement: true });
              }
            };
            req.onsuccess = (ev) => resolve(ev.target.result);
            req.onerror = (ev) => reject(ev.target.error);
          } catch (error) {
            reject(error);
          }
        });

      const addChunkToIdb = (db, chunk) =>
        new Promise((resolve, reject) => {
          try {
            const tx = db.transaction(["chunks"], "readwrite");
            const store = tx.objectStore("chunks");
            const req = store.add(chunk);
            req.onsuccess = () => resolve();
            req.onerror = (ev) => reject(ev.target.error);
          } catch (error) {
            reject(error);
          }
        });

      const readAllFromIdb = (db) =>
        new Promise((resolve, reject) => {
          try {
            const tx = db.transaction(["chunks"], "readonly");
            const store = tx.objectStore("chunks");
            const req = store.getAll();
            req.onsuccess = (ev) => resolve(ev.target.result || []);
            req.onerror = (ev) => reject(ev.target.error);
          } catch (error) {
            reject(error);
          }
        });

      const deleteIdb = (db) => {
        try {
          const name = db.name;
          db.close();
          indexedDB.deleteDatabase(name);
        } catch (e) {
          void e;
        }
      };

      if (useMediaRecorderFallback) {
        // Prepare MediaRecorder fallback: record display video + mixed audio (no PiP)
        try {
          fallbackDB = await openIdb(fallbackStoreName);
        } catch (err) {
          fallbackDB = null;
        }
      } else {
        worker = createRecorderWorker();
      }

      if (worker) {
        worker.onerror = (event) => {
        get().cleanup();
        set({
          isRecording: false,
          isStarting: false,
          status: "error",
          error: event.message || "Recorder worker crashed",
          worker: null,
        });
      };

        worker.onmessage = async (event) => {
        const { type, blob, error } = event.data || {};

        if (type === "started") {
          set({
            isRecording: true,
            isStarting: false,
            status: "recording",
          });
          return;
        }

        if (type === "stopped" && blob) {
          await cleanupAudioGraph(audioGraph);
          stopStream(displayStream);
          stopStream(cameraStream);
          stopStream(micStream);
          worker.terminate();
          const videoUrl = URL.createObjectURL(blob);
          set({
            isRecording: false,
            isStarting: false,
            status: "stopped",
            blob,
            videoUrl,
            worker: null,
            displayStream: null,
            cameraStream: null,
            micStream: null,
            audioContext: null,
            audioGraph: null,
            mixedAudioTrack: null,
          });
          return;
        }

        if (type === "error") {
          get().cleanup();
          set({
            isRecording: false,
            isStarting: false,
            status: "error",
            error,
            worker: null,
          });
        }
        };
      }

      if (useMediaRecorderFallback) {
        // Start MediaRecorder on a composed stream: display video + mixed audio
        const mixedAudioTrack = audioGraph.mixedTrack || null;
        const mrStream = new MediaStream();
        const displayTrack = displayStream.getVideoTracks()[0];
        if (displayTrack) mrStream.addTrack(displayTrack);
        if (mixedAudioTrack) mrStream.addTrack(mixedAudioTrack);

        const mimeCandidates = [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
        ];
        let mimeType = "video/webm";
        for (const c of mimeCandidates) {
          if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) {
            mimeType = c;
            break;
          }
        }

        try {
          mediaRecorder = new MediaRecorder(mrStream, { mimeType });
        } catch (err) {
          mediaRecorder = null;
        }

        if (!mediaRecorder) {
          throw new Error("No suitable MediaRecorder available for fallback");
        }

        mediaRecorder.ondataavailable = async (ev) => {
          try {
            const data = ev.data;
            if (fallbackDB && data && data.size > 0) {
              const arrayBuffer = await data.arrayBuffer();
              await addChunkToIdb(fallbackDB, arrayBuffer);
            } else if (data && data.size > 0) {
              // If IDB not available, keep in memory
              get().chunks?.push(data);
            }
          } catch (e) {
            void e;
          }
        };

        mediaRecorder.onstart = () => {
          set({ isRecording: true, isStarting: false, status: "recording", worker: null });
        };

        mediaRecorder.onerror = (ev) => {
          get().cleanup();
          set({ isRecording: false, isStarting: false, status: "error", error: ev?.error?.message || "MediaRecorder error" });
        };

        // Start with 1s timeslices to produce frequent chunks
        mediaRecorder.start(1000);
        // Store reference for stop
        set({ mediaRecorder, fallbackDB, useMediaRecorderFallback: true, worker: null });
      }

      const cameraVideoTrack = cameraStream?.getVideoTracks()[0] || null;
      const mixedAudioTrack = audioGraph.mixedTrack || null;
      const screenVideoReadable = createTrackReadable(displayVideoTrack);
      const cameraVideoReadable = createTrackReadable(cameraVideoTrack);
      const audioReadable = createTrackReadable(mixedAudioTrack);

      displayVideoTrack?.addEventListener("ended", () => {
        if (get().isRecording) {
          get().stopRecording();
        }
      });

      set({
        worker,
        displayStream,
        cameraStream,
        micStream,
        audioContext: audioGraph.audioContext,
        audioGraph,
        mixedAudioTrack,
        status: "starting-worker",
      });

      const transfer = [screenVideoReadable.readable];
      const payload = {
        screenReadable: screenVideoReadable.readable,
        cameraReadable: cameraVideoReadable?.readable || null,
        audioReadable: audioReadable?.readable || null,
        audioConfig: mixedAudioTrack
          ? {
              sampleRate:
                mixedAudioTrack.getSettings().sampleRate ||
                audioGraph.audioContext?.sampleRate ||
                48000,
              channelCount: mixedAudioTrack.getSettings().channelCount || 2,
            }
          : null,
        options: {
          fps: targetFps,
          width: targetWidth,
          height: targetHeight,
          videoBitrate: Math.max(bitrates.video, targetVideoBitrate),
          audioBitrate: bitrates.audio,
          debug: import.meta.env.DEV,
          pipPosition: get().pipPosition,
          pipSize: get().pipSize,
          pipOpacity: get().pipOpacity,
          pipBorderRadius: get().pipBorderRadius,
          pipShape: get().pipShape,
          pipHidden: get().pipHidden,
        },
      };

      if (cameraVideoReadable?.readable) transfer.push(cameraVideoReadable.readable);
      if (audioReadable?.readable) transfer.push(audioReadable.readable);

      if (worker) {
        worker.postMessage(
          {
            type: "start",
            payload,
          },
          transfer
        );
      }
    } catch (error) {
      worker?.terminate();
      stopStream(displayStream);
      stopStream(cameraStream);
      stopStream(micStream);
      await cleanupAudioGraph(audioGraph);

      set({
        isRecording: false,
        isStarting: false,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        worker: null,
        displayStream: null,
        cameraStream: null,
        micStream: null,
        audioContext: null,
        audioGraph: null,
        mixedAudioTrack: null,
      });
    }
  },

  stopRecording: async () => {
    const {
      worker,
      isRecording,
      isStarting,
      status,
      useMediaRecorderFallback,
      mediaRecorder,
      fallbackDB,
      chunks,
    } = get();
    if ((!worker && !useMediaRecorderFallback) || (!isRecording && !isStarting) || status === "stopping") return;

    set({ status: "stopping", isRecording: false, isStarting: false });

    if (useMediaRecorderFallback) {
      // Stop MediaRecorder and assemble blob from IDB or memory
      try {
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
          mediaRecorder.stop();
        }
      } catch (e) {
        void e;
      }

      // Wait briefly for final dataavailable events to flush
      await new Promise((r) => setTimeout(r, 800));

      try {
        if (fallbackDB) {
          const tx = fallbackDB.transaction(["chunks"], "readonly");
          const store = tx.objectStore("chunks");
          const req = store.getAll();
          const arr = await new Promise((resolve, reject) => {
            req.onsuccess = (ev) => resolve(ev.target.result || []);
            req.onerror = (ev) => reject(ev.target.error);
          });

          if (arr && arr.length) {
            const total = arr.reduce((s, b) => s + b.byteLength, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const buf of arr) {
              out.set(new Uint8Array(buf), off);
              off += buf.byteLength;
            }
            const blob = new Blob([out.buffer], { type: "video/webm" });
            const videoUrl = URL.createObjectURL(blob);
            // cleanup DB
            try {
              const name = fallbackDB.name;
              fallbackDB.close();
              indexedDB.deleteDatabase(name);
            } catch (e) {
              void e;
            }
            set({ isRecording: false, isStarting: false, status: "stopped", blob, videoUrl, mediaRecorder: null, fallbackDB: null, useMediaRecorderFallback: false });
            return;
          }
        }

        // Fallback to in-memory chunks if IDB not available
        if (chunks && chunks.length) {
          const blob = new Blob(chunks, { type: "video/webm" });
          const videoUrl = URL.createObjectURL(blob);
          set({ isRecording: false, isStarting: false, status: "stopped", blob, videoUrl, mediaRecorder: null, fallbackDB: null, useMediaRecorderFallback: false, chunks: [] });
          return;
        }
      } catch (error) {
        void error;
      }

      // If nothing produced
      set({ isRecording: false, isStarting: false, status: "stopped", mediaRecorder: null, fallbackDB: null, useMediaRecorderFallback: false });
      return;
    }

    if (worker) {
      worker.postMessage({ type: "stop" });
    }
  },

  cleanup: async () => {
    const {
      worker,
      displayStream,
      cameraStream,
      micStream,
      audioGraph,
      mediaRecorder,
      fallbackDB,
    } = get();

    try {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        try {
          mediaRecorder.stop();
        } catch (e) {
          void e;
        }
      }
    } catch (e) {
      void e;
    }

    try {
      if (fallbackDB) {
        try {
          const name = fallbackDB.name;
          fallbackDB.close();
          indexedDB.deleteDatabase(name);
        } catch (e) {
          void e;
        }
      }
    } catch (e) {
      void e;
    }

    worker?.terminate();
    await cleanupAudioGraph(audioGraph);
    stopStream(displayStream);
    stopStream(cameraStream);
    stopStream(micStream);

    set({
      worker: null,
      mediaRecorder: null,
      fallbackDB: null,
      useMediaRecorderFallback: false,
      displayStream: null,
      cameraStream: null,
      micStream: null,
      audioContext: null,
      audioGraph: null,
      mixedAudioTrack: null,
      chunks: [],
    });
  },

  toggleRecordCamera: () => {
    set({ recordCamera: !get().recordCamera });
  },

  toggleRecordMic: () => {
    set({ recordMic: !get().recordMic });
  },

  setRecordCamera: (value) => {
    set({ recordCamera: Boolean(value) });
  },

  setRecordMic: (value) => {
    set({ recordMic: Boolean(value) });
  },

  setPipPosition: (position) => {
    set({ pipPosition: position });
  },

  setPipSize: (size) => {
    set({ pipSize: Math.max(10, Math.min(50, Number(size))) });
  },

  setPipOpacity: (opacity) => {
    set({ pipOpacity: Math.max(0, Math.min(100, Number(opacity))) });
  },

  setPipBorderRadius: (radius) => {
    set({ pipBorderRadius: Math.max(0, Math.min(100, Number(radius))) });
  },

  setPipShape: (shape) => {
    set({ pipShape: shape });
  },

  togglePipVisibility: () => {
    set({ pipHidden: !get().pipHidden });
  },

  updatePipPositionDuringRecording: (position) => {
    const { worker, useMediaRecorderFallback } = get();
    set({ pipPosition: position });
    
    // Send update to worker in real-time if recording with WebCodecs
    if (worker && !useMediaRecorderFallback) {
      worker.postMessage({
        type: "updateOptions",
        options: {
          pipPosition: position,
        },
      });
    }
  },

  updatePipVisibilityDuringRecording: () => {
    const { worker, useMediaRecorderFallback, pipHidden } = get();
    const newHidden = !pipHidden;
    set({ pipHidden: newHidden });
    
    // Send update to worker in real-time if recording with WebCodecs
    if (worker && !useMediaRecorderFallback) {
      worker.postMessage({
        type: "updateOptions",
        options: {
          pipHidden: newHidden,
        },
      });
    }
  },
}));
