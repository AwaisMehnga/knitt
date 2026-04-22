import { useEffect, useRef, useState } from 'react'
import './App.css'

const RECORDING_OPTIONS = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

const PERFORMANCE_PROFILES = {
  high: {
    frameRate: 60,
    maxPixels: 3_840 * 2_160,
    minVideoBitsPerSecond: 18_000_000,
    maxVideoBitsPerSecond: 40_000_000,
    audioBitsPerSecond: 256_000,
  },
  balanced: {
    frameRate: 60,
    maxPixels: 2_560 * 1_440,
    minVideoBitsPerSecond: 10_000_000,
    maxVideoBitsPerSecond: 24_000_000,
    audioBitsPerSecond: 192_000,
  },
  efficient: {
    frameRate: 30,
    maxPixels: 1_920 * 1_080,
    minVideoBitsPerSecond: 6_000_000,
    maxVideoBitsPerSecond: 14_000_000,
    audioBitsPerSecond: 128_000,
  },
}

function pickRecorderMimeType() {
  return (
    RECORDING_OPTIONS.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ||
    ''
  )
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function getPerformanceProfile() {
  const cpuCores = navigator.hardwareConcurrency ?? 4
  const deviceMemory = navigator.deviceMemory ?? 4

  if (cpuCores >= 8 && deviceMemory >= 8) {
    return PERFORMANCE_PROFILES.high
  }

  if (cpuCores >= 4 && deviceMemory >= 4) {
    return PERFORMANCE_PROFILES.balanced
  }

  return PERFORMANCE_PROFILES.efficient
}

function fitWithinPixelBudget(width, height, maxPixels) {
  const safeWidth = width || 1_920
  const safeHeight = height || 1_080
  const totalPixels = safeWidth * safeHeight

  if (totalPixels <= maxPixels) {
    return { width: safeWidth, height: safeHeight }
  }

  const scale = Math.sqrt(maxPixels / totalPixels)

  return {
    width: Math.max(1_280, Math.floor(safeWidth * scale)),
    height: Math.max(720, Math.floor(safeHeight * scale)),
  }
}

function buildScreenConstraints() {
  const profile = getPerformanceProfile()
  const { width, height } = fitWithinPixelBudget(
    window.screen.width,
    window.screen.height,
    profile.maxPixels,
  )

  return {
    audio: {
      autoGainControl: false,
      channelCount: { ideal: 2 },
      echoCancellation: false,
      noiseSuppression: false,
      sampleRate: { ideal: 48_000 },
    },
    preferCurrentTab: true,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
    video: {
      frameRate: { ideal: profile.frameRate, max: profile.frameRate },
      height: { ideal: height, max: height },
      width: { ideal: width, max: width },
    },
  }
}

function buildFallbackScreenConstraints() {
  const profile = getPerformanceProfile()
  const { width, height } = fitWithinPixelBudget(
    window.screen.width,
    window.screen.height,
    profile.maxPixels,
  )

  return [
    {
      audio: true,
      video: {
        frameRate: { ideal: profile.frameRate, max: profile.frameRate },
        height: { ideal: height, max: height },
        width: { ideal: width, max: width },
      },
    },
    {
      audio: true,
      video: true,
    },
    {
      video: true,
    },
  ]
}

function shouldRetryDisplayCapture(error) {
  return (
    error instanceof TypeError ||
    error?.name === 'OverconstrainedError' ||
    error?.name === 'ConstraintNotSatisfiedError'
  )
}

async function requestDisplayStream() {
  const attempts = [buildScreenConstraints(), ...buildFallbackScreenConstraints()]
  let lastError = null

  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getDisplayMedia(constraints)
    } catch (error) {
      lastError = error

      if (!shouldRetryDisplayCapture(error)) {
        throw error
      }
    }
  }

  throw lastError ?? new Error('Unable to start screen capture.')
}

async function optimizeVideoTrack(track) {
  if (!track?.applyConstraints) {
    return
  }

  const profile = getPerformanceProfile()
  const capabilities = track.getCapabilities?.()

  if (!capabilities) {
    return
  }

  const { width, height } = fitWithinPixelBudget(
    Math.min(window.screen.width, capabilities.width?.max ?? window.screen.width),
    Math.min(window.screen.height, capabilities.height?.max ?? window.screen.height),
    profile.maxPixels,
  )

  const nextConstraints = {}

  if (capabilities.frameRate?.max) {
    const frameRate = Math.min(profile.frameRate, capabilities.frameRate.max)
    nextConstraints.frameRate = { ideal: frameRate, max: frameRate }
  }

  if (capabilities.width?.max && capabilities.height?.max) {
    nextConstraints.width = { ideal: width, max: width }
    nextConstraints.height = { ideal: height, max: height }
  }

  if (Object.keys(nextConstraints).length === 0) {
    return
  }

  try {
    await track.applyConstraints(nextConstraints)
  } catch {
    // Some browsers expose capabilities but reject display-track constraint updates.
  }
}

function getCodecEfficiency(mimeType) {
  if (mimeType.includes('vp9')) {
    return 0.09
  }

  if (mimeType.includes('vp8')) {
    return 0.11
  }

  if (mimeType.includes('mp4')) {
    return 0.12
  }

  return 0.11
}

function createRecorderOptions(stream, mimeType) {
  const profile = getPerformanceProfile()
  const videoTrack = stream.getVideoTracks()[0]
  const audioTrack = stream.getAudioTracks()[0]
  const settings = videoTrack?.getSettings?.() ?? {}
  const width = settings.width ?? window.screen.width ?? 1_920
  const height = settings.height ?? window.screen.height ?? 1_080
  const frameRate = settings.frameRate ?? profile.frameRate
  const estimatedVideoBitsPerSecond = Math.round(
    width * height * frameRate * getCodecEfficiency(mimeType),
  )

  return {
    ...(mimeType ? { mimeType } : {}),
    ...(audioTrack ? { audioBitsPerSecond: profile.audioBitsPerSecond } : {}),
    videoBitsPerSecond: clamp(
      estimatedVideoBitsPerSecond,
      profile.minVideoBitsPerSecond,
      profile.maxVideoBitsPerSecond,
    ),
  }
}

function needsMp4Conversion(mimeType) {
  return !mimeType.startsWith('video/mp4')
}

function getDownloadName(mimeType) {
  return mimeType.startsWith('video/mp4')
    ? 'screen-recording.mp4'
    : 'screen-recording.webm'
}

function App() {
  const [phase, setPhase] = useState('idle')
  const [previewUrl, setPreviewUrl] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [downloadName, setDownloadName] = useState('screen-recording.mp4')
  const [errorMessage, setErrorMessage] = useState('')
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const recorderRef = useRef(null)
  const workerRef = useRef(null)
  const chunksRef = useRef([])
  const pendingJobRef = useRef(0)
  const previewUrlRef = useRef('')
  const downloadUrlRef = useRef('')

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate()
        workerRef.current = null
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }

      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
      }

      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current

    if (!video) {
      return
    }

    if (phase === 'recording' && streamRef.current) {
      video.srcObject = streamRef.current
      video.controls = false
      video.muted = true
      video.play().catch(() => {})
      return
    }

    video.srcObject = null
    video.muted = false
    video.controls = false

    if (previewUrl) {
      video.src = previewUrl
      video.play().catch(() => {})
    } else {
      video.removeAttribute('src')
      video.load()
    }
  }, [phase, previewUrl])

  const setPreviewObjectUrl = (url) => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
    }

    previewUrlRef.current = url
    setPreviewUrl(url)
  }

  const setDownloadObjectUrl = (url, name) => {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current)
    }

    downloadUrlRef.current = url
    setDownloadUrl(url)
    setDownloadName(name)
  }

  const resetOutputs = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = ''
    }

    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current)
      downloadUrlRef.current = ''
    }

    setPreviewUrl('')
    setDownloadUrl('')
    setDownloadName('screen-recording.mp4')
    setErrorMessage('')
  }

  const setOutputUrlsFromBlob = (blob, fileName) => {
    setPreviewObjectUrl(URL.createObjectURL(blob))
    setDownloadObjectUrl(URL.createObjectURL(blob), fileName)
  }

  const stopCaptureStream = () => {
    if (!streamRef.current) {
      return
    }

    streamRef.current.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  const ensureWorker = () => {
    if (workerRef.current) {
      return workerRef.current
    }

    const worker = new Worker(new URL('./ffmpeg-worker.js', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = ({ data }) => {
      if (data.jobId !== pendingJobRef.current) {
        return
      }

      if (data.type === 'error') {
        setPhase(downloadUrlRef.current ? 'ready' : 'error')
        return
      }

      if (data.type !== 'done') {
        return
      }

      setOutputUrlsFromBlob(data.blob, 'screen-recording.mp4')
      setPhase('ready')
    }

    worker.onerror = () => {
      setPhase(downloadUrlRef.current ? 'ready' : 'error')
    }

    workerRef.current = worker
    return worker
  }

  const startRecording = async () => {
    if (phase === 'recording' || phase === 'converting') {
      return
    }

    resetOutputs()

    try {
      const stream = await requestDisplayStream()
      const mimeType = pickRecorderMimeType()

      await optimizeVideoTrack(stream.getVideoTracks()[0])

      const recorder = new MediaRecorder(stream, createRecorderOptions(stream, mimeType))
      const primaryVideoTrack = stream.getVideoTracks()[0]

      streamRef.current = stream
      recorderRef.current = recorder
      chunksRef.current = []

      if (primaryVideoTrack) {
        primaryVideoTrack.addEventListener(
          'ended',
          () => {
            if (recorder.state !== 'inactive') {
              recorder.stop()
            }
          },
          { once: true },
        )
      }

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        recorderRef.current = null

        const recordedBlob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'video/webm',
        })
        const recordedMimeType = recorder.mimeType || mimeType || 'video/webm'
        const rawDownloadName = getDownloadName(recordedMimeType)

        chunksRef.current = []
        setOutputUrlsFromBlob(recordedBlob, rawDownloadName)

        if (!needsMp4Conversion(recordedMimeType)) {
          setPhase('ready')
          return
        }

        setPhase('converting')

        const jobId = Date.now()
        pendingJobRef.current = jobId
        ensureWorker().postMessage({ jobId, blob: recordedBlob })
      }

      recorder.start()
      setPhase('recording')
    } catch (error) {
      stopCaptureStream()
      recorderRef.current = null
      setPhase('error')

      if (error?.name === 'NotAllowedError') {
        setErrorMessage('Screen sharing permission was blocked or cancelled.')
        return
      }

      if (error?.name === 'NotFoundError') {
        setErrorMessage('No screen source was available to capture.')
        return
      }

      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Unable to start screen recording on this browser/device.',
      )
    }
  }

  const stopRecording = () => {
    if (!recorderRef.current || recorderRef.current.state === 'inactive') {
      return
    }

    recorderRef.current.stop()
    recorderRef.current = null
    stopCaptureStream()
  }

  return (
    <main className="app-shell">
      <section className="stage" aria-label="Screen recording preview">
        <video ref={videoRef} className="preview" playsInline controls={false} />
      </section>

      <div className="controls">
        <button
          type="button"
          className="control-button"
          onClick={startRecording}
          disabled={phase === 'recording' || phase === 'converting'}
        >
          Start
        </button>
        <button
          type="button"
          className="control-button"
          onClick={stopRecording}
          disabled={phase !== 'recording'}
        >
          Stop
        </button>
        {phase !== 'idle' ? (
          <a
            className="control-button download"
            href={downloadUrl || undefined}
            download={downloadName}
            aria-disabled={!downloadUrl}
            onClick={(event) => {
              if (!downloadUrl) {
                event.preventDefault()
              }
            }}
          >
            {phase === 'converting' && downloadName.endsWith('.webm')
              ? 'Download WebM'
              : phase === 'converting'
                ? 'Processing...'
              : phase === 'error' && !downloadUrl
                ? 'Processing failed'
                : downloadName.endsWith('.webm')
                  ? 'Download WebM'
                  : 'Download MP4'}
          </a>
        ) : null}
      </div>
      {errorMessage ? (
        <p className="status-message" role="status">
          {errorMessage}
        </p>
      ) : null}
    </main>
  )
}

export default App
