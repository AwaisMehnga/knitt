import { getEncodableAudioCodecs } from "mediabunny";

const MUXER_CODEC_TO_WEBCODECS = {
  aac: ["mp4a.40.2", "mp4a.40.5", "mp4a.40.29"],
  opus: ["opus"],
};

const even = (value) => {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
};

const fitSize = ({ width, height, maxWidth, maxHeight }) => {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: even(width * scale),
    height: even(height * scale),
  };
};

const getSizeCandidates = ({ width, height }) => {
  const sizes = [
    { width, height },
    fitSize({ width, height, maxWidth: 3840, maxHeight: 2160 }),
    fitSize({ width, height, maxWidth: 2560, maxHeight: 1440 }),
    fitSize({ width, height, maxWidth: 1920, maxHeight: 1080 }),
    fitSize({ width, height, maxWidth: 1280, maxHeight: 720 }),
  ];
  const seen = new Set();

  return sizes.filter((size) => {
    const key = `${size.width}x${size.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const chooseVideoEncoderConfig = async ({
  width,
  height,
  fps,
  bitrate,
  bitrateMode = "variable",
}) => {
  const base = {
    framerate: fps,
    latencyMode: "realtime",
  };

  const candidates = [
    { codec: "avc1.640034", hardwareAcceleration: "prefer-hardware" },
    { codec: "avc1.640033", hardwareAcceleration: "prefer-hardware" },
    { codec: "avc1.64002A", hardwareAcceleration: "prefer-hardware" },
    { codec: "avc1.4D4034", hardwareAcceleration: "prefer-hardware" },
    { codec: "avc1.4D4033", hardwareAcceleration: "prefer-hardware" },
    { codec: "avc1.4D401F", hardwareAcceleration: "prefer-hardware" },
    { codec: "avc1.42E01E", hardwareAcceleration: "prefer-hardware" },
    { codec: "avc1.640034", hardwareAcceleration: "prefer-software" },
    { codec: "avc1.640033", hardwareAcceleration: "prefer-software" },
    { codec: "avc1.64002A", hardwareAcceleration: "prefer-software" },
    { codec: "avc1.4D4034", hardwareAcceleration: "prefer-software" },
    { codec: "avc1.4D4033", hardwareAcceleration: "prefer-software" },
    { codec: "avc1.4D401F", hardwareAcceleration: "prefer-software" },
    { codec: "avc1.42E01E", hardwareAcceleration: "prefer-software" },
  ];
  const bitrateModes = [bitrateMode, bitrateMode === "variable" ? undefined : "variable", undefined];
  const avcOptions = [{ format: "avc" }, undefined];

  for (const size of getSizeCandidates({ width, height })) {
    const scaledBitrate = Math.max(
      500_000,
      Math.round(bitrate * ((size.width * size.height) / (width * height)))
    );

    for (const candidate of candidates) {
      for (const bitrateMode of bitrateModes) {
        for (const avc of avcOptions) {
          const config = {
            ...base,
            ...size,
            ...candidate,
            bitrate: scaledBitrate,
          };
          if (bitrateMode) config.bitrateMode = bitrateMode;
          if (avc) config.avc = avc;

          try {
            const support = await VideoEncoder.isConfigSupported(config);
            if (support?.supported) return support.config || config;
          } catch (error) {
            void error;
          }
        }
      }
    }
  }

  throw new Error("No supported H.264 encoder found for worker recorder");
};

export const chooseAudioEncoderConfig = async ({ audioConfig, bitrate }) => {
  const detectedSampleRate = audioConfig?.sampleRate || 48_000;
  const detectedChannels = audioConfig?.channelCount || 2;

  let encodableCodecs = [];
  try {
    encodableCodecs = await getEncodableAudioCodecs(undefined, {
      sampleRate: detectedSampleRate,
      numberOfChannels: detectedChannels,
      bitrate,
    });
  } catch (error) {
    void error;
  }

  const supported = encodableCodecs.filter(
    (codec) => codec in MUXER_CODEC_TO_WEBCODECS
  );
  const sampleRates = [...new Set([detectedSampleRate, 48_000, 44_100])];
  const channelCounts =
    detectedChannels > 1 ? [detectedChannels, 1] : [detectedChannels];

  for (const muxerCodec of supported) {
    for (const codec of MUXER_CODEC_TO_WEBCODECS[muxerCodec]) {
      for (const sampleRate of sampleRates) {
        for (const numberOfChannels of channelCounts) {
          const candidate = { codec, sampleRate, numberOfChannels, bitrate };
          try {
            const support = await AudioEncoder.isConfigSupported(candidate);
            if (support?.supported) {
              return {
                muxerCodec,
                config: support.config || candidate,
                sampleRate: support.config?.sampleRate || sampleRate,
              };
            }
          } catch (error) {
            void error;
          }
        }
      }
    }
  }

  return null;
};
