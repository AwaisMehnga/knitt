import { Mp4MuxerWrapper } from "../../utils/Mp4MuxerWrapper.ts";
import { chooseAudioEncoderConfig, chooseVideoEncoderConfig } from "./codecs";
import { createCompositeRenderer } from "./compositeRenderer";
import {
  closeFrame,
  delay,
  fitResolution,
  primeVideoReader,
  replaceFrame,
} from "./frameTools";
import { RecordingChunkSink } from "./storage";

const DEFAULT_OPTIONS = {
  fps: 30,
  width: 1920,
  height: 1080,
  videoBitrate: 8_000_000,
  audioBitrate: 128_000,
  debug: false,
  pipPosition: "bottom-right",
  pipSize: 10,
  pipOpacity: 100,
  pipBorderRadius: 8,
  pipShape: "rectangle",
  pipHidden: false,
};

const MAX_ENCODER_QUEUE_SIZE = 2;
const MAX_CATCH_UP_FRAMES = 2;

export class WorkerRecorder {
  constructor({ screenReadable, cameraReadable, audioReadable, audioConfig, options }) {
    this.screenReadable = screenReadable;
    this.cameraReadable = cameraReadable || null;
    this.audioReadable = audioReadable || null;
    this.audioConfig = audioConfig || null;
    this.options = { ...DEFAULT_OPTIONS, ...(options || {}) };

    this.running = false;
    this.stopped = false;
    this.pausedAtUs = null;
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

    this.renderer = null;
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.muxer = null;
    this.chunkSink = new RecordingChunkSink({ mimeType: "video/mp4" });
    this.enableAudio = false;
  }

  async start() {
    if (!this.screenReadable) {
      throw new Error("No screen video readable received by worker");
    }

    this.running = true;
    await this.chunkSink.initialize();

    this.screenReader = this.screenReadable.getReader();
    const probe = await primeVideoReader(this.screenReader, (frame) => {
      replaceFrame(this, "latestScreenFrame", frame);
    });
    let target = fitResolution(
      probe.width,
      probe.height,
      this.options.width,
      this.options.height
    );

    const videoConfig = await chooseVideoEncoderConfig({
      width: target.width,
      height: target.height,
      fps: this.options.fps,
      bitrate: this.options.videoBitrate,
      bitrateMode: this.options.bitrateMode,
    });
    target = {
      width: videoConfig.width || target.width,
      height: videoConfig.height || target.height,
    };

    this.renderer = createCompositeRenderer(target);

    const audioSelection = this.audioReadable
      ? await chooseAudioEncoderConfig({
          audioConfig: this.audioConfig,
          bitrate: this.options.audioBitrate,
        })
      : null;
    this.enableAudio = Boolean(this.audioReadable && audioSelection);
    if (audioSelection) this.audioSampleRate = audioSelection.sampleRate;

    this.muxer = new Mp4MuxerWrapper({
      width: target.width,
      height: target.height,
      fps: this.options.fps,
      videoBitrate: videoConfig.bitrate || this.options.videoBitrate,
      audioBitrate: this.options.audioBitrate,
      videoCodec: "avc",
      audioCodec: audioSelection?.muxerCodec,
      onChunk: (chunk) => this.chunkSink.write(chunk),
      debug: this.options.debug,
    });

    if (this.enableAudio) this.muxer.enableAudio();
    await this.muxer.start();

    await this.initVideoEncoder(videoConfig);

    if (this.enableAudio) {
      await this.initAudioEncoder(audioSelection.config);
    }

    this.screenPumpPromise = this.pumpVideoFrames(this.screenReader, "screen");

    if (this.cameraReadable) {
      this.cameraReader = this.cameraReadable.getReader();
      await primeVideoReader(this.cameraReader, (frame) => {
        replaceFrame(this, "latestCameraFrame", frame);
      });
      this.cameraPumpPromise = this.pumpVideoFrames(this.cameraReader, "camera");
    }

    if (this.enableAudio && this.audioEncoder) {
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
        audioEnabled: this.enableAudio,
        storage: this.chunkSink.mode,
      },
    });
  }

  updateOptions(options) {
    Object.assign(this.options, options || {});
  }

  pause() {
    if (this.running) {
      this.running = false;
      // Track pause time for timing adjustment on resume
      this.pausedAtUs = performance.now() * 1000;
    }
  }

  resume() {
    if (!this.running) {
      this.running = true;
      // Adjust start time by the pause duration to keep timing continuous
      if (this.pausedAtUs && this.startedAtUs !== null) {
        const pauseDurationUs = (performance.now() * 1000) - this.pausedAtUs;
        this.startedAtUs += pauseDurationUs;
      }
      this.pausedAtUs = null;
    }
  }

  async stop() {
    if (this.stopped) return;
    this.running = false;
    this.stopped = true;

    await this.waitForLoops();
    await this.flushEncoders();
    await this.padVideoToAudioEnd();
    await this.finalizeMuxer();

    const blob = await this.chunkSink.toBlob();
    await this.cleanup();

    postMessage({
      type: "stopped",
      blob,
      meta: {
        mimeType: "video/mp4",
        size: blob.size,
      },
    });
  }

  async waitForLoops() {
    const loops = [
      this.screenPumpPromise,
      this.cameraPumpPromise,
      this.audioPumpPromise,
      this.renderLoopPromise,
    ].filter(Boolean);

    if (!loops.length) return;

    await Promise.race([Promise.allSettled(loops), delay(500)]);
  }

  async flushEncoders() {
    if (this.videoEncoder && this.videoEncoder.state !== "closed") {
      await this.videoEncoder.flush();
    }

    if (this.audioEncoder && this.audioEncoder.state !== "closed") {
      await this.audioEncoder.flush();
    }
  }

  async padVideoToAudioEnd() {
    if (
      !this.videoEncoder ||
      this.videoEncoder.state === "closed" ||
      !this.renderer?.canvas ||
      this.frameIndex === 0
    ) {
      return;
    }

    const audioEndUs =
      this.audioSamplesWritten > 0
        ? Math.round((this.audioSamplesWritten * 1_000_000) / this.audioSampleRate)
        : 0;
    const holdStartUs = this.frameIndex * this.frameDurationUs;
    const targetEndUs = Math.max(
      holdStartUs + this.frameDurationUs,
      audioEndUs + 150_000
    );
    const framesNeeded = Math.max(
      1,
      Math.ceil((targetEndUs - holdStartUs) / this.frameDurationUs)
    );

    for (let index = 0; index < framesNeeded; index += 1) {
      const tsUs = this.frameIndex * this.frameDurationUs;
      const frame = new VideoFrame(this.renderer.canvas, {
        timestamp: tsUs,
        duration: this.frameDurationUs,
      });
      this.videoEncoder.encode(frame, { keyFrame: false });
      frame.close();
      this.frameIndex += 1;
    }

    await this.videoEncoder.flush();
  }

  async finalizeMuxer() {
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
    }
  }

  async initVideoEncoder(config) {
    this.videoEncoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (error) => {
        postMessage({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    this.videoEncoder.configure(config);
  }

  async initAudioEncoder(config) {
    this.audioEncoder = new AudioEncoder({
      output: (chunk, meta) => this.muxer.addAudioChunk(chunk, meta),
      error: (error) => {
        postMessage({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    this.audioEncoder.configure(config);
  }

  async pumpVideoFrames(reader, kind) {
    while (!this.stopped) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done || !value) break;

      replaceFrame(
        this,
        kind === "screen" ? "latestScreenFrame" : "latestCameraFrame",
        value
      );
    }
  }

  async renderLoop() {
    while (!this.stopped) {
      // Skip rendering while paused, but keep the loop running
      if (!this.running) {
        await delay(4);
        continue;
      }

      const nowUs = performance.now() * 1000;
      if (this.startedAtUs == null) this.startedAtUs = nowUs;

      const targetIndex = Math.max(
        0,
        Math.floor((nowUs - this.startedAtUs) / this.frameDurationUs)
      );

      if (targetIndex < this.frameIndex) {
        await delay(2);
        continue;
      }

      const gap = targetIndex - this.frameIndex;
      if (gap > MAX_CATCH_UP_FRAMES) {
        this.frameIndex = targetIndex - MAX_CATCH_UP_FRAMES;
      }

      if (!this.latestScreenFrame) {
        await delay(4);
        continue;
      }

      if (this.videoEncoder.encodeQueueSize > MAX_ENCODER_QUEUE_SIZE) {
        await delay(8);
        continue;
      }

      for (let index = this.frameIndex; index <= targetIndex; index += 1) {
        if (this.videoEncoder.encodeQueueSize > MAX_ENCODER_QUEUE_SIZE) {
          break;
        }

        this.renderer.draw(
          this.latestScreenFrame,
          this.latestCameraFrame,
          this.options
        );

        const tsUs = index * this.frameDurationUs;
        const frame = new VideoFrame(this.renderer.canvas, {
          timestamp: tsUs,
          duration: this.frameDurationUs,
        });
        const keyFrame =
          index === 0 ||
          index - this.lastKeyFrameIndex >= this.keyFrameIntervalFrames;

        if (keyFrame) this.lastKeyFrameIndex = index;
        this.videoEncoder.encode(frame, { keyFrame });
        frame.close();
        this.frameIndex = index + 1;
      }

      await delay(2);
    }
  }

  async readAudioLoop() {
    if (!this.audioReader || !this.audioEncoder) return;

    while (!this.stopped) {
      const { done, value } = await this.audioReader
        .read()
        .catch(() => ({ done: true }));
      if (done || !value) break;

      // Skip encoding audio while paused, but keep reading
      if (!this.running) {
        closeFrame(value);
        await delay(4);
        continue;
      }

      const frames =
        typeof value.numberOfFrames === "number" ? value.numberOfFrames : 0;
      try {
        this.audioEncoder.encode(value);
        this.audioSamplesWritten += frames;
      } catch {
        closeFrame(value);
        break;
      }

      closeFrame(value);
    }
  }

  async cleanup() {
    closeFrame(this.latestScreenFrame);
    closeFrame(this.latestCameraFrame);

    for (const reader of [this.screenReader, this.cameraReader, this.audioReader]) {
      try {
        reader?.releaseLock?.();
      } catch (error) {
        void error;
      }
    }

    for (const encoder of [this.videoEncoder, this.audioEncoder]) {
      try {
        if (encoder?.state !== "closed") encoder?.close?.();
      } catch (error) {
        void error;
      }
    }

    this.renderer?.destroy?.();
    await this.chunkSink.cleanup();

    this.screenReader = null;
    this.cameraReader = null;
    this.audioReader = null;
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.muxer = null;
    this.renderer = null;
    this.latestScreenFrame = null;
    this.latestCameraFrame = null;
  }
}
