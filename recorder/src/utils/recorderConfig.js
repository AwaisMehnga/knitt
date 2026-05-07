export const MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=h264",
  "video/webm",
  "video/mp4",
  "video/webm;codecs=avc1",
];

export const RECORDING_QUALITIES = [
  { value: "native", label: "Native", width: null, height: null },
  { value: "1440p", label: "1440p", width: 2560, height: 1440 },
  { value: "1080p", label: "1080p", width: 1920, height: 1080 },
  { value: "720p", label: "720p", width: 1280, height: 720 },
];

export const RECORDING_FPS_OPTIONS = [60, 30, 24, 15];

export const BITRATE_PRESETS = {
  efficient: {
    label: "Efficient",
    description: "Small files, crisp screen text",
    multiplier: 0.75,
  },
  balanced: {
    label: "Balanced",
    description: "Best default for quality and size",
    multiplier: 1,
  },
  high: {
    label: "High detail",
    description: "More motion detail, larger files",
    multiplier: 1.45,
  },
  custom: {
    label: "Custom",
    description: "Choose the exact video bitrate",
    multiplier: 1,
  },
};

export const VIDEO_QUALITIES = {
  native: { width: null, height: null },
  "1440p": { width: 2560, height: 1440 },
  "4k": { width: 4096, height: 2160 },
  "1080p": { width: 1920, height: 1080 },
  "720p": { width: 1280, height: 720 },
  "480p": { width: 854, height: 480 },
  "360p": { width: 640, height: 360 },
  "240p": { width: 426, height: 240 },
  default: { width: 1920, height: 1080 },
};

export function getResolutionForQuality(qualityValue = "default") {
  return VIDEO_QUALITIES[qualityValue] || VIDEO_QUALITIES.default;
}

const even = (value) => {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
};

const fitWithin = ({ sourceWidth, sourceHeight, maxWidth, maxHeight }) => {
  if (!maxWidth || !maxHeight) {
    return { width: even(sourceWidth), height: even(sourceHeight) };
  }

  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1);
  return {
    width: even(sourceWidth * scale),
    height: even(sourceHeight * scale),
  };
};

export function computeScreenVideoBitrate({ width, height, fps, preset = "balanced" }) {
  const safeWidth = Number(width) || 1920;
  const safeHeight = Number(height) || 1080;
  const safeFps = Number(fps) || 30;
  const pixelsPerFrame = safeWidth * safeHeight;
  const fpsFactor = Math.sqrt(safeFps / 30);
  const baseBitsPerPixel = 0.055;
  const presetMultiplier = BITRATE_PRESETS[preset]?.multiplier || 1;

  return Math.round(pixelsPerFrame * 30 * baseBitsPerPixel * fpsFactor * presetMultiplier);
}

export function resolveRecordingSettings({
  sourceWidth,
  sourceHeight,
  sourceFps,
  quality = "1080p",
  fps = 30,
  bitratePreset = "balanced",
  customVideoBitrateMbps = 3,
  audioBitrateKbps = 96,
}) {
  const selectedQuality = getResolutionForQuality(quality);
  const target = fitWithin({
    sourceWidth: sourceWidth || selectedQuality.width || 1920,
    sourceHeight: sourceHeight || selectedQuality.height || 1080,
    maxWidth: selectedQuality.width,
    maxHeight: selectedQuality.height,
  });
  const targetFps = Math.max(15, Math.min(Number(fps) || 30, Math.round(sourceFps || fps || 30)));
  const videoBitrate =
    bitratePreset === "custom"
      ? Math.round(Math.max(0.5, Number(customVideoBitrateMbps) || 3) * 1_000_000)
      : computeScreenVideoBitrate({
          width: target.width,
          height: target.height,
          fps: targetFps,
          preset: bitratePreset,
        });

  return {
    fps: targetFps,
    width: target.width,
    height: target.height,
    videoBitrate,
    audioBitrate: Math.round(Math.max(48, Number(audioBitrateKbps) || 96) * 1000),
    bitrateMode: "variable",
  };
}
