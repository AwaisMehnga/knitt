export const openChunkDatabase = (name) =>
  new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("chunks")) {
          db.createObjectStore("chunks", { autoIncrement: true });
        }
      };
      request.onsuccess = (event) => resolve(event.target.result);
      request.onerror = (event) => reject(event.target.error);
    } catch (error) {
      reject(error);
    }
  });

export const addChunk = (db, chunk) =>
  new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(["chunks"], "readwrite");
      const request = tx.objectStore("chunks").add(chunk);
      request.onsuccess = () => resolve();
      request.onerror = (event) => reject(event.target.error);
    } catch (error) {
      reject(error);
    }
  });

export const readChunks = (db) =>
  new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(["chunks"], "readonly");
      const request = tx.objectStore("chunks").getAll();
      request.onsuccess = (event) => resolve(event.target.result || []);
      request.onerror = (event) => reject(event.target.error);
    } catch (error) {
      reject(error);
    }
  });

export const closeAndDeleteDatabase = (db) => {
  try {
    const { name } = db;
    db.close();
    indexedDB.deleteDatabase(name);
  } catch (error) {
    void error;
  }
};

export const concatArrayBuffers = (buffers) => {
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const buffer of buffers) {
    output.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }

  return output.buffer;
};
