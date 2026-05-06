import { getBitrates, getResolutionForQuality } from "../utils/recorderConfig";
import { getUserMediaWithFallback } from "../utils/mediaDeviceFallback";
import {
  computeAdaptiveVideoBitrate,
  getCaptureProfile,
} from "./capabilities";

export const stopStream = (stream) => {
  stream?.getTracks?.().forEach((track) => track.stop());
};

export const captureRecorderStreams = async ({ recordCamera, recordMic }) => {
  const profile = getCaptureProfile();
  const quality = getResolutionForQuality(profile.quality);
  const bitrates = getBitrates(profile.quality);

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: profile.fps, max: profile.fps },
      width: { ideal: Math.max(3840, quality.width), max: 7680 },
      height: { ideal: Math.max(2160, quality.height), max: 4320 },
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
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: profile.fps, max: profile.fps },
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
  const targetWidth = displaySettings.width || quality.width;
  const targetHeight = displaySettings.height || quality.height;
  const targetFps = Math.round(displaySettings.frameRate || profile.fps);

  return {
    displayStream,
    cameraStream,
    micStream,
    displayVideoTrack,
    cameraVideoTrack: cameraStream?.getVideoTracks()[0] || null,
    captureOptions: {
      fps: targetFps,
      width: targetWidth,
      height: targetHeight,
      videoBitrate: Math.max(
        bitrates.video,
        computeAdaptiveVideoBitrate({
          width: targetWidth,
          height: targetHeight,
          fps: targetFps,
        })
      ),
      audioBitrate: bitrates.audio,
    },
  };
};

export const stopRecorderStreams = ({ displayStream, cameraStream, micStream }) => {
  stopStream(displayStream);
  stopStream(cameraStream);
  stopStream(micStream);
};
