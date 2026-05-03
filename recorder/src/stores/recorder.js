import { create } from "zustand";
import { getBitrates, getResolutionForQuality } from "../offline-recorder/recorder/recorderConfig";
import { getUserMediaWithFallback } from "../offline-recorder/shared/pages-utils/mediaDeviceFallback";

const DEFAULT_QUALITY = "1080p";
const DEFAULT_FPS = 30;

const createRecorderWorker = () =>
  new Worker(new URL("../workers/recorder.js", import.meta.url), {
    type: "module",
  });

const stopStream = (stream) => {
  stream?.getTracks?.().forEach((track) => track.stop());
};

const createTrackReadable = (track) => {
  if (!track) return null;
  const processor = new MediaStreamTrackProcessor({ track });
  return {
    processor,
    readable: processor.readable,
  };
};

const mixAudioStreams = (streams) => {
  const tracks = streams.flatMap((stream) => stream?.getAudioTracks?.() || []);
  if (!tracks.length) {
    return { audioContext: null, destination: null, mixedTrack: null };
  }

  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  streams.forEach((stream) => {
    if (!stream?.getAudioTracks?.().length) return;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(destination);
  });

  return {
    audioContext,
    destination,
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
  audioContext: null,
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
    let worker = null;
    let audioContext = null;

    try {
      const quality = getResolutionForQuality(DEFAULT_QUALITY);
      const bitrates = getBitrates(DEFAULT_QUALITY);

      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: DEFAULT_FPS, max: DEFAULT_FPS },
          width: { ideal: quality.width },
          height: { ideal: quality.height },
        },
        audio: true,
      });

      cameraStream = await getUserMediaWithFallback({
        constraints: {
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: DEFAULT_FPS, max: DEFAULT_FPS },
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        },
      });

      const audio = mixAudioStreams([displayStream, cameraStream]);
      audioContext = audio.audioContext;

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

      worker.onmessage = (event) => {
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
          stopStream(displayStream);
          stopStream(cameraStream);
          audioContext?.close?.();
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
            audioContext: null,
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

      const displayVideoTrack = displayStream.getVideoTracks()[0] || null;
      const cameraVideoTrack = cameraStream.getVideoTracks()[0] || null;
      const mixedAudioTrack = audio.mixedTrack || null;
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
        audioContext,
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
              sampleRate: mixedAudioTrack.getSettings().sampleRate || 48000,
              channelCount: mixedAudioTrack.getSettings().channelCount || 2,
            }
          : null,
        options: {
          fps: DEFAULT_FPS,
          width: quality.width,
          height: quality.height,
          videoBitrate: bitrates.video,
          audioBitrate: bitrates.audio,
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
      await audioContext?.close?.();

      set({
        isRecording: false,
        isStarting: false,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        worker: null,
        displayStream: null,
        cameraStream: null,
        audioContext: null,
        mixedAudioTrack: null,
      });
    }
  },

  stopRecording: async () => {
    const {
      worker,
      isRecording,
      isStarting,
      displayStream,
      cameraStream,
      mixedAudioTrack,
      audioContext,
    } = get();
    if (!worker || (!isRecording && !isStarting)) return;

    set({
      status: "stopping",
    });

    stopStream(displayStream);
    stopStream(cameraStream);
    mixedAudioTrack?.stop?.();
    await audioContext?.close?.();

    worker.postMessage({ type: "stop" });
  },

  cleanup: async () => {
    const {
      worker,
      displayStream,
      cameraStream,
      audioContext,
      mixedAudioTrack,
    } = get();

    worker?.terminate();
    stopStream(displayStream);
    stopStream(cameraStream);
    mixedAudioTrack?.stop?.();
    await audioContext?.close?.();

    set({
      worker: null,
      displayStream: null,
      cameraStream: null,
      audioContext: null,
      mixedAudioTrack: null,
    });
  },
}));
