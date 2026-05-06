export const fitResolution = (sourceWidth, sourceHeight, maxWidth, maxHeight) => {
  const widthRatio = maxWidth / sourceWidth;
  const heightRatio = maxHeight / sourceHeight;
  const scale = Math.min(widthRatio, heightRatio, 1);

  const width = Math.max(2, Math.round(sourceWidth * scale));
  const height = Math.max(2, Math.round(sourceHeight * scale));

  return {
    width: width % 2 === 0 ? width : width - 1,
    height: height % 2 === 0 ? height : height - 1,
  };
};

export const primeVideoReader = async (reader, replaceFrame) => {
  const { value: frame } = await reader.read();
  if (!frame) throw new Error("Cannot read initial video frame");

  replaceFrame(frame);

  return {
    width: frame.displayWidth || frame.codedWidth,
    height: frame.displayHeight || frame.codedHeight,
  };
};

export const replaceFrame = (owner, key, frame) => {
  const current = owner[key];
  if (current) current.close();
  owner[key] = frame;
};

export const closeFrame = (frame) => {
  try {
    frame?.close?.();
  } catch (error) {
    void error;
  }
};

export const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
