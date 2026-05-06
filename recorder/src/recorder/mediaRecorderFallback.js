import {
  addChunk,
  closeAndDeleteDatabase,
  concatArrayBuffers,
  openChunkDatabase,
  readChunks,
} from "./indexedDbChunks";

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

const pickMimeType = () => {
  for (const candidate of MIME_CANDIDATES) {
    if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
};

const waitForStop = (mediaRecorder) =>
  new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      resolve();
      return;
    }
    const previous = mediaRecorder.onstop;
    mediaRecorder.onstop = (event) => {
      previous?.(event);
      resolve();
    };
  });

const createVideoElement = async (stream) => {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", resolveReady);
      video.removeEventListener("error", rejectReady);
    };
    const resolveReady = () => {
      cleanup();
      resolve();
    };
    const rejectReady = () => {
      cleanup();
      reject(new Error("Could not initialize fallback video compositor"));
    };

    video.addEventListener("loadedmetadata", resolveReady, { once: true });
    video.addEventListener("error", rejectReady, { once: true });
  });

  await video.play();
  return video;
};

const fitCanvasSize = ({ width, height }) => {
  const sourceWidth = Number(width) || 1920;
  const sourceHeight = Number(height) || 1080;
  const scale = Math.min(1920 / sourceWidth, 1080 / sourceHeight, 1);
  const fittedWidth = Math.max(2, Math.round(sourceWidth * scale));
  const fittedHeight = Math.max(2, Math.round(sourceHeight * scale));

  return {
    width: fittedWidth % 2 === 0 ? fittedWidth : fittedWidth - 1,
    height: fittedHeight % 2 === 0 ? fittedHeight : fittedHeight - 1,
  };
};

const getPipLayout = ({ canvasWidth, canvasHeight, cameraVideo, pipOptions }) => {
  const cameraWidth = cameraVideo.videoWidth || 1280;
  const cameraHeight = cameraVideo.videoHeight || 720;
  const shape = pipOptions.pipShape || "rectangle";
  const padding = Math.round(canvasWidth * 0.02);
  let width = Math.max(2, Math.round(canvasWidth * (pipOptions.pipSize / 100)));
  let height = width;
  const crop = { x: 0, y: 0, width: cameraWidth, height: cameraHeight };

  if (shape === "rectangle") {
    height = Math.max(2, Math.round((width * cameraHeight) / cameraWidth));
  } else {
    const minDimension = Math.min(cameraWidth, cameraHeight);
    crop.width = minDimension;
    crop.height = minDimension;
    crop.x = (cameraWidth - minDimension) / 2;
    crop.y = (cameraHeight - minDimension) / 2;
  }

  const positions = {
    "top-left": { x: padding, y: padding },
    "top-center": { x: (canvasWidth - width) / 2, y: padding },
    "top-right": { x: canvasWidth - width - padding, y: padding },
    "center-left": { x: padding, y: (canvasHeight - height) / 2 },
    center: { x: (canvasWidth - width) / 2, y: (canvasHeight - height) / 2 },
    "center-right": {
      x: canvasWidth - width - padding,
      y: (canvasHeight - height) / 2,
    },
    "bottom-left": { x: padding, y: canvasHeight - height - padding },
    "bottom-center": {
      x: (canvasWidth - width) / 2,
      y: canvasHeight - height - padding,
    },
    "bottom-right": {
      x: canvasWidth - width - padding,
      y: canvasHeight - height - padding,
    },
  };
  const position = positions[pipOptions.pipPosition] || positions["bottom-right"];

  return {
    x: Math.round(position.x),
    y: Math.round(position.y),
    width,
    height,
    crop,
  };
};

const roundRect = (ctx, x, y, width, height, radius) => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

const createCanvasComposer = async ({
  displayStream,
  cameraStream,
  mixedAudioTrack,
  captureOptions,
  pipOptions,
}) => {
  const displayVideo = await createVideoElement(displayStream);
  const cameraVideo = await createVideoElement(cameraStream);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const currentPipOptions = { ...pipOptions };
  let running = false;
  let animationFrame = 0;

  if (!ctx) throw new Error("Could not create fallback canvas compositor");

  const size = fitCanvasSize(captureOptions);
  canvas.width = size.width;
  canvas.height = size.height;

  const draw = () => {
    if (!running) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(displayVideo, 0, 0, width, height);

    if (
      !currentPipOptions.pipHidden &&
      cameraVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      const layout = getPipLayout({
        canvasWidth: width,
        canvasHeight: height,
        cameraVideo,
        pipOptions: currentPipOptions,
      });
      const opacity = Math.max(
        0,
        Math.min(1, (currentPipOptions.pipOpacity || 100) / 100)
      );
      const radius = Math.round(
        (layout.width *
          Math.max(0, Number(currentPipOptions.pipBorderRadius || 0))) /
          100
      );

      ctx.save();
      if (currentPipOptions.pipShape === "circle") {
        ctx.beginPath();
        ctx.arc(
          layout.x + layout.width / 2,
          layout.y + layout.height / 2,
          layout.width / 2,
          0,
          Math.PI * 2
        );
        ctx.clip();
      } else {
        roundRect(ctx, layout.x, layout.y, layout.width, layout.height, radius);
        ctx.clip();
      }

      ctx.globalAlpha = opacity;
      ctx.drawImage(
        cameraVideo,
        layout.crop.x,
        layout.crop.y,
        layout.crop.width,
        layout.crop.height,
        layout.x,
        layout.y,
        layout.width,
        layout.height
      );
      ctx.restore();
    }

    animationFrame = requestAnimationFrame(draw);
  };

  const stream = canvas.captureStream(Math.min(30, captureOptions.fps || 30));
  if (mixedAudioTrack) stream.addTrack(mixedAudioTrack);

  return {
    stream,
    start() {
      running = true;
      draw();
    },
    updateOptions(options) {
      Object.assign(currentPipOptions, options || {});
    },
    stop() {
      running = false;
      cancelAnimationFrame(animationFrame);
      stream.getTracks().forEach((track) => track.stop());
      displayVideo.pause();
      cameraVideo.pause();
      displayVideo.srcObject = null;
      cameraVideo.srcObject = null;
    },
  };
};

export const createMediaRecorderFallback = async ({
  displayStream,
  cameraStream,
  mixedAudioTrack,
  captureOptions,
  pipOptions,
  onStarted,
  onError,
}) => {
  const displayTrack = displayStream.getVideoTracks()[0] || null;
  const cameraTrack = cameraStream?.getVideoTracks?.()[0] || null;
  const memoryChunks = [];
  let composer = null;
  let db = null;
  let writeChain = Promise.resolve();
  let mimeType = pickMimeType();

  if (!displayTrack) throw new Error("No display video track available");

  const stream =
    cameraTrack && HTMLCanvasElement.prototype.captureStream
      ? (composer = await createCanvasComposer({
          displayStream,
          cameraStream,
          mixedAudioTrack,
          captureOptions,
          pipOptions,
        })).stream
      : new MediaStream([
          displayTrack,
          ...(mixedAudioTrack ? [mixedAudioTrack] : []),
        ]);

  if (typeof indexedDB !== "undefined") {
    try {
      db = await openChunkDatabase(`mr_chunks_${Date.now()}`);
    } catch {
      db = null;
    }
  }

  const recorder = new MediaRecorder(
    stream,
    mimeType ? { mimeType } : undefined
  );
  mimeType = recorder.mimeType || mimeType || "video/webm";

  recorder.ondataavailable = (event) => {
    const data = event.data;
    if (!data || data.size === 0) return;

    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        if (db) {
          await addChunk(db, await data.arrayBuffer());
        } else {
          memoryChunks.push(data);
        }
      });
  };

  recorder.onstart = onStarted;
  recorder.onerror = (event) => {
    onError?.(event?.error || new Error("MediaRecorder error"));
  };

  return {
    mediaRecorder: recorder,
    db,
    mimeType,
    updateOptions(options) {
      composer?.updateOptions(options);
    },
    start() {
      composer?.start();
      recorder.start(1000);
    },
    async stop() {
      if (recorder.state !== "inactive") {
        const stopped = waitForStop(recorder);
        recorder.requestData?.();
        recorder.stop();
        await stopped;
      }
      composer?.stop();

      await writeChain;

      if (db) {
        const buffers = await readChunks(db);
        const blob = new Blob([concatArrayBuffers(buffers)], { type: mimeType });
        closeAndDeleteDatabase(db);
        db = null;
        return blob;
      }

      return new Blob(memoryChunks, { type: mimeType });
    },
    cleanup() {
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch (error) {
          void error;
        }
      }
      composer?.stop();
      if (db) {
        closeAndDeleteDatabase(db);
        db = null;
      }
      memoryChunks.length = 0;
    },
  };
};
