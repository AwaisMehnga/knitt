let isRunning = false
let activeCompositionId = 0

self.onmessage = async ({ data }) => {
  if (data.type === 'stop') {
    if (data.compositionId === activeCompositionId) {
      isRunning = false
    }
    return
  }

  if (data.type !== 'start') {
    return
  }

  const {
    compositionId,
    displayReadable,
    cameraReadable,
    outputWritable,
    width,
    height,
  } = data

  activeCompositionId = compositionId
  isRunning = true

  const displayReader = displayReadable.getReader()
  const cameraReader = cameraReadable.getReader()
  const writer = outputWritable.getWriter()

  const canvas = new self.OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false })

  if (!ctx) {
    self.postMessage({
      type: 'error',
      compositionId,
      message: 'Offscreen canvas context unavailable.',
    })
    isRunning = false
    return
  }

  let latestCameraFrame = null

  const cameraLoop = (async () => {
    while (isRunning) {
      const { done, value } = await cameraReader.read()

      if (done) {
        break
      }

      if (latestCameraFrame) {
        latestCameraFrame.close()
      }

      latestCameraFrame = value
    }
  })()

  try {
    while (isRunning) {
      const { done, value: displayFrame } = await displayReader.read()

      if (done) {
        break
      }

      ctx.drawImage(displayFrame, 0, 0, width, height)

      if (latestCameraFrame) {
        const margin = Math.round(width * 0.02)
        const pipWidth = Math.round(width * 0.22)
        const pipHeight = Math.round(pipWidth * (9 / 16))
        const pipX = margin
        const pipY = height - pipHeight - margin

        ctx.fillStyle = 'rgba(0, 0, 0, 0.82)'
        ctx.fillRect(pipX - 3, pipY - 3, pipWidth + 6, pipHeight + 6)
        ctx.drawImage(latestCameraFrame, pipX, pipY, pipWidth, pipHeight)
      }

      const composedFrame = new self.VideoFrame(canvas, {
        timestamp: displayFrame.timestamp,
        duration: displayFrame.duration,
      })

      await writer.ready
      await writer.write(composedFrame)

      composedFrame.close()
      displayFrame.close()
    }

    self.postMessage({ type: 'done', compositionId })
  } catch (error) {
    self.postMessage({
      type: 'error',
      compositionId,
      message: error instanceof Error ? error.message : 'Composition failed.',
    })
  } finally {
    isRunning = false

    if (latestCameraFrame) {
      latestCameraFrame.close()
      latestCameraFrame = null
    }

    await cameraLoop.catch(() => {})

    await displayReader.cancel().catch(() => {})
    await cameraReader.cancel().catch(() => {})
    await writer.close().catch(() => {})
  }
}
