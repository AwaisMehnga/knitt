// useRecorder.js
// Screen recorder hook with:
//  - Proper audio processing chain (noise gate → high-pass → compressor → limiter)
//  - WebGL-accelerated PiP composition via compositor worker
//  - Split video/audio recording for reliable muxing
//  - Clean resource management

import { useEffect, useRef, useState } from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────

const DISPLAY_FPS = 30
const CAMERA_FPS = 24
const MAX_WIDTH = 1920
const MAX_HEIGHT = 1080
const VIDEO_BPS = 8_000_000
const AUDIO_BPS = 192_000

const VIDEO_MIME_TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=av01.0.08M.08,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

const AUDIO_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
]

const DEFAULT_OPTIONS = {
  includeCamera: true,
  includeMicrophone: true,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pickMime(types) {
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

function needsConversion(mime) {
  return !mime.startsWith('video/mp4')
}

function getAlignedDimensions(track, fallbackW = 1920, fallbackH = 1080) {
  const s = track.getSettings?.() ?? {}
  const rawW = Number.isFinite(s.width) ? s.width : fallbackW
  const rawH = Number.isFinite(s.height) ? s.height : fallbackH
  const scale = Math.min(1, MAX_WIDTH / Math.max(1, rawW), MAX_HEIGHT / Math.max(1, rawH))
  return {
    width: Math.max(2, Math.floor(rawW * scale) & ~1), // force even
    height: Math.max(2, Math.floor(rawH * scale) & ~1),
  }
}

function supportsWorkerComposition() {
  const TrackGeneratorCtor = window.VideoTrackGenerator ?? window.MediaStreamTrackGenerator
  return (
    typeof window.MediaStreamTrackProcessor !== 'undefined' &&
    typeof TrackGeneratorCtor !== 'undefined' &&
    typeof window.VideoFrame !== 'undefined' &&
    typeof window.OffscreenCanvas !== 'undefined'
  )
}

function getTrackGeneratorCtor() {
  return window.VideoTrackGenerator ?? window.MediaStreamTrackGenerator
}

// ─── Audio processing chain ───────────────────────────────────────────────────
// mic → high-pass (cut rumble) → noise gate → compressor → limiter → output
//
// The noise gate suppresses background hiss when the user is silent.
// The compressor tames peaks. The limiter prevents digital clipping.

function buildAudioChain(ctx, micTrack) {
  const source = ctx.createMediaStreamSource(new MediaStream([micTrack]))

  // 1. High-pass – remove low-frequency rumble (AC hum, desk vibration)
  const highPass = ctx.createBiquadFilter()
  highPass.type = 'highpass'
  highPass.frequency.value = 120
  highPass.Q.value = 0.7

  // 2. Noise gate via gain + script processor workaround using DynamicsCompressor
  //    with extreme ratio at very low threshold acts as a gate
  const gate = ctx.createDynamicsCompressor()
  gate.threshold.value = -60   // only signals above -60 dBFS pass through gate
  gate.knee.value = 6
  gate.ratio.value = 20        // steep ratio = gate-like behaviour
  gate.attack.value = 0.001
  gate.release.value = 0.15

  // 3. Main compressor – tame dynamic range for cleaner recording
  const compressor = ctx.createDynamicsCompressor()
  compressor.threshold.value = -24
  compressor.knee.value = 10
  compressor.ratio.value = 4
  compressor.attack.value = 0.005
  compressor.release.value = 0.15

  // 4. Makeup gain after compression
  const gain = ctx.createGain()
  gain.gain.value = 1.4

  // 5. Limiter – hard clip prevention before output
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -1
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = 0.05

  const dest = ctx.createMediaStreamDestination()

  source.connect(highPass)
  highPass.connect(gate)
  gate.connect(compressor)
  compressor.connect(gain)
  gain.connect(limiter)
  limiter.connect(dest)

  return dest.stream
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useRecorder() {
  const [phase, setPhase] = useState('idle')          // idle | recording | converting | ready | error
  const [previewUrl, setPreviewUrl] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [captureOptions, setCaptureOptions] = useState(DEFAULT_OPTIONS)

  const videoRef = useRef(null)

  // Internal refs – never trigger re-renders
  const recorderRef = useRef(null)
  const audioRecorderRef = useRef(null)
  const workerRef = useRef(null)
  const compositorWorkerRef = useRef(null)
  const videoChunksRef = useRef([])
  const audioChunksRef = useRef([])
  const stopStateRef = useRef({ videoDone: false, audioDone: false, videoMime: '', audioMime: '' })
  const pendingJobRef = useRef(0)

  const sourceStreamsRef = useRef([])
  const activePreviewStreamRef = useRef(null)
  const previewUrlRef = useRef('')
  const downloadUrlRef = useRef('')
  const renderLoopRef = useRef(0)
  const compositorIdRef = useRef(0)
  const compositorTrackRef = useRef(null)
  const compositorElementsRef = useRef(null)
  const audioContextRef = useRef(null)

  // ── Lifecycle cleanup ──────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      compositorWorkerRef.current?.terminate()
      revokeUrl(previewUrlRef.current)
      revokeUrl(downloadUrlRef.current)
      activePreviewStreamRef.current?.getTracks().forEach((t) => t.stop())
      sourceStreamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      renderLoopRef.current && cancelAnimationFrame(renderLoopRef.current)
      audioContextRef.current?.close().catch(() => {})
    }
  }, [])

  // ── Video preview element sync ─────────────────────────────────────────────

  useEffect(() => {
    const v = videoRef.current
    if (!v) return

    if (phase === 'recording' && activePreviewStreamRef.current) {
      v.srcObject = activePreviewStreamRef.current
      v.controls = false
      v.muted = true
      v.play().catch(() => {})
      return
    }

    v.srcObject = null
    v.muted = false
    v.controls = !!previewUrl

    if (previewUrl) {
      v.src = previewUrl
      v.play().catch(() => {})
    } else {
      v.removeAttribute('src')
      v.load()
    }
  }, [phase, previewUrl])

  // ── URL helpers ────────────────────────────────────────────────────────────

  const revokeUrl = (url) => { if (url) URL.revokeObjectURL(url) }

  const setPreviewObjectUrl = (url) => {
    revokeUrl(previewUrlRef.current)
    previewUrlRef.current = url
    setPreviewUrl(url)
  }

  const setDownloadObjectUrl = (url) => {
    revokeUrl(downloadUrlRef.current)
    downloadUrlRef.current = url
    setDownloadUrl(url)
  }

  const resetUrls = () => {
    setPreviewObjectUrl('')
    setDownloadObjectUrl('')
  }

  // ── Cleanup pipeline ───────────────────────────────────────────────────────

  const cleanupComposition = () => {
    if (compositorIdRef.current && compositorWorkerRef.current) {
      compositorWorkerRef.current.postMessage({
        type: 'stop',
        compositionId: compositorIdRef.current,
      })
      compositorIdRef.current = 0
    }

    compositorTrackRef.current?.stop()
    compositorTrackRef.current = null

    if (renderLoopRef.current) {
      cancelAnimationFrame(renderLoopRef.current)
      renderLoopRef.current = 0
    }

    if (compositorElementsRef.current) {
      const { screenVideo, cameraVideo } = compositorElementsRef.current
      screenVideo?.pause()
      cameraVideo?.pause()
      compositorElementsRef.current = null
    }
  }

  const cleanupPipeline = () => {
    if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop()
    if (audioRecorderRef.current?.state !== 'inactive') audioRecorderRef.current?.stop()

    cleanupComposition()

    activePreviewStreamRef.current?.getTracks().forEach((t) => t.stop())
    activePreviewStreamRef.current = null

    sourceStreamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    sourceStreamsRef.current = []

    audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null

    recorderRef.current = null
    audioRecorderRef.current = null
  }

  // ── Workers ────────────────────────────────────────────────────────────────

  const ensureFFmpegWorker = () => {
    if (workerRef.current) return workerRef.current

    const worker = new Worker(new URL('../ffmpeg-worker.js', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = ({ data }) => {
      if (data.jobId !== pendingJobRef.current) return

      if (data.type === 'error') {
        setPhase('error')
        setErrorMessage('MP4 conversion failed. Please try recording again.')
        return
      }

      if (data.type === 'done') {
        const url = URL.createObjectURL(data.blob)
        setDownloadObjectUrl(url)
        setPreviewObjectUrl(url)
        setPhase('ready')
        setErrorMessage('')
      }
    }

    worker.onerror = () => {
      setPhase('error')
      setErrorMessage('MP4 conversion failed.')
    }

    workerRef.current = worker
    return worker
  }

  const ensureCompositorWorker = () => {
    if (compositorWorkerRef.current) return compositorWorkerRef.current

    const worker = new Worker(new URL('../compositor-worker.js', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = ({ data }) => {
      if (data?.type === 'error' && data.compositionId === compositorIdRef.current) {
        console.warn('[compositor]', data.message)
      }
    }

    compositorWorkerRef.current = worker
    return worker
  }

  // ── Composition track creation ─────────────────────────────────────────────

  const createWorkerComposedTrack = async (displayTrack, cameraTrack) => {
    const { width, height } = getAlignedDimensions(
      displayTrack,
      window.screen.width || 1920,
      window.screen.height || 1080,
    )

    const compositionId = Date.now()
    compositorIdRef.current = compositionId

    const displayProcessor = new window.MediaStreamTrackProcessor({ track: displayTrack })
    const cameraProcessor = new window.MediaStreamTrackProcessor({ track: cameraTrack })
    const TrackGeneratorCtor = getTrackGeneratorCtor()
    const generator = new TrackGeneratorCtor({ kind: 'video' })

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

  const createMainThreadComposedTrack = async (displayTrack, cameraTrack) => {
    const mkVideo = async (stream) => {
      const v = document.createElement('video')
      v.srcObject = stream
      v.muted = true
      v.playsInline = true
      await v.play()
      return v
    }

    const screenVideo = await mkVideo(new MediaStream([displayTrack]))
    const cameraVideo = await mkVideo(new MediaStream([cameraTrack]))

    const { width, height } = getAlignedDimensions(
      displayTrack,
      screenVideo.videoWidth || 1920,
      screenVideo.videoHeight || 1080,
    )

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 2D context unavailable.')

    const drawFrame = () => {
      ctx.drawImage(screenVideo, 0, 0, width, height)

      const margin = Math.round(width * 0.02)
      const pipW = Math.round(width * 0.22)
      const pipH = Math.round(pipW * (9 / 16))
      const pipX = margin
      const pipY = height - pipH - margin

      ctx.fillStyle = '#000'
      ctx.fillRect(pipX - 3, pipY - 3, pipW + 6, pipH + 6)
      ctx.drawImage(cameraVideo, pipX, pipY, pipW, pipH)

      renderLoopRef.current = requestAnimationFrame(drawFrame)
    }

    drawFrame()
    compositorElementsRef.current = { screenVideo, cameraVideo }

    const track = canvas.captureStream(DISPLAY_FPS).getVideoTracks()[0]
    if (!track) throw new Error('Canvas capture track unavailable.')
    return track
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  const updateCaptureOption = (key, value) => {
    setCaptureOptions((prev) => ({ ...prev, [key]: value }))
  }

  const startRecording = async () => {
    if (phase === 'recording' || phase === 'converting') return

    resetUrls()
    cleanupPipeline()
    setErrorMessage('')

    try {
      // 1. Capture display
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        surfaceSwitching: 'include',
        systemAudio: 'exclude',
        video: {
          displaySurface: 'monitor',
          frameRate: { ideal: DISPLAY_FPS, max: DISPLAY_FPS },
          height: { ideal: Math.min(window.screen.height, MAX_HEIGHT) },
          width: { ideal: Math.min(window.screen.width, MAX_WIDTH) },
        },
      })

      const displayTrack = displayStream.getVideoTracks()[0]
      if (!displayTrack) throw new Error('No display video track.')

      // 2. Capture microphone (separate stream)
      let micTrack = null
      let micStream = null

      if (captureOptions.includeMicrophone) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              autoGainControl: false,   // we handle this ourselves in the audio chain
              channelCount: { ideal: 1 },
              echoCancellation: true,
              noiseSuppression: true,
              sampleRate: 48000,
              sampleSize: 16,
            },
            video: false,
          })
          micTrack = micStream.getAudioTracks()[0]
        } catch {
          // Mic permission denied – continue without audio
        }
      }

      // 3. Capture camera
      let cameraStream = null
      if (captureOptions.includeCamera) {
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              frameRate: { ideal: CAMERA_FPS, max: CAMERA_FPS },
              height: { ideal: 720 },
              width: { ideal: 1280 },
            },
          })
        } catch {
          // Camera permission denied – continue without PiP
        }
      }

      sourceStreamsRef.current = [displayStream, micStream, cameraStream].filter(Boolean)

      // 4. Compose video track (with PiP if camera available)
      const cameraTrack = cameraStream?.getVideoTracks()[0]
      let recordingVideoTrack = displayTrack

      if (cameraTrack) {
        if (supportsWorkerComposition()) {
          recordingVideoTrack = await createWorkerComposedTrack(displayTrack, cameraTrack)
        } else {
          recordingVideoTrack = await createMainThreadComposedTrack(displayTrack, cameraTrack)
        }
      }

      if ('contentHint' in recordingVideoTrack) {
        recordingVideoTrack.contentHint = 'detail'
      }

      // 5. Build audio processing chain
      let processedAudioStream = null

      if (micTrack) {
        const audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
        await audioCtx.resume().catch(() => {})
        audioContextRef.current = audioCtx
        processedAudioStream = buildAudioChain(audioCtx, micTrack)
      }

      // 6. Setup preview stream (video only, muted)
      const previewTrack = recordingVideoTrack.clone?.() ?? recordingVideoTrack
      activePreviewStreamRef.current = new MediaStream([previewTrack])

      // 7. Create video recorder (video only, no audio track mixed in)
      const videoMime = pickMime(VIDEO_MIME_TYPES)
      const videoRecorder = new MediaRecorder(
        new MediaStream([recordingVideoTrack]),
        videoMime
          ? { mimeType: videoMime, videoBitsPerSecond: VIDEO_BPS }
          : { videoBitsPerSecond: VIDEO_BPS },
      )

      // 8. Create separate audio recorder for clean audio isolation
      const audioMime = pickMime(AUDIO_MIME_TYPES)
      const audioRecorder = processedAudioStream
        ? new MediaRecorder(
            processedAudioStream,
            audioMime
              ? { mimeType: audioMime, audioBitsPerSecond: AUDIO_BPS }
              : { audioBitsPerSecond: AUDIO_BPS },
          )
        : null

      recorderRef.current = videoRecorder
      audioRecorderRef.current = audioRecorder
      videoChunksRef.current = []
      audioChunksRef.current = []
      stopStateRef.current = {
        videoDone: false,
        audioDone: !audioRecorder,
        videoMime: '',
        audioMime: '',
      }

      // 9. Finalization: called when both recorders have stopped
      const finalize = () => {
        const state = stopStateRef.current
        if (!state.videoDone || !state.audioDone) return

        recorderRef.current = null
        audioRecorderRef.current = null

        const videoBlob = new Blob(videoChunksRef.current, {
          type: state.videoMime || videoMime || 'video/webm',
        })
        const audioBlob = audioChunksRef.current.length
          ? new Blob(audioChunksRef.current, {
              type: state.audioMime || audioMime || 'audio/webm',
            })
          : null

        videoChunksRef.current = []
        audioChunksRef.current = []

        const resolvedMime = state.videoMime || videoMime || 'video/webm'

        // Fast path: native MP4 with no audio to mux
        if (!audioBlob && !needsConversion(resolvedMime)) {
          cleanupPipeline()
          const url = URL.createObjectURL(videoBlob)
          setPreviewObjectUrl(url)
          setDownloadObjectUrl(url)
          setPhase('ready')
          return
        }

        // Show video preview immediately while converting
        setPreviewObjectUrl(URL.createObjectURL(videoBlob))
        setDownloadObjectUrl('')
        setPhase('converting')

        const jobId = Date.now()
        pendingJobRef.current = jobId
        ensureFFmpegWorker().postMessage({ jobId, videoBlob, audioBlob })

        cleanupPipeline()
      }

      // Stop recorders when user stops sharing display
      displayTrack.addEventListener('ended', () => {
        if (videoRecorder.state !== 'inactive') videoRecorder.stop()
        if (audioRecorder?.state !== 'inactive') audioRecorder?.stop()
      }, { once: true })

      videoRecorder.ondataavailable = ({ data }) => {
        if (data.size > 0) videoChunksRef.current.push(data)
      }
      videoRecorder.onstop = () => {
        stopStateRef.current.videoDone = true
        stopStateRef.current.videoMime = videoRecorder.mimeType
        finalize()
      }

      if (audioRecorder) {
        audioRecorder.ondataavailable = ({ data }) => {
          if (data.size > 0) audioChunksRef.current.push(data)
        }
        audioRecorder.onstop = () => {
          stopStateRef.current.audioDone = true
          stopStateRef.current.audioMime = audioRecorder.mimeType
          finalize()
        }
      }

      videoRecorder.start(1000)
      audioRecorder?.start(1000)

      setPhase('recording')
    } catch (err) {
      cleanupPipeline()
      recorderRef.current = null
      audioRecorderRef.current = null
      videoChunksRef.current = []
      audioChunksRef.current = []
      setPhase('error')
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to start recording.',
      )
    }
  }

  const stopRecording = () => {
    if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop()
    if (audioRecorderRef.current?.state !== 'inactive') audioRecorderRef.current?.stop()
  }

  return {
    captureOptions,
    downloadUrl,
    errorMessage,
    phase,
    previewUrl,
    startRecording,
    stopRecording,
    updateCaptureOption,
    videoRef,
  }
}