const concatBuffers = (buffers) => {
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const buffer of buffers) {
    output.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }

  return output.buffer;
};

class IndexedDbChunkSink {
  constructor() {
    this.db = null;
    this.name = `recorder_chunks_${Date.now()}`;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    if (!self.indexedDB) return false;

    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("chunks")) {
          db.createObjectStore("chunks", { autoIncrement: true });
        }
      };
      request.onsuccess = (event) => resolve(event.target.result);
      request.onerror = (event) => reject(event.target.error);
    });

    return true;
  }

  write(chunk) {
    if (!this.db) return;
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(
        () =>
          new Promise((resolve, reject) => {
            const tx = this.db.transaction(["chunks"], "readwrite");
            const request = tx.objectStore("chunks").add(chunk);
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(event.target.error);
          })
      );
  }

  async read() {
    if (!this.db) return null;
    await this.writeChain;
    const buffers = await new Promise((resolve, reject) => {
      const tx = this.db.transaction(["chunks"], "readonly");
      const request = tx.objectStore("chunks").getAll();
      request.onsuccess = (event) => resolve(event.target.result || []);
      request.onerror = (event) => reject(event.target.error);
    });
    return concatBuffers(buffers);
  }

  cleanup() {
    if (!this.db) return;
    try {
      const { name } = this.db;
      this.db.close();
      this.db = null;
      indexedDB.deleteDatabase(name);
    } catch (error) {
      void error;
    }
  }
}

export class RecordingChunkSink {
  constructor({ mimeType = "video/mp4" } = {}) {
    this.mimeType = mimeType;
    this.memoryChunks = [];
    this.opfsFileHandle = null;
    this.opfsWritableStream = null;
    this.opfsWriteChain = Promise.resolve();
    this.idb = new IndexedDbChunkSink();
    this.mode = "memory";
  }

  async initialize() {
    if (navigator.storage?.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        this.opfsFileHandle = await root.getFileHandle(
          `recording-${Date.now()}.mp4.tmp`,
          { create: true }
        );
        this.opfsWritableStream = await this.opfsFileHandle.createWritable();
        this.mode = "opfs";
        return;
      } catch {
        this.opfsFileHandle = null;
        this.opfsWritableStream = null;
      }
    }

    try {
      if (await this.idb.initialize()) {
        this.mode = "idb";
      }
    } catch {
      this.mode = "memory";
    }
  }

  write(chunk) {
    if (this.mode === "opfs" && this.opfsWritableStream) {
      this.opfsWriteChain = this.opfsWriteChain
        .catch(() => {})
        .then(async () => {
          try {
            await this.opfsWritableStream.write(chunk);
          } catch {
            this.mode = "memory";
            this.memoryChunks.push(chunk);
          }
        });
      return;
    }

    if (this.mode === "idb") {
      this.idb.write(chunk);
      return;
    }

    this.memoryChunks.push(chunk);
  }

  async toBlob() {
    await this.opfsWriteChain;

    if (this.mode === "opfs" && this.opfsFileHandle) {
      if (this.opfsWritableStream) {
        await this.opfsWritableStream.flush?.();
        await this.opfsWritableStream.close();
        this.opfsWritableStream = null;
      }
      const file = await this.opfsFileHandle.getFile();
      return new Blob([await file.arrayBuffer()], { type: this.mimeType });
    }

    if (this.mode === "idb") {
      const buffer = await this.idb.read();
      if (buffer?.byteLength) {
        return new Blob([buffer], { type: this.mimeType });
      }
    }

    return new Blob(this.memoryChunks, { type: this.mimeType });
  }

  async cleanup() {
    try {
      if (this.opfsWritableStream) {
        await this.opfsWritableStream.close();
        this.opfsWritableStream = null;
      }

      if (this.opfsFileHandle) {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(this.opfsFileHandle.name);
        this.opfsFileHandle = null;
      }
    } catch (error) {
      void error;
    }

    this.idb.cleanup();
    this.memoryChunks.length = 0;
    this.opfsWriteChain = Promise.resolve();
  }
}
