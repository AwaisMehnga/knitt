import { getResolutionForQuality, resolveRecordingSettings } from "../utils/recorderConfig";
import { getUserMediaWithFallback } from "../utils/mediaDeviceFallback";
import { getCaptureProfile } from "./capabilities";

export const stopStream = (stream) => {
  stream?.getTracks?.().forEach((track) => track.stop());
};

export const captureRecorderStreams = async ({
  recordCamera,
  recordMic,
  recordingQuality,
  recordingFps,
  bitratePreset,
  customVideoBitrateMbps,
  audioBitrateKbps,
}) => {
  const profile = getCaptureProfile();
  const qualityValue = recordingQuality || profile.quality;
  const quality = getResolutionForQuality(qualityValue);
  const requestedFps = Number(recordingFps || profile.fps);
  const idealWidth = quality.width || 3840;
  const idealHeight = quality.height || 2160;

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: requestedFps, max: requestedFps },
      width: { ideal: idealWidth },
      height: { ideal: idealHeight },
      displaySurface: "monitor",
    },
    audio: true,
  });

  let cameraStream = null;
  let micStream = null;

  if (recordCamera) {
    cameraStream = await getUserMediaWithFallback({
      constraints: {
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: Math.min(requestedFps, 30), max: Math.min(requestedFps, 30) },
        },
        audio: false,
      },
    });
  }

  if (recordMic) {
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
    } catch {
      micStream = null;
    }
  }

  const displayVideoTrack = displayStream.getVideoTracks()[0] || null;
  const displaySettings = displayVideoTrack?.getSettings?.() || {};
  const recordingSettings = resolveRecordingSettings({
    sourceWidth: displaySettings.width || quality.width,
    sourceHeight: displaySettings.height || quality.height,
    sourceFps: displaySettings.frameRate || requestedFps,
    quality: qualityValue,
    fps: requestedFps,
    bitratePreset,
    customVideoBitrateMbps,
    audioBitrateKbps,
  });

  return {
    displayStream,
    cameraStream,
    micStream,
    displayVideoTrack,
    cameraVideoTrack: cameraStream?.getVideoTracks()[0] || null,
    captureOptions: {
      ...recordingSettings,
    },
  };
};

export const stopRecorderStreams = ({ displayStream, cameraStream, micStream }) => {
  stopStream(displayStream);
  stopStream(cameraStream);
  stopStream(micStream);
};
