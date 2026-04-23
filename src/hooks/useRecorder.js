import { useEffect, useRef, useState } from 'react'

const RECORDING_OPTIONS = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

const DEFAULT_CAPTURE_OPTIONS = {
  source: 'entire-screen',
  includeCamera: true,
  includeMicrophone: true,
  includeSystemAudio: true,
}

function pickRecorderMimeType() {
  return (
    RECORDING_OPTIONS.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ||
    ''
  )
}

function needsMp4Conversion(mimeType) {
  return !mimeType.startsWith('video/mp4')
}

function buildDisplayConstraints(includeSystemAudio) {
  return {
    audio: includeSystemAudio,
    surfaceSwitching: 'include',
    systemAudio: includeSystemAudio ? 'include' : 'exclude',
    video: {
      displaySurface: 'monitor',
      frameRate: { ideal: 60, max: 60 },
      height: { ideal: window.screen.height, max: window.screen.height },
      width: { ideal: window.screen.width, max: window.screen.width },
    },
  }
}

function supportsWorkerComposition() {
  return (
    typeof window.MediaStreamTrackProcessor !== 'undefined' &&
    typeof window.MediaStreamTrackGenerator !== 'undefined' &&
    typeof window.VideoFrame !== 'undefined' &&
    typeof window.OffscreenCanvas !== 'undefined'
  )
}

export function useRecorder() {
  const [phase, setPhase] = useState('idle')
  const [previewUrl, setPreviewUrl] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [captureOptions, setCaptureOptions] = useState(DEFAULT_CAPTURE_OPTIONS)

  const videoRef = useRef(null)
  const recorderRef = useRef(null)
  const workerRef = useRef(null)
  const compositorWorkerRef = useRef(null)
  const chunksRef = useRef([])
  const pendingJobRef = useRef(0)

  const activePreviewStreamRef = useRef(null)
  const sourceStreamsRef = useRef([])
  const previewUrlRef = useRef('')
  const downloadUrlRef = useRef('')
  const renderLoopRef = useRef(0)
  const compositorIdRef = useRef(0)
  const compositorTrackRef = useRef(null)
  const compositorElementsRef = useRef(null)
  const audioContextRef = useRef(null)

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate()
        workerRef.current = null
      }

      if (compositorWorkerRef.current) {
        compositorWorkerRef.current.terminate()
        compositorWorkerRef.current = null
      }

      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
      }

      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current)
      }

      if (activePreviewStreamRef.current) {
        activePreviewStreamRef.current.getTracks().forEach((track) => track.stop())
      }

      sourceStreamsRef.current.forEach((stream) => {
        stream.getTracks().forEach((track) => track.stop())
      })

      sourceStreamsRef.current = []

      if (renderLoopRef.current) {
        cancelAnimationFrame(renderLoopRef.current)
        renderLoopRef.current = 0
      }

      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {})
        audioContextRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current

    if (!video) {
      return
    }

    if (phase === 'recording' && activePreviewStreamRef.current) {
      video.srcObject = activePreviewStreamRef.current
      video.controls = false
      video.muted = true
      video.play().catch(() => {})
      return
    }

    video.srcObject = null
    video.controls = false
    video.muted = false

    if (previewUrl) {
      video.src = previewUrl
      video.play().catch(() => {})
      return
    }

    video.removeAttribute('src')
    video.load()
  }, [phase, previewUrl])

  const setPreviewObjectUrl = (url) => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
    }

    previewUrlRef.current = url
    setPreviewUrl(url)
  }

  const setDownloadObjectUrl = (url) => {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current)
    }

    downloadUrlRef.current = url
    setDownloadUrl(url)
  }

  const resetOutputUrls = () => {
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
  }

  const cleanupCompositionResources = () => {
    if (compositorIdRef.current && compositorWorkerRef.current) {
      compositorWorkerRef.current.postMessage({
        type: 'stop',
        compositionId: compositorIdRef.current,
      })
      compositorIdRef.current = 0
    }

    if (compositorTrackRef.current) {
      compositorTrackRef.current.stop()
      compositorTrackRef.current = null
    }

    if (renderLoopRef.current) {
      cancelAnimationFrame(renderLoopRef.current)
      renderLoopRef.current = 0
    }

    if (compositorElementsRef.current) {
      const { screenVideo, cameraVideo } = compositorElementsRef.current
      screenVideo?.pause()
      cameraVideo?.pause()
      screenVideo?.removeAttribute('src')
      cameraVideo?.removeAttribute('src')
      compositorElementsRef.current = null
    }
  }

  const cleanupCapturePipeline = () => {
    cleanupCompositionResources()

    if (activePreviewStreamRef.current) {
      activePreviewStreamRef.current.getTracks().forEach((track) => track.stop())
      activePreviewStreamRef.current = null
    }

    sourceStreamsRef.current.forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop())
    })

    sourceStreamsRef.current = []

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
  }

  const ensureWorker = () => {
    if (workerRef.current) {
      return workerRef.current
    }

    const worker = new Worker(new URL('../ffmpeg-worker.js', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = ({ data }) => {
      if (data.jobId !== pendingJobRef.current) {
        return
      }

      if (data.type === 'error') {
        setPhase('error')
        setErrorMessage('MP4 conversion failed. Please record again.')
        return
      }

      if (data.type !== 'done') {
        return
      }

      const nextUrl = URL.createObjectURL(data.blob)
      setDownloadObjectUrl(nextUrl)
      setPreviewObjectUrl(nextUrl)
      setPhase('ready')
      setErrorMessage('')
    }

    worker.onerror = () => {
      setPhase('error')
      setErrorMessage('MP4 conversion failed. Please record again.')
    }

    workerRef.current = worker
    return worker
  }

  const ensureCompositorWorker = () => {
    if (compositorWorkerRef.current) {
      return compositorWorkerRef.current
    }

    const worker = new Worker(new URL('../compositor-worker.js', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = ({ data }) => {
      if (data?.type === 'error' && data.compositionId === compositorIdRef.current) {
        setErrorMessage('Camera composition fell back to main thread renderer.')
      }
    }

    compositorWorkerRef.current = worker
    return worker
  }

  const createMainThreadComposedTrack = async (displayTrack, cameraTrack) => {
    const screenVideo = document.createElement('video')
    screenVideo.srcObject = new MediaStream([displayTrack])
    screenVideo.muted = true
    screenVideo.playsInline = true
    await screenVideo.play()

    const cameraVideo = document.createElement('video')
    cameraVideo.srcObject = new MediaStream([cameraTrack])
    cameraVideo.muted = true
    cameraVideo.playsInline = true
    await cameraVideo.play()

    const settings = displayTrack.getSettings?.() ?? {}
    const canvasWidth = Math.max(1280, settings.width || window.screen.width || 1920)
    const canvasHeight = Math.max(720, settings.height || window.screen.height || 1080)

    const canvas = document.createElement('canvas')
    canvas.width = canvasWidth
    canvas.height = canvasHeight

    const ctx = canvas.getContext('2d', { alpha: false })

    if (!ctx) {
      throw new Error('Canvas context not available.')
    }

    const drawFrame = () => {
      ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height)

      const margin = Math.round(canvas.width * 0.02)
      const pipWidth = Math.round(canvas.width * 0.22)
      const pipHeight = Math.round(pipWidth * (9 / 16))
      const pipX = margin
      const pipY = canvas.height - pipHeight - margin

      ctx.fillStyle = 'rgba(0, 0, 0, 0.82)'
      ctx.fillRect(pipX - 3, pipY - 3, pipWidth + 6, pipHeight + 6)
      ctx.drawImage(cameraVideo, pipX, pipY, pipWidth, pipHeight)

      renderLoopRef.current = requestAnimationFrame(drawFrame)
    }

    drawFrame()

    compositorElementsRef.current = { screenVideo, cameraVideo }

    const stream = canvas.captureStream(60)
    const track = stream.getVideoTracks()[0]

    if (!track) {
      throw new Error('Composed video track not available.')
    }

    return track
  }

  const createWorkerComposedTrack = async (displayTrack, cameraTrack) => {
    const settings = displayTrack.getSettings?.() ?? {}
    const width = Math.max(1280, settings.width || window.screen.width || 1920)
    const height = Math.max(720, settings.height || window.screen.height || 1080)

    const compositionId = Date.now()
    compositorIdRef.current = compositionId

    const displayProcessor = new window.MediaStreamTrackProcessor({ track: displayTrack })
    const cameraProcessor = new window.MediaStreamTrackProcessor({ track: cameraTrack })
    const generator = new window.MediaStreamTrackGenerator({ kind: 'video' })

    compositorTrackRef.current = generator

    ensureCompositorWorker().postMessage(
      {
        type: 'start',
        compositionId,
        displayReadable: displayProcessor.readable,
        cameraReadable: cameraProcessor.readable,
        outputWritable: generator.writable,
        width,
        height,
      },
      [displayProcessor.readable, cameraProcessor.readable, generator.writable],
    )

    return generator
  }

  const updateCaptureOption = (key, value) => {
    setCaptureOptions((current) => ({ ...current, [key]: value }))
  }

  const startRecording = async () => {
    if (phase === 'recording' || phase === 'converting') {
      return
    }

    resetOutputUrls()
    cleanupCapturePipeline()
    setErrorMessage('')

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia(
        buildDisplayConstraints(captureOptions.includeSystemAudio),
      )
      const displayVideoTrack = displayStream.getVideoTracks()[0]

      if (!displayVideoTrack) {
        throw new Error('Display video track not found.')
      }

      const micStream = captureOptions.includeMicrophone
        ? await navigator.mediaDevices.getUserMedia({
            audio: {
              autoGainControl: false,
              echoCancellation: false,
              noiseSuppression: false,
              sampleRate: 48000,
            },
            video: false,
          })
        : null

      const cameraStream = captureOptions.includeCamera
        ? await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              frameRate: { ideal: 30, max: 30 },
              height: { ideal: 720 },
              width: { ideal: 1280 },
            },
          })
        : null

      sourceStreamsRef.current = [displayStream, micStream, cameraStream].filter(Boolean)

      const cameraTrack = cameraStream?.getVideoTracks()[0]
      let recordingVideoTrack = displayVideoTrack

      if (cameraTrack) {
        if (supportsWorkerComposition()) {
          recordingVideoTrack = await createWorkerComposedTrack(displayVideoTrack, cameraTrack)
        } else {
          recordingVideoTrack = await createMainThreadComposedTrack(displayVideoTrack, cameraTrack)
          setErrorMessage('Worker composition is not supported on this browser.')
        }
      }

      const finalTracks = [recordingVideoTrack]
      const systemAudioTracks = captureOptions.includeSystemAudio
        ? displayStream.getAudioTracks()
        : []
      const micAudioTracks = captureOptions.includeMicrophone
        ? (micStream?.getAudioTracks() ?? [])
        : []

      if (systemAudioTracks.length > 0 || micAudioTracks.length > 0) {
        const audioContext = new AudioContext()
        const destination = audioContext.createMediaStreamDestination()
        audioContextRef.current = audioContext

        if (systemAudioTracks.length > 0) {
          const systemSource = audioContext.createMediaStreamSource(
            new MediaStream(systemAudioTracks),
          )
          systemSource.connect(destination)
        }

        if (micAudioTracks.length > 0) {
          const micSource = audioContext.createMediaStreamSource(
            new MediaStream(micAudioTracks),
          )
          micSource.connect(destination)
        }

        destination.stream.getAudioTracks().forEach((track) => finalTracks.push(track))
      }

      const finalStream = new MediaStream(finalTracks)
      activePreviewStreamRef.current = finalStream

      const mimeType = pickRecorderMimeType()
      const recorder = new MediaRecorder(
        finalStream,
        mimeType
          ? {
              mimeType,
              audioBitsPerSecond: 256000,
              videoBitsPerSecond: 28000000,
            }
          : {
              audioBitsPerSecond: 256000,
              videoBitsPerSecond: 28000000,
            },
      )

      recorderRef.current = recorder
      chunksRef.current = []

      displayVideoTrack.addEventListener(
        'ended',
        () => {
          if (recorder.state !== 'inactive') {
            recorder.stop()
          }
        },
        { once: true },
      )

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

        chunksRef.current = []
        cleanupCapturePipeline()

        const recordedMimeType = recorder.mimeType || mimeType || 'video/webm'

        if (!needsMp4Conversion(recordedMimeType)) {
          const directUrl = URL.createObjectURL(recordedBlob)
          setPreviewObjectUrl(directUrl)
          setDownloadObjectUrl(directUrl)
          setPhase('ready')
          return
        }

        setPreviewObjectUrl(URL.createObjectURL(recordedBlob))
        setDownloadObjectUrl('')
        setPhase('converting')

        const jobId = Date.now()
        pendingJobRef.current = jobId
        ensureWorker().postMessage({ jobId, blob: recordedBlob })
      }

      recorder.start(1000)
      setPhase('recording')
    } catch (error) {
      cleanupCapturePipeline()
      recorderRef.current = null
      setPhase('error')
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Unable to start recording with selected inputs.',
      )
    }
  }

  const stopRecording = () => {
    if (!recorderRef.current || recorderRef.current.state === 'inactive') {
      return
    }

    recorderRef.current.stop()
  }

  return {
    captureOptions,
    downloadUrl,
    errorMessage,
    phase,
    startRecording,
    stopRecording,
    updateCaptureOption,
    videoRef,
  }
}
