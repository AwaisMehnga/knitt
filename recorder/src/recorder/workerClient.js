export const createRecorderWorker = () =>
  new Worker(new URL("../workers/recorder.js", import.meta.url), {
    type: "module",
  });

export const createWorkerStartPayload = ({
  displayVideoTrack,
  cameraVideoTrack,
  mixedAudioTrack,
  audioContext,
  captureOptions,
  pipOptions,
}) => {
  const screen = new MediaStreamTrackProcessor({ track: displayVideoTrack });
  const camera = cameraVideoTrack
    ? new MediaStreamTrackProcessor({ track: cameraVideoTrack })
    : null;
  const audio = mixedAudioTrack
    ? new MediaStreamTrackProcessor({ track: mixedAudioTrack })
    : null;

  const transfer = [screen.readable];
  if (camera?.readable) transfer.push(camera.readable);
  if (audio?.readable) transfer.push(audio.readable);

  return {
    transfer,
    payload: {
      screenReadable: screen.readable,
      cameraReadable: camera?.readable || null,
      audioReadable: audio?.readable || null,
      audioConfig: mixedAudioTrack
        ? {
            sampleRate:
              mixedAudioTrack.getSettings().sampleRate ||
              audioContext?.sampleRate ||
              48000,
            channelCount: mixedAudioTrack.getSettings().channelCount || 2,
          }
        : null,
      options: {
        ...captureOptions,
        ...pipOptions,
      },
    },
  };
};
