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
      const profile = getCaptureProfile();
      const quality = getResolutionForQuality(profile.quality);
      const bitrates = getBitrates(profile.quality);

      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: profile.fps, max: profile.fps },
          width: { ideal: Math.max(3840, quality.width), max: 7680 },
          height: { ideal: Math.max(2160, quality.height), max: 4320 },
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

      audioGraph = await createMixedAudioGraph({
        systemStream: displayStream,
        micStream,
      });

      worker = createRecorderWorker();

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

      const cameraVideoTrack = cameraStream.getVideoTracks()[0] || null;
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
        },
      };

      if (cameraVideoReadable?.readable) transfer.push(cameraVideoReadable.readable);
      if (audioReadable?.readable) transfer.push(audioReadable.readable);

      worker.postMessage(
        {
          type: "start",
          payload,
        },
        transfer
      );
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
    } = get();
    if (!worker || (!isRecording && !isStarting) || status === "stopping") return;

    set({
      status: "stopping",
      isRecording: false,
      isStarting: false,
    });

    worker.postMessage({ type: "stop" });
  },

  cleanup: async () => {
    const {
      worker,
      displayStream,
      cameraStream,
      micStream,
      audioGraph,
    } = get();

    worker?.terminate();
    await cleanupAudioGraph(audioGraph);
    stopStream(displayStream);
    stopStream(cameraStream);
    stopStream(micStream);

    set({
      worker: null,
      displayStream: null,
      cameraStream: null,
      micStream: null,
      audioContext: null,
      audioGraph: null,
      mixedAudioTrack: null,
    });
  },
}));
