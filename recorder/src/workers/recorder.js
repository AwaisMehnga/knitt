import { Mp4MuxerWrapper } from "../utils/Mp4MuxerWrapper.ts";
import { getEncodableAudioCodecs } from "mediabunny";

// Maps mediabunny codec name → WebCodecs AudioEncoder codec strings to probe.
// Ordered from highest to lowest quality within each family.
const MUXER_CODEC_TO_WEBCODECS = {
  aac: ["mp4a.40.2", "mp4a.40.5", "mp4a.40.29"],
  opus: ["opus"],
};

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
      pipPosition: options?.pipPosition || "bottom-right",
      pipSize: options?.pipSize || 10,
      pipOpacity: options?.pipOpacity || 100,
      pipBorderRadius: options?.pipBorderRadius || 8,
      pipShape: options?.pipShape || "rectangle",
      pipHidden: options?.pipHidden || false,
    };
    this.opfsWriteChain = Promise.resolve();
    this.opfsWriteFailed = false;

    this.running = false;
    this.startedAtUs = null;
    this.frameIndex = 0;
    this.frameDurationUs = Math.round(1_000_000 / this.options.fps);
    this.keyFrameIntervalFrames = Math.max(30, Math.round(this.options.fps * 2));
    this.lastKeyFrameIndex = 0;
    this.audioSamplesWritten = 0;
    this.audioSampleRate = 48_000;
    this.audioChunksEncoded = 0;

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
    this.enableAudio = false;
    this.selectedAudioMuxerCodec = null;

    // OPFS storage
    this.chunks = [];
    this.opfsFileHandle = null;
    this.opfsWritableStream = null;
    this.useOPFS = true;
    // IndexedDB storage (fallback when OPFS unavailable)
    this.idbDB = null;
    this.idbStoreName = `recorder_chunks_${Date.now()}`;
    this.idbWriteChain = Promise.resolve();
  }

  log(...args) {
    if (this.options.debug) {
      console.log("[WorkerRecorder]", ...args);
    }
  }

  warn(...args) {
    if (this.options.debug) {
      console.warn("[WorkerRecorder]", ...args);
    }
  }

  async initializeOPFS() {
    try {
      if (!navigator.storage?.getDirectory) {
        this.useOPFS = false;
        // Initialize IndexedDB fallback when OPFS not present
        await this.initializeIndexedDB();
        return;
      }

      const root = await navigator.storage.getDirectory();
      const fileName = `recording-${Date.now()}.mp4.tmp`;
      this.opfsFileHandle = await root.getFileHandle(fileName, { create: true });
      this.opfsWritableStream = await this.opfsFileHandle.createWritable();
    } catch (error) {
      void error;
      this.useOPFS = false;
      // Try to init IDB as fallback
      try {
        await this.initializeIndexedDB();
      } catch (e) {
        void e;
      }
    }
  }

  async writeChunkToOPFS(chunk) {
    if (!this.useOPFS || !this.opfsWritableStream) return;
    try {
      await this.opfsWritableStream.write(chunk);
    } catch (error) {
      void error;
      this.useOPFS = false;
      this.opfsWriteFailed = true;
      this.chunks.push(chunk);
    }
  }

  enqueueOPFSWrite(chunk) {
    if (this.useOPFS && this.opfsWritableStream) {
      // Serialize file writes off the hot path to reduce encode-loop stalls.
      this.opfsWriteChain = this.opfsWriteChain
        .catch(() => {})
        .then(async () => {
          await this.writeChunkToOPFS(chunk);
        });
      return;
    }

    // If OPFS is not available, try IndexedDB write chain; otherwise keep in-memory
    if (this.idbDB) {
      this.enqueueIDBWrite(chunk);
      return;
    }

    this.chunks.push(chunk);
  }

  async waitForOPFSWrites() {
    try {
      await this.opfsWriteChain;
      await this.idbWriteChain;
    } catch (error) {
      void error;
      this.opfsWriteFailed = true;
    }
  }

  async flushOPFSStream() {
    if (!this.useOPFS || !this.opfsWritableStream) return;
    try {
      await this.opfsWritableStream.flush?.();
    } catch (error) {
      void error;
    }
  }

  async readChunksFromOPFS() {
    if (this.useOPFS && this.opfsFileHandle) {
      try {
        // Flush and close the writable stream before reading
        if (this.opfsWritableStream) {
          try {
            await this.opfsWritableStream.flush?.();
            await this.opfsWritableStream.close();
            this.opfsWritableStream = null;
          } catch (error) {
            void error;
          }
        }

        // Now read the file
        const file = await this.opfsFileHandle.getFile();
        const arrayBuffer = await file.arrayBuffer();
        return arrayBuffer;
      } catch (error) {
        void error;
        return null;
      }
    }

    // If using IndexedDB fallback, read from IDB
    if (this.idbDB) {
      try {
        const arr = await this.readChunksFromIDB();
        if (!arr || arr.length === 0) return null;
        // Concatenate into single ArrayBuffer
        const total = arr.reduce((s, b) => s + b.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const buf of arr) {
          out.set(new Uint8Array(buf), offset);
          offset += buf.byteLength;
        }
        return out.buffer;
      } catch (error) {
        void error;
        return null;
      }
    }

    return null;
  }

  /* IndexedDB fallback helpers */
  async initializeIndexedDB() {
    if (!self.indexedDB) return;

    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(this.idbStoreName, 1);
        req.onupgradeneeded = (ev) => {
          const db = ev.target.result;
          if (!db.objectStoreNames.contains("chunks")) {
            db.createObjectStore("chunks", { autoIncrement: true });
          }
        };
        req.onsuccess = (ev) => {
          this.idbDB = ev.target.result;
          resolve();
        };
        req.onerror = (ev) => {
          reject(ev.target.error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  async writeChunkToIDB(chunk) {
    if (!this.idbDB) throw new Error("IDB not initialized");
    return new Promise((resolve, reject) => {
      try {
        const tx = this.idbDB.transaction(["chunks"], "readwrite");
        const store = tx.objectStore("chunks");
        const request = store.add(chunk);
        request.onsuccess = () => resolve();
        request.onerror = (ev) => reject(ev.target.error);
      } catch (error) {
        reject(error);
      }
    });
  }

  enqueueIDBWrite(chunk) {
    if (!this.idbDB) {
      this.chunks.push(chunk);
      return;
    }

    this.idbWriteChain = this.idbWriteChain
      .catch(() => {})
      .then(async () => {
        await this.writeChunkToIDB(chunk);
      });
  }

  async waitForIDBWrites() {
    try {
      await this.idbWriteChain;
    } catch (error) {
      void error;
    }
  }

  async readChunksFromIDB() {
    if (!this.idbDB) return [];
    return new Promise((resolve, reject) => {
      try {
        const tx = this.idbDB.transaction(["chunks"], "readonly");
        const store = tx.objectStore("chunks");
        const req = store.getAll();
        req.onsuccess = (ev) => {
          resolve(ev.target.result || []);
        };
        req.onerror = (ev) => reject(ev.target.error);
      } catch (error) {
        reject(error);
      }
    });
  }

  async cleanupIDB() {
    try {
      if (this.idbDB) {
        try {
          this.idbDB.close();
        } catch (error) {
          void error;
        }
        // Best-effort: delete DB entirely to free storage
        try {
          const name = this.idbDB.name;
          this.idbDB = null;
          const delReq = indexedDB.deleteDatabase(name);
          delReq.onsuccess = () => {};
          delReq.onerror = () => {};
        } catch (error) {
          void error;
        }
      }
    } catch (error) {
      void error;
    }
  }

  async cleanupOPFS() {
    try {
      if (this.opfsWritableStream) {
        try {
          await this.opfsWritableStream.close();
        } catch (error) {
          void error;
        }
        this.opfsWritableStream = null;
      }

      if (this.opfsFileHandle) {
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(this.opfsFileHandle.name);
        } catch (error) {
          void error;
        }
        this.opfsFileHandle = null;
      }
    } catch (error) {
      void error;
    }
  }

  async start() {
    if (!this.screenReadable) {
      throw new Error("No screen video readable received by worker");
    }

    this.running = true;

    // Initialize OPFS before starting encoding
    await this.initializeOPFS();

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

    let audioConfig = null;
    if (this.audioReadable) {
      audioConfig = await this.prepareAudioEncoderConfig();
      if (!audioConfig) {
        this.audioReadable = null;
      }
    }
    this.enableAudio = Boolean(this.audioReadable && audioConfig);

    this.muxer = new Mp4MuxerWrapper({
      width: target.width,
      height: target.height,
      fps: this.options.fps,
      videoBitrate: this.options.videoBitrate,
      audioBitrate: this.options.audioBitrate,
      videoCodec: "avc",
      audioCodec: this.enableAudio ? this.selectedAudioMuxerCodec : undefined,
      onChunk: async (chunk) => {
        this.enqueueOPFSWrite(chunk);
      },
      debug: this.options.debug,
    });

    if (this.enableAudio) {
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

    if (this.enableAudio) {
      await this.initAudioEncoder(audioConfig);
    }

    this.screenPumpPromise = this.pumpVideoFrames(this.screenReader, "screen");

    if (this.cameraReadable) {
      this.cameraReader = this.cameraReadable.getReader();
      await this.primeVideoReader(this.cameraReader, "latestCameraFrame");
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
        audioEnabled: Boolean(this.enableAudio && this.audioReader && this.audioEncoder),
      },
    });
  }

  async stop() {
    if (!this.running) return;

    this.running = false;

    try {
      const loopPromises = [
        this.screenPumpPromise,
        this.cameraPumpPromise,
        this.audioPumpPromise,
        this.renderLoopPromise,
      ].filter(Boolean);

      if (loopPromises.length) {
        await Promise.race([
          Promise.allSettled(loopPromises),
          this.delay(500),
        ]);
      }
    } catch (error) {
      void error;
    }

    try {
      if (this.videoEncoder && this.videoEncoder.state !== "closed") {
        await this.videoEncoder.flush();
      }
      if (this.audioEncoder && this.audioEncoder.state !== "closed") {
        await this.audioEncoder.flush();
      }
    } catch (error) {
      void error;
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

    // Read from OPFS BEFORE calling cleanup (which deletes the file)
    let blob;

    await this.waitForOPFSWrites();
    
    if (this.useOPFS) {
      const opfsData = await this.readChunksFromOPFS();
      if (opfsData && opfsData.byteLength > 0) {
        blob = new Blob([opfsData], { type: "video/mp4" });
      } else {
        // Fallback to RAM chunks if OPFS read failed or empty
        blob = new Blob(this.chunks, { type: "video/mp4" });
      }
    } else {
      blob = new Blob(this.chunks, { type: "video/mp4" });
    }

    // Now cleanup resources (including deleting OPFS file)
    this.cleanup();

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

    const detectedSampleRate = this.audioConfig?.sampleRate || 48_000;
    const detectedChannels = this.audioConfig?.channelCount || 2;
    const bitrate = this.options.audioBitrate;

    // Ask mediabunny which codecs this browser can actually encode,
    // probed with the real sample rate and channel count.
    let encodableCodecs;
    try {
      encodableCodecs = await getEncodableAudioCodecs(undefined, {
        sampleRate: detectedSampleRate,
        numberOfChannels: detectedChannels,
        bitrate,
      });
    } catch (error) {
      void error;
      encodableCodecs = [];
    }

    // Only keep codecs the muxer knows how to write.
    const supported = encodableCodecs.filter((c) => c in MUXER_CODEC_TO_WEBCODECS);

    const sampleRates = [...new Set([detectedSampleRate, 48_000, 44_100])];
    const channelCounts = detectedChannels > 1 ? [detectedChannels, 1] : [detectedChannels];

    for (const muxerCodec of supported) {
      for (const webCodec of MUXER_CODEC_TO_WEBCODECS[muxerCodec]) {
        for (const sampleRate of sampleRates) {
          for (const numberOfChannels of channelCounts) {
            const candidate = { codec: webCodec, sampleRate, numberOfChannels, bitrate };
            try {
              const support = await AudioEncoder.isConfigSupported(candidate);
              if (support?.supported) {
                this.selectedAudioMuxerCodec = muxerCodec;
                this.audioSampleRate = support.config?.sampleRate || sampleRate;
                return support.config || candidate;
              }
            } catch (error) {
              void error;
            }
          }
        }
      }
    }

    return null;
  }

  async initAudioEncoder(config) {
    this.audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        this.audioChunksEncoded += 1;
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

    // Skip drawing camera if PiP is hidden or no camera frame
    if (!cameraFrame || this.options.pipHidden) {
      return;
    }

    const shape = this.options.pipShape || "rectangle";
    const padding = Math.round(width * 0.02);
    const opacity = (this.options.pipOpacity || 100) / 100;
    
    const cameraWidth = cameraFrame.displayWidth || cameraFrame.codedWidth;
    const cameraHeight = cameraFrame.displayHeight || cameraFrame.codedHeight;
    
    let insetWidth = Math.round(width * (this.options.pipSize / 100));
    let insetHeight = insetWidth;
    let sourceCropX = 0, sourceCropY = 0, sourceCropWidth = cameraWidth, sourceCropHeight = cameraHeight;

    // Adjust dimensions and calculate crop based on shape
    if (shape === "square") {
      // Square: crop camera to square (center portion)
      const size = Math.min(insetWidth, insetHeight);
      insetWidth = size;
      insetHeight = size;
      
      // Crop camera frame to square
      const minDim = Math.min(cameraWidth, cameraHeight);
      sourceCropWidth = minDim;
      sourceCropHeight = minDim;
      sourceCropX = (cameraWidth - minDim) / 2;
      sourceCropY = (cameraHeight - minDim) / 2;
    } else if (shape === "circle") {
      // Circle: crop camera to square (center portion) - same as square for cropping
      const size = Math.min(insetWidth, insetHeight);
      insetWidth = size;
      insetHeight = size;
      
      // Crop camera frame to square
      const minDim = Math.min(cameraWidth, cameraHeight);
      sourceCropWidth = minDim;
      sourceCropHeight = minDim;
      sourceCropX = (cameraWidth - minDim) / 2;
      sourceCropY = (cameraHeight - minDim) / 2;
    } else {
      // Rectangle: maintain aspect ratio of camera feed
      insetHeight = Math.round(
        insetWidth * cameraHeight / cameraWidth
      );
    }
    
    // Calculate position based on pipPosition option
    let x, y;
    const pos = this.options.pipPosition || "bottom-right";
    const cornerCases = {
      "top-left": { x: padding, y: padding },
      "top-center": { x: (width - insetWidth) / 2, y: padding },
      "top-right": { x: width - insetWidth - padding, y: padding },
      "center-left": { x: padding, y: (height - insetHeight) / 2 },
      "center": { x: (width - insetWidth) / 2, y: (height - insetHeight) / 2 },
      "center-right": { x: width - insetWidth - padding, y: (height - insetHeight) / 2 },
      "bottom-left": { x: padding, y: height - insetHeight - padding },
      "bottom-center": { x: (width - insetWidth) / 2, y: height - insetHeight - padding },
      "bottom-right": { x: width - insetWidth - padding, y: height - insetHeight - padding },
    };
    
    const posData = cornerCases[pos] || cornerCases["bottom-right"];
    x = Math.round(posData.x);
    y = Math.round(posData.y);
    
    const radiusPercent = this.options.pipBorderRadius || 8;
    const radius = Math.round((insetWidth * radiusPercent) / 100);

    this.ctx.save();
    
    // Draw shape-specific clipping
    if (shape === "circle") {
      // Circular clip
      this.ctx.beginPath();
      this.ctx.arc(x + insetWidth / 2, y + insetHeight / 2, insetWidth / 2, 0, Math.PI * 2);
      this.ctx.clip();
    } else {
      // Rectangle or square with optional rounding
      this.roundRect(x, y, insetWidth, insetHeight, radius);
      this.ctx.clip();
    }
    
    this.ctx.globalAlpha = opacity;
    // Draw cropped camera frame
    this.ctx.drawImage(
      cameraFrame,
      sourceCropX, sourceCropY, sourceCropWidth, sourceCropHeight,
      x, y, insetWidth, insetHeight
    );
    this.ctx.restore();

    this.ctx.save();
    this.ctx.strokeStyle = `rgba(255,255,255,${0.85 * opacity})`;
    this.ctx.lineWidth = Math.max(2, Math.round(width * 0.002));
    
    if (shape === "circle") {
      // Draw circular border
      this.ctx.beginPath();
      this.ctx.arc(x + insetWidth / 2, y + insetHeight / 2, insetWidth / 2, 0, Math.PI * 2);
      this.ctx.stroke();
    } else {
      // Draw rounded rectangle border
      this.roundRect(x, y, insetWidth, insetHeight, radius);
      this.ctx.stroke();
    }
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
    let framesSeen = 0;

    if (!this.audioReader || !this.audioEncoder) return;
    while (this.running) {
      const { done, value } = await this.audioReader.read().catch(() => ({ done: true }));

      if (done || !value) break;

      const sampleRate = value.sampleRate || this.audioSampleRate || 48_000;
      const frames =
        typeof value.numberOfFrames === "number" ? value.numberOfFrames : 0;
      const tsUs = Math.round(
        (this.audioSamplesWritten * 1_000_000) / sampleRate
      );
      const durUs = Math.round((frames * 1_000_000) / sampleRate);

      try {
        this.audioEncoder.encode(value, {
          timestamp: tsUs,
        });
        this.audioSamplesWritten += frames;
        framesSeen += frames;
      } catch (error) {
        value.close?.();
        void error;
        break;
      }
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

    this.screenReader = null;
    this.cameraReader = null;
    this.audioReader = null;
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.muxer = null;
    this.enableAudio = false;
    this.selectedAudioMuxerCodec = null;
    state.controller = null;

    // Cleanup OPFS resources (async, so we don't await here)
    this.cleanupOPFS().catch((error) => {
      void error;
    });
    // Cleanup IndexedDB resources
    this.cleanupIDB().catch((error) => {
      void error;
    });
    this.opfsWriteChain = Promise.resolve();
    this.opfsWriteFailed = false;
    this.idbWriteChain = Promise.resolve();
  }

  delay(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

self.onmessage = async (event) => {
  const { type, payload, options } = event.data || {};

  try {
    if (type === "updateOptions") {
      if (state.controller) {
        Object.assign(state.controller.options, payload?.options || options || {});
      }
      return;
    }

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
