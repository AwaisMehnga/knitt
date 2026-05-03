import { Mp4MuxerWrapper } from "../offline-recorder/recorder/webcodecs/Mp4MuxerWrapper.ts";

const state = {
  controller: null,
};

class WorkerRecorder {
  constructor({ screenReadable, cameraReadable, audioReadable, audioConfig, options }) {
    this.screenReadable = screenReadable;
    this.cameraReadable = cameraReadable || null;
    this.audioReadable = audioReadable || null;
    this.audioConfig = audioConfig || null;
    this.options = {
      fps: options?.fps || 30,
      width: options?.width || 1920,
      height: options?.height || 1080,
      videoBitrate: options?.videoBitrate || 8_000_000,
      audioBitrate: options?.audioBitrate || 128_000,
      debug: Boolean(options?.debug),
    };

    this.running = false;
    this.startedAtUs = null;
    this.frameIndex = 0;
    this.frameDurationUs = Math.round(1_000_000 / this.options.fps);
    this.keyFrameIntervalFrames = Math.max(30, Math.round(this.options.fps * 2));
    this.lastKeyFrameIndex = 0;
    this.audioSamplesWritten = 0;
    this.audioSampleRate = 48_000;

    this.screenReader = null;
    this.cameraReader = null;
    this.audioReader = null;

    this.latestScreenFrame = null;
    this.latestCameraFrame = null;

    this.screenPumpPromise = null;
    this.cameraPumpPromise = null;
    this.audioPumpPromise = null;
    this.renderLoopPromise = null;

    this.canvas = null;
    this.ctx = null;

    this.videoEncoder = null;
    this.audioEncoder = null;
    this.muxer = null;

    this.chunks = [];
  }

  log(...args) {
    if (this.options.debug) {
      console.log("[WorkerRecorder]", ...args);
    }
  }

  async start() {
    if (!this.screenReadable) {
      throw new Error("No screen video readable received by worker");
    }

    this.running = true;

    this.screenReader = this.screenReadable.getReader();
    const probe = await this.primeVideoReader(this.screenReader, "latestScreenFrame");
    const target = this.fitResolution(
      probe.width,
      probe.height,
      this.options.width,
      this.options.height
    );

    this.canvas = new OffscreenCanvas(target.width, target.height);
    this.ctx = this.canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });

    if (!this.ctx) {
      throw new Error("Could not create offscreen 2D context");
    }

    this.muxer = new Mp4MuxerWrapper({
      width: target.width,
      height: target.height,
      fps: this.options.fps,
      videoBitrate: this.options.videoBitrate,
      audioBitrate: this.options.audioBitrate,
      videoCodec: "avc",
      audioCodec: this.audioReadable ? "aac" : undefined,
      onChunk: (chunk) => {
        this.chunks.push(chunk);
      },
      debug: this.options.debug,
    });

    if (this.audioReadable) {
      this.muxer.enableAudio();
    }

    await this.muxer.start();

    const videoConfig = await this.chooseVideoEncoderConfig({
      width: target.width,
      height: target.height,
      fps: this.options.fps,
      bitrate: this.options.videoBitrate,
    });
    await this.initVideoEncoder(videoConfig.config);

    if (this.audioReadable) {
      const audioConfig = await this.prepareAudioEncoderConfig();
      if (audioConfig) {
        await this.initAudioEncoder(audioConfig);
      } else {
        this.audioReadable = null;
      }
    }

    this.screenPumpPromise = this.pumpVideoFrames(this.screenReader, "screen");

    if (this.cameraReadable) {
      this.cameraReader = this.cameraReadable.getReader();
      await this.primeVideoReader(this.cameraReader, "latestCameraFrame");
      this.cameraPumpPromise = this.pumpVideoFrames(this.cameraReader, "camera");
    }

    if (this.audioReadable && this.audioEncoder) {
      this.audioReader = this.audioReadable.getReader();
      this.audioPumpPromise = this.readAudioLoop();
    }

    this.renderLoopPromise = this.renderLoop();

    postMessage({
      type: "started",
      meta: {
        width: target.width,
        height: target.height,
        fps: this.options.fps,
      },
    });
  }

  async stop() {
    if (!this.running) return;

    this.running = false;

    await Promise.allSettled([
      this.screenPumpPromise,
      this.cameraPumpPromise,
      this.audioPumpPromise,
      this.renderLoopPromise,
    ]);

    if (this.videoEncoder && this.videoEncoder.state !== "closed") {
      await this.videoEncoder.flush();
    }

    if (
      this.videoEncoder &&
      this.videoEncoder.state !== "closed" &&
      this.canvas &&
      this.frameIndex > 0
    ) {
      const audioEndUs =
        this.audioSamplesWritten > 0
          ? Math.round((this.audioSamplesWritten * 1_000_000) / this.audioSampleRate)
          : 0;
      const holdStartUs = this.frameIndex * this.frameDurationUs;
      const cushionUs = 150_000;
      const targetEndUs = Math.max(
        holdStartUs + this.frameDurationUs,
        audioEndUs + cushionUs
      );
      const framesNeeded = Math.max(
        1,
        Math.ceil((targetEndUs - holdStartUs) / this.frameDurationUs)
      );

      for (let k = 0; k < framesNeeded; k += 1) {
        const tsUs = this.frameIndex * this.frameDurationUs;
        const hold = new VideoFrame(this.canvas, {
          timestamp: tsUs,
          duration: this.frameDurationUs,
        });
        this.videoEncoder.encode(hold, {
          timestamp: tsUs,
          keyFrame: false,
        });
        hold.close();
        this.frameIndex += 1;
      }

      await this.videoEncoder.flush();
    }

    if (this.audioEncoder && this.audioEncoder.state !== "closed") {
      await this.audioEncoder.flush();
    }

    try {
      await Promise.race([
        this.muxer.finalize(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("muxer-finalize-timeout")), 5000);
        }),
      ]);
    } catch (error) {
      await this.muxer.flushPending();
      throw error;
    } finally {
      this.cleanup();
    }

    const blob = new Blob(this.chunks, {
      type: "video/mp4",
    });

    postMessage({
      type: "stopped",
      blob,
      meta: {
        mimeType: "video/mp4",
        size: blob.size,
      },
    });
  }

  async primeVideoReader(reader, targetKey) {
    const { value: frame } = await reader.read();

    if (!frame) {
      throw new Error("Cannot read initial video frame");
    }

    const result = {
      width: frame.displayWidth || frame.codedWidth,
      height: frame.displayHeight || frame.codedHeight,
    };

    this.replaceFrame(targetKey, frame);

    return result;
  }

  fitResolution(sourceWidth, sourceHeight, maxWidth, maxHeight) {
    const widthRatio = maxWidth / sourceWidth;
    const heightRatio = maxHeight / sourceHeight;
    const scale = Math.min(widthRatio, heightRatio, 1);

    const width = Math.max(2, Math.round(sourceWidth * scale));
    const height = Math.max(2, Math.round(sourceHeight * scale));

    return {
      width: width % 2 === 0 ? width : width - 1,
      height: height % 2 === 0 ? height : height - 1,
    };
  }

  async chooseVideoEncoderConfig({ width, height, fps, bitrate }) {
    const base = {
      width,
      height,
      framerate: fps,
      bitrate,
      bitrateMode: "constant",
      latencyMode: "realtime",
    };

    const candidates = [
      { codec: "avc1.64002A", hw: "prefer-hardware" },
      { codec: "avc1.4D401F", hw: "prefer-hardware" },
      { codec: "avc1.42E01E", hw: "prefer-hardware" },
      { codec: "avc1.64002A", hw: "prefer-software" },
      { codec: "avc1.4D401F", hw: "prefer-software" },
      { codec: "avc1.42E01E", hw: "prefer-software" },
    ];

    for (const candidate of candidates) {
      const config = {
        ...base,
        codec: candidate.codec,
        hardwareAcceleration: candidate.hw,
      };

      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support?.supported) {
          return {
            config: support.config || config,
          };
        }
      } catch (error) {
        void error;
      }
    }

    throw new Error("No supported H.264 encoder found for worker recorder");
  }

  async initVideoEncoder(config) {
    this.videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        this.muxer.addVideoChunk(chunk, meta);
      },
      error: (error) => {
        throw error;
      },
    });

    this.videoEncoder.configure(config);
  }

  async prepareAudioEncoderConfig() {
    if (!this.audioReadable) return null;

    const sampleRate = this.audioConfig?.sampleRate || 48_000;
    const numberOfChannels = this.audioConfig?.channelCount || 2;

    const candidateConfig = {
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels,
      bitrate: this.options.audioBitrate,
    };

    const support = await AudioEncoder.isConfigSupported(candidateConfig);
    if (!support?.supported) {
      return null;
    }

    this.audioSampleRate = support.config?.sampleRate || candidateConfig.sampleRate;
    return support.config || candidateConfig;
  }

  async initAudioEncoder(config) {
    this.audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        this.muxer.addAudioChunk(chunk, meta);
      },
      error: (error) => {
        throw error;
      },
    });

    this.audioEncoder.configure(config);
  }

  async pumpVideoFrames(reader, kind) {
    while (this.running) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));

      if (done || !value) break;

      if (kind === "screen") {
        this.replaceFrame("latestScreenFrame", value);
      } else {
        this.replaceFrame("latestCameraFrame", value);
      }
    }
  }

  replaceFrame(key, frame) {
    const current = this[key];
    if (current) {
      current.close();
    }
    this[key] = frame;
  }

  async renderLoop() {
    while (this.running) {
      const nowUs = performance.now() * 1000;
      if (this.startedAtUs == null) {
        this.startedAtUs = nowUs;
      }

      const targetIndex = Math.max(
        0,
        Math.floor((nowUs - this.startedAtUs) / this.frameDurationUs)
      );

      if (targetIndex < this.frameIndex) {
        await this.delay(2);
        continue;
      }

      const gap = targetIndex - this.frameIndex;
      if (gap > 8) {
        this.frameIndex = targetIndex - 8;
      }

      const screenFrame = this.latestScreenFrame;
      if (!screenFrame) {
        await this.delay(4);
        continue;
      }

      const cameraFrame = this.latestCameraFrame;

      for (let index = this.frameIndex; index <= targetIndex; index += 1) {
        this.drawComposite(screenFrame, cameraFrame);

        const tsUs = index * this.frameDurationUs;
        const frame = new VideoFrame(this.canvas, {
          timestamp: tsUs,
          duration: this.frameDurationUs,
        });

        const keyFrame =
          index === 0 ||
          index - this.lastKeyFrameIndex >= this.keyFrameIntervalFrames;
        if (keyFrame) {
          this.lastKeyFrameIndex = index;
        }

        this.videoEncoder.encode(frame, {
          timestamp: tsUs,
          keyFrame,
        });
        frame.close();
        this.frameIndex = index + 1;
      }

      await this.delay(2);
    }
  }

  drawComposite(screenFrame, cameraFrame) {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.drawImage(screenFrame, 0, 0, width, height);

    if (!cameraFrame) {
      return;
    }

    const insetWidth = Math.round(width * 0.22);
    const insetHeight = Math.round(
      insetWidth * (cameraFrame.displayHeight || cameraFrame.codedHeight) /
      (cameraFrame.displayWidth || cameraFrame.codedWidth)
    );
    const padding = Math.round(width * 0.02);
    const x = width - insetWidth - padding;
    const y = height - insetHeight - padding;
    const radius = Math.round(insetWidth * 0.08);

    this.ctx.save();
    this.roundRect(x, y, insetWidth, insetHeight, radius);
    this.ctx.clip();
    this.ctx.drawImage(cameraFrame, x, y, insetWidth, insetHeight);
    this.ctx.restore();

    this.ctx.save();
    this.ctx.strokeStyle = "rgba(255,255,255,0.85)";
    this.ctx.lineWidth = Math.max(2, Math.round(width * 0.002));
    this.roundRect(x, y, insetWidth, insetHeight, radius);
    this.ctx.stroke();
    this.ctx.restore();
  }

  roundRect(x, y, width, height, radius) {
    this.ctx.beginPath();
    this.ctx.moveTo(x + radius, y);
    this.ctx.lineTo(x + width - radius, y);
    this.ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    this.ctx.lineTo(x + width, y + height - radius);
    this.ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    this.ctx.lineTo(x + radius, y + height);
    this.ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    this.ctx.lineTo(x, y + radius);
    this.ctx.quadraticCurveTo(x, y, x + radius, y);
    this.ctx.closePath();
  }

  async readAudioLoop() {
    while (this.running) {
      const { done, value } = await this.audioReader.read().catch(() => ({ done: true }));

      if (done || !value) break;

      const sampleRate = value.sampleRate || this.audioSampleRate || 48_000;
      const frames =
        typeof value.numberOfFrames === "number" ? value.numberOfFrames : 0;
      const tsUs = Math.round(
        (this.audioSamplesWritten * 1_000_000) / sampleRate
      );

      this.audioEncoder.encode(value, {
        timestamp: tsUs,
      });
      this.audioSamplesWritten += frames;
      value.close?.();
    }
  }

  cleanup() {
    for (const frame of [this.latestScreenFrame, this.latestCameraFrame]) {
      try {
        frame?.close();
      } catch (error) {
        void error;
      }
    }

    for (const reader of [this.screenReader, this.cameraReader, this.audioReader]) {
      try {
        reader?.releaseLock();
      } catch (error) {
        void error;
      }
    }

    for (const encoder of [this.videoEncoder, this.audioEncoder]) {
      try {
        encoder?.close();
      } catch (error) {
        void error;
      }
    }

  }

  delay(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

self.onmessage = async (event) => {
  const { type, payload } = event.data || {};

  try {
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
    postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
