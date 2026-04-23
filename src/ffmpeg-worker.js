import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

const ffmpeg = new FFmpeg()

let loadPromise

async function ensureLoaded() {
  if (!loadPromise) {
    loadPromise = ffmpeg.load({
      coreURL: await toBlobURL(
        'https://unpkg.com/@ffmpeg/core@0.12.15/dist/esm/ffmpeg-core.js',
        'text/javascript',
      ),
      wasmURL: await toBlobURL(
        'https://unpkg.com/@ffmpeg/core@0.12.15/dist/esm/ffmpeg-core.wasm',
        'application/wasm',
      ),
    })
  }

  return loadPromise
}

self.onmessage = async ({ data }) => {
  const { blob, jobId } = data

  try {
    await ensureLoaded()
    await ffmpeg.writeFile('input.webm', await fetchFile(blob))

    // Try container remux first for fast conversion.
    try {
      await ffmpeg.exec([
        '-i',
        'input.webm',
        '-map',
        '0',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        'output.mp4',
      ])
    } catch {
      await ffmpeg.exec([
        '-i',
        'input.webm',
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'mpeg4',
        '-q:v',
        '2',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        'output.mp4',
      ])
    }

    const output = await ffmpeg.readFile('output.mp4')
    self.postMessage({
      type: 'done',
      jobId,
      blob: new Blob([output], { type: 'video/mp4' }),
    })
  } catch (error) {
    self.postMessage({
      type: 'error',
      jobId,
      message: error instanceof Error ? error.message : 'conversion failed',
    })
  } finally {
    try {
      await ffmpeg.deleteFile('input.webm')
    } catch (error) {
      void error
    }

    try {
      await ffmpeg.deleteFile('output.mp4')
    } catch (error) {
      void error
    }
  }
}
