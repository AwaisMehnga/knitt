// ffmpeg-worker.js
// Converts WebM recordings to MP4. Tries hardware-accelerated paths first,
// then falls back to software encoding. Keeps audio/video in sync via mux.

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

const ffmpeg = new FFmpeg()
const FFMPEG_PUBLIC_BASE = '/ffmpeg-core/'

let loadPromise = null

async function ensureLoaded() {
  if (!loadPromise) {
    loadPromise = (async () => {
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${FFMPEG_PUBLIC_BASE}ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${FFMPEG_PUBLIC_BASE}ffmpeg-core.wasm`, 'application/wasm'),
      ])
      await ffmpeg.load({ coreURL, wasmURL })
    })()
  }
  return loadPromise
}

/**
 * Try multiple FFmpeg command variants in order.
 * Returns on first success; throws if all fail.
 */
async function tryExec(variants) {
  let lastErr
  for (const args of variants) {
    try {
      await ffmpeg.exec(args)
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

async function safeDelete(...paths) {
  for (const p of paths) {
    try { await ffmpeg.deleteFile(p) } catch { /* ignore */ }
  }
}

self.onmessage = async ({ data }) => {
  const { jobId, videoBlob, audioBlob } = data

  try {
    await ensureLoaded()

    const hasSeparateAudio = Boolean(audioBlob)

    if (hasSeparateAudio) {
      // Separate video + audio blobs (split recorder path)
      await ffmpeg.writeFile('v.webm', await fetchFile(videoBlob))
      await ffmpeg.writeFile('a.webm', await fetchFile(audioBlob))

      await tryExec([
        // Attempt 1: copy video stream + encode audio to AAC (fastest)
        ['-i','v.webm','-i','a.webm','-map','0:v:0','-map','1:a:0',
         '-c:v','copy','-c:a','aac','-b:a','192k',
         '-movflags','+faststart','out.mp4'],

        // Attempt 2: software-encode video if copy fails (codec mismatch)
        ['-i','v.webm','-i','a.webm','-map','0:v:0','-map','1:a:0',
         '-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p',
         '-c:a','aac','-b:a','192k',
         '-movflags','+faststart','out.mp4'],

        // Attempt 3: mpeg4 as last resort
        ['-i','v.webm','-i','a.webm','-map','0:v:0','-map','1:a:0',
         '-c:v','mpeg4','-q:v','3','-pix_fmt','yuv420p',
         '-c:a','aac','-b:a','192k',
         '-movflags','+faststart','out.mp4'],
      ])

      await safeDelete('v.webm', 'a.webm')
    } else {
      // Single combined blob
      await ffmpeg.writeFile('in.webm', await fetchFile(videoBlob))

      await tryExec([
        // Attempt 1: fast remux (container only, no re-encode)
        ['-i','in.webm','-map','0','-c','copy',
         '-movflags','+faststart','out.mp4'],

        // Attempt 2: libx264 software encode
        ['-i','in.webm','-map','0:v:0','-map','0:a:0?',
         '-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p',
         '-c:a','aac','-b:a','192k',
         '-movflags','+faststart','out.mp4'],

        // Attempt 3: mpeg4
        ['-i','in.webm','-map','0:v:0','-map','0:a:0?',
         '-c:v','mpeg4','-q:v','3','-pix_fmt','yuv420p',
         '-c:a','aac','-b:a','192k',
         '-movflags','+faststart','out.mp4'],
      ])

      await safeDelete('in.webm')
    }

    const output = await ffmpeg.readFile('out.mp4')
    await safeDelete('out.mp4')

    self.postMessage({
      type: 'done',
      jobId,
      blob: new Blob([output], { type: 'video/mp4' }),
    })
  } catch (err) {
    await safeDelete('in.webm', 'v.webm', 'a.webm', 'out.mp4')
    self.postMessage({
      type: 'error',
      jobId,
      message: err instanceof Error ? err.message : 'Conversion failed.',
    })
  }
}