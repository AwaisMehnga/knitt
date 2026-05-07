export const detectRecorderCapabilities = () => ({
  mediaDevices: Boolean(navigator.mediaDevices?.getDisplayMedia),
  getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
  mediaRecorder: typeof MediaRecorder !== "undefined",
  canvasCaptureStream:
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function",
  indexedDB: typeof indexedDB !== "undefined",
  opfs: Boolean(navigator.storage?.getDirectory),
  webCodecs:
    typeof VideoEncoder !== "undefined" &&
    typeof AudioEncoder !== "undefined" &&
    typeof MediaStreamTrackProcessor !== "undefined" &&
    typeof VideoFrame !== "undefined" &&
    typeof OffscreenCanvas !== "undefined",
});

export const getCaptureProfile = () => {
  const cores = Number(navigator.hardwareConcurrency || 0);
  const memory = Number(navigator.deviceMemory || 0);
  const memoryKnown = memory > 0;
  const highEnd = memoryKnown ? cores >= 8 && memory >= 8 : cores >= 6;

  return highEnd
    ? { quality: "1080p", fps: 30 }
    : { quality: "1080p", fps: 30 };
};
