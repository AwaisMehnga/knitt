import { create } from "zustand";
import { cleanupAudioGraph, createMixedAudioGraph } from "../recorder/audioGraph";
import { detectRecorderCapabilities } from "../recorder/capabilities";
import { createMediaRecorderFallback } from "../recorder/mediaRecorderFallback";
import {
  captureRecorderStreams,
  stopRecorderStreams,
} from "../recorder/mediaStreams";
import {
  createRecorderWorker,
  createWorkerStartPayload,
} from "../recorder/workerClient";

const initialRecorderState = {
  isRecording: false,
  isStarting: false,
  status: "idle",
  error: null,
  videoUrl: null,
  blob: null,
  worker: null,
  fallbackRecorder: null,
  useMediaRecorderFallback: false,
  capabilities: null,
  displayStream: null,
  cameraStream: null,
  micStream: null,
  audioContext: null,
  audioGraph: null,
  mixedAudioTrack: null,
};

const initialPipState = {
  recordCamera: false,
  recordMic: true,
  pipPosition: "bottom-left",
  pipSize: 12,
  pipOpacity: 100,
  pipBorderRadius: 8,
  pipShape: "circle",
  pipHidden: false,
};

const cleanupSession = async ({
  worker,
  fallbackRecorder,
  displayStream,
  cameraStream,
  micStream,
  audioGraph,
}) => {
  worker?.terminate?.();
  fallbackRecorder?.cleanup?.();
  await cleanupAudioGraph(audioGraph);
  stopRecorderStreams({ displayStream, cameraStream, micStream });
};

const getPipOptions = (state) => ({
  debug: import.meta.env.DEV,
  pipPosition: state.pipPosition,
  pipSize: state.pipSize,
  pipOpacity: state.pipOpacity,
  pipBorderRadius: state.pipBorderRadius,
  pipShape: state.pipShape,
  pipHidden: state.pipHidden,
});

const createVideoUrl = (blob, previousUrl) => {
  if (previousUrl) URL.revokeObjectURL(previousUrl);
  return URL.createObjectURL(blob);
};

export const useRecorderStore = create((set, get) => ({
  ...initialRecorderState,
  ...initialPipState,

  startRecording: async () => {
    if (get().isRecording || get().isStarting) return;

    const previousUrl = get().videoUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);

    set({
      isStarting: true,
      status: "requesting-permissions",
      error: null,
      blob: null,
      videoUrl: null,
    });

    let worker = null;
    let fallbackRecorder = null;
    let capture = null;
    let audioGraph = null;

    try {
      const capabilities = detectRecorderCapabilities();
      set({ capabilities });

      if (!capabilities.mediaDevices || !capabilities.getUserMedia) {
        throw new Error("This browser cannot capture screen and media devices.");
      }

      capture = await captureRecorderStreams({
        recordCamera: get().recordCamera,
        recordMic: get().recordMic,
      });

      audioGraph = await createMixedAudioGraph({
        systemStream: capture.displayStream,
        micStream: capture.micStream,
      });

      const useWorkerPipeline = capabilities.webCodecs;

      capture.displayVideoTrack?.addEventListener("ended", () => {
        if (get().isRecording || get().isStarting) {
          get().stopRecording();
        }
      });

      set({
        displayStream: capture.displayStream,
        cameraStream: capture.cameraStream,
        micStream: capture.micStream,
        audioContext: audioGraph.audioContext,
        audioGraph,
        mixedAudioTrack: audioGraph.mixedTrack,
      });

      const startFallbackRecorder = async () => {
        if (!capabilities.mediaRecorder) {
          throw new Error("This browser does not support WebCodecs or MediaRecorder.");
        }

        worker?.terminate?.();
        worker = null;

        fallbackRecorder = await createMediaRecorderFallback({
          displayStream: capture.displayStream,
          cameraStream: capture.cameraStream,
          mixedAudioTrack: audioGraph.mixedTrack,
          captureOptions: capture.captureOptions,
          pipOptions: getPipOptions(get()),
          onStarted: () => {
            set({
              isRecording: true,
              isStarting: false,
              status: "recording",
              error: null,
              useMediaRecorderFallback: true,
            });
          },
          onError: (error) => {
            get().cleanup();
            set({
              isRecording: false,
              isStarting: false,
              status: "error",
              error: error?.message || "MediaRecorder error",
            });
          },
        });

        set({
          worker: null,
          fallbackRecorder,
          useMediaRecorderFallback: true,
          status: "starting-fallback-recorder",
        });
        fallbackRecorder.start();
      };

      const failWithCleanup = async (error) => {
        await cleanupSession({
          worker,
          fallbackRecorder,
          displayStream: capture?.displayStream,
          cameraStream: capture?.cameraStream,
          micStream: capture?.micStream,
          audioGraph,
        });

        set({
          isRecording: false,
          isStarting: false,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          worker: null,
          fallbackRecorder: null,
          useMediaRecorderFallback: false,
          displayStream: null,
          cameraStream: null,
          micStream: null,
          audioContext: null,
          audioGraph: null,
          mixedAudioTrack: null,
        });
      };

      const startFallbackFromWorkerFailure = async (error) => {
        try {
          set({
            worker: null,
            status: "starting-fallback-recorder",
            error: import.meta.env.DEV
              ? error instanceof Error
                ? error.message
                : String(error)
              : null,
          });
          await startFallbackRecorder();
        } catch (fallbackError) {
          await failWithCleanup(fallbackError);
        }
      };

      if (!useWorkerPipeline) {
        await startFallbackRecorder();
        return;
      }

      worker = createRecorderWorker();
      worker.onerror = (event) => {
        void startFallbackFromWorkerFailure(
          new Error(event.message || "Recorder worker crashed")
        );
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
          await cleanupSession({
            worker,
            displayStream: capture.displayStream,
            cameraStream: capture.cameraStream,
            micStream: capture.micStream,
            audioGraph,
          });
          set({
            ...initialRecorderState,
            ...initialPipState,
            recordCamera: get().recordCamera,
            recordMic: get().recordMic,
            pipPosition: get().pipPosition,
            pipSize: get().pipSize,
            pipOpacity: get().pipOpacity,
            pipBorderRadius: get().pipBorderRadius,
            pipShape: get().pipShape,
            pipHidden: get().pipHidden,
            isRecording: false,
            isStarting: false,
            status: "stopped",
            blob,
            videoUrl: createVideoUrl(blob, get().videoUrl),
            capabilities: get().capabilities,
          });
          return;
        }

        if (type === "error") {
          await startFallbackFromWorkerFailure(new Error(error || "Recorder worker error"));
        }
      };

      try {
        const { payload, transfer } = createWorkerStartPayload({
          displayVideoTrack: capture.displayVideoTrack,
          cameraVideoTrack: capture.cameraVideoTrack,
          mixedAudioTrack: audioGraph.mixedTrack,
          audioContext: audioGraph.audioContext,
          captureOptions: capture.captureOptions,
          pipOptions: getPipOptions(get()),
        });

        set({ worker, useMediaRecorderFallback: false, status: "starting-worker" });
        worker.postMessage({ type: "start", payload }, transfer);
      } catch (error) {
        await startFallbackFromWorkerFailure(error);
      }
    } catch (error) {
      await cleanupSession({
        worker,
        fallbackRecorder,
        displayStream: capture?.displayStream,
        cameraStream: capture?.cameraStream,
        micStream: capture?.micStream,
        audioGraph,
      });

      set({
        isRecording: false,
        isStarting: false,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        worker: null,
        fallbackRecorder: null,
        useMediaRecorderFallback: false,
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
      fallbackRecorder,
      isRecording,
      isStarting,
      status,
      useMediaRecorderFallback,
    } = get();

    if ((!worker && !fallbackRecorder) || (!isRecording && !isStarting)) return;
    if (status === "stopping") return;

    set({ status: "stopping", isRecording: false, isStarting: false });

    if (useMediaRecorderFallback && fallbackRecorder) {
      try {
        const blob = await fallbackRecorder.stop();
        await cleanupSession(get());
        set({
          ...initialRecorderState,
          ...initialPipState,
          recordCamera: get().recordCamera,
          recordMic: get().recordMic,
          pipPosition: get().pipPosition,
          pipSize: get().pipSize,
          pipOpacity: get().pipOpacity,
          pipBorderRadius: get().pipBorderRadius,
          pipShape: get().pipShape,
          pipHidden: get().pipHidden,
          status: "stopped",
          blob,
          videoUrl: createVideoUrl(blob, get().videoUrl),
          capabilities: get().capabilities,
        });
      } catch (error) {
        await get().cleanup();
        set({
          isRecording: false,
          isStarting: false,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    worker?.postMessage({ type: "stop" });
  },

  cleanup: async () => {
    await cleanupSession(get());
    set({
      worker: null,
      fallbackRecorder: null,
      useMediaRecorderFallback: false,
      displayStream: null,
      cameraStream: null,
      micStream: null,
      audioContext: null,
      audioGraph: null,
      mixedAudioTrack: null,
    });
  },

  toggleRecordCamera: () => set({ recordCamera: !get().recordCamera }),
  toggleRecordMic: () => set({ recordMic: !get().recordMic }),
  setRecordCamera: (value) => set({ recordCamera: Boolean(value) }),
  setRecordMic: (value) => set({ recordMic: Boolean(value) }),
  setPipPosition: (position) => set({ pipPosition: position }),
  setPipSize: (size) => set({ pipSize: Math.max(10, Math.min(50, Number(size))) }),
  setPipOpacity: (opacity) =>
    set({ pipOpacity: Math.max(0, Math.min(100, Number(opacity))) }),
  setPipBorderRadius: (radius) =>
    set({ pipBorderRadius: Math.max(0, Math.min(100, Number(radius))) }),
  setPipShape: (shape) => set({ pipShape: shape }),
  togglePipVisibility: () => set({ pipHidden: !get().pipHidden }),

  updatePipPositionDuringRecording: (position) => {
    const { worker, fallbackRecorder, useMediaRecorderFallback } = get();
    set({ pipPosition: position });
    if (worker && !useMediaRecorderFallback) {
      worker.postMessage({
        type: "updateOptions",
        options: { pipPosition: position },
      });
    } else if (fallbackRecorder && useMediaRecorderFallback) {
      fallbackRecorder.updateOptions({ pipPosition: position });
    }
  },

  updatePipVisibilityDuringRecording: () => {
    const { worker, fallbackRecorder, useMediaRecorderFallback, pipHidden } = get();
    const pipHiddenNext = !pipHidden;
    set({ pipHidden: pipHiddenNext });
    if (worker && !useMediaRecorderFallback) {
      worker.postMessage({
        type: "updateOptions",
        options: { pipHidden: pipHiddenNext },
      });
    } else if (fallbackRecorder && useMediaRecorderFallback) {
      fallbackRecorder.updateOptions({ pipHidden: pipHiddenNext });
    }
  },
}));
