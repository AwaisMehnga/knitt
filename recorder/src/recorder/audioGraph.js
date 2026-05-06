const disconnectNode = (node) => {
  try {
    node?.disconnect?.();
  } catch (error) {
    void error;
  }
};

const closeAudioContext = async (audioContext) => {
  if (!audioContext || audioContext.state === "closed") return;

  try {
    await audioContext.close();
  } catch (error) {
    if (error?.name !== "InvalidStateError") throw error;
  }
};

export const createMixedAudioGraph = async ({ systemStream, micStream }) => {
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

export const cleanupAudioGraph = async (audioGraph) => {
  if (!audioGraph) return;

  disconnectNode(audioGraph.audioInputSource);
  disconnectNode(audioGraph.audioOutputSource);
  disconnectNode(audioGraph.audioInputGain);
  disconnectNode(audioGraph.audioOutputGain);
  audioGraph.mixedTrack?.stop?.();
  await closeAudioContext(audioGraph.audioContext);
};
