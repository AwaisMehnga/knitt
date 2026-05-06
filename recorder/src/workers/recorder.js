import { WorkerRecorder } from "./recorder/WorkerRecorder";

const state = {
  controller: null,
};

self.onmessage = async (event) => {
  const { type, payload, options } = event.data || {};

  try {
    if (type === "updateOptions") {
      state.controller?.updateOptions(payload?.options || options || {});
      return;
    }

    if (type === "start") {
      state.controller = new WorkerRecorder(payload);
      await state.controller.start();
      return;
    }

    if (type === "stop") {
      await state.controller?.stop();
      state.controller = null;
    }
  } catch (error) {
    await state.controller?.cleanup?.();
    state.controller = null;
    postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
