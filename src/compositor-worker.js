// compositor-worker.js
// WebGL-accelerated PiP compositor. Falls back to 2D canvas if WebGL unavailable.

let isRunning = false
let activeCompositionId = 0

function createShader(gl, type, source) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function createProgram(gl) {
  const vs = createShader(
    gl,
    gl.VERTEX_SHADER,
    `attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main(){gl_Position=vec4(a_pos,0,1);v_uv=a_uv;}`,
  )

  const fs = createShader(
    gl,
    gl.FRAGMENT_SHADER,
    `precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main(){gl_FragColor=texture2D(u_tex,v_uv);}`,
  )

  if (!vs || !fs) return null

  const prog = gl.createProgram()
  if (!prog) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return null
  }

  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog)
    return null
  }

  return prog
}

function makeTexture(gl) {
  const tex = gl.createTexture()
  if (!tex) return null
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  return tex
}

function createWebGLRenderer(canvas, width, height) {
  const ctxAttribs = {
    alpha: false,
    antialias: false,
    desynchronized: true,
    depth: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
  }

  const gl =
    canvas.getContext('webgl2', ctxAttribs) ||
    canvas.getContext('webgl', ctxAttribs)

  if (!gl) return null

  const prog = createProgram(gl)
  if (!prog) return null

  const posLoc = gl.getAttribLocation(prog, 'a_pos')
  const uvLoc = gl.getAttribLocation(prog, 'a_uv')
  const texLoc = gl.getUniformLocation(prog, 'u_tex')

  if (posLoc < 0 || uvLoc < 0 || !texLoc) {
    gl.deleteProgram(prog)
    return null
  }

  const buf = gl.createBuffer()
  const displayTex = makeTexture(gl)
  const cameraTex = makeTexture(gl)

  if (!buf || !displayTex || !cameraTex) {
    gl.deleteProgram(prog)
    buf && gl.deleteBuffer(buf)
    displayTex && gl.deleteTexture(displayTex)
    cameraTex && gl.deleteTexture(cameraTex)
    return null
  }

  gl.useProgram(prog)
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.enableVertexAttribArray(posLoc)
  gl.enableVertexAttribArray(uvLoc)
  // stride=16: [x,y,u,v] × 4 bytes
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0)
  gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8)
  gl.uniform1i(texLoc, 0)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)

  const uploadFrame = (tex, frame) => {
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
  }

  const drawQuad = (tex, l, r, t, b) => {
    // prettier-ignore
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      l, b, 0, 0,
      r, b, 1, 0,
      l, t, 0, 1,
      r, t, 1, 1,
    ]), gl.STREAM_DRAW)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  return {
    close() {
      gl.deleteTexture(displayTex)
      gl.deleteTexture(cameraTex)
      gl.deleteBuffer(buf)
      gl.deleteProgram(prog)
    },

    draw(displayFrame, cameraFrame) {
      try {
        gl.viewport(0, 0, width, height)
        gl.disable(gl.SCISSOR_TEST)
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)

        uploadFrame(displayTex, displayFrame)
        drawQuad(displayTex, -1, 1, 1, -1)

        if (cameraFrame) {
          const margin = Math.round(width * 0.02)
          const pipW = Math.round(width * 0.22)
          const pipH = Math.round(pipW * (9 / 16))
          const pipX = margin
          const pipY = height - pipH - margin

          // Draw black border via scissor clear
          const bx = pipX - 3
          const by = pipY - 3
          const bw = pipW + 6
          const bh = pipH + 6
          gl.enable(gl.SCISSOR_TEST)
          gl.scissor(bx, height - (by + bh), bw, bh)
          gl.clearColor(0, 0, 0, 1)
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.disable(gl.SCISSOR_TEST)

          uploadFrame(cameraTex, cameraFrame)
          const l = -1 + (2 * pipX) / width
          const r = -1 + (2 * (pipX + pipW)) / width
          const t = 1 - (2 * pipY) / height
          const bt2 = 1 - (2 * (pipY + pipH)) / height
          drawQuad(cameraTex, l, r, t, bt2)
        }

        return true
      } catch {
        return false
      }
    },
  }
}

function create2DRenderer(canvas, width, height) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  if (!ctx) return null

  return {
    close() {},
    draw(displayFrame, cameraFrame) {
      ctx.drawImage(displayFrame, 0, 0, width, height)

      if (cameraFrame) {
        const margin = Math.round(width * 0.02)
        const pipW = Math.round(width * 0.22)
        const pipH = Math.round(pipW * (9 / 16))
        const pipX = margin
        const pipY = height - pipH - margin

        ctx.fillStyle = '#000'
        ctx.fillRect(pipX - 3, pipY - 3, pipW + 6, pipH + 6)
        ctx.drawImage(cameraFrame, pipX, pipY, pipW, pipH)
      }

      return true
    },
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'stop') {
    if (data.compositionId === activeCompositionId) isRunning = false
    return
  }

  if (data.type !== 'start') return

  const { compositionId, displayReadable, cameraReadable, outputWritable, width, height } = data

  activeCompositionId = compositionId
  isRunning = true

  const displayReader = displayReadable.getReader()
  const cameraReader = cameraReadable.getReader()
  const writer = outputWritable.getWriter()

  const canvas = new self.OffscreenCanvas(width, height)
  const renderer =
    createWebGLRenderer(canvas, width, height) || create2DRenderer(canvas, width, height)

  if (!renderer) {
    self.postMessage({ type: 'error', compositionId, message: 'No renderer available.' })
    isRunning = false
    return
  }

  let latestCameraFrame = null

  // Drain camera frames continuously — always keep only the most recent one
  const cameraLoop = (async () => {
    while (isRunning) {
      const { done, value } = await cameraReader.read()
      if (done) break
      latestCameraFrame?.close()
      latestCameraFrame = value
    }
  })()

  try {
    while (isRunning) {
      const { done, value: displayFrame } = await displayReader.read()
      if (done) break

      try {
        if (!renderer.draw(displayFrame, latestCameraFrame)) {
          throw new Error('Renderer draw failed.')
        }

        const composed = new self.VideoFrame(canvas, {
          timestamp: displayFrame.timestamp,
          duration: displayFrame.duration,
        })

        if (writer.desiredSize === null || writer.desiredSize > 0) {
          await writer.write(composed)
        }

        composed.close()
      } finally {
        displayFrame.close()
      }
    }

    self.postMessage({ type: 'done', compositionId })
  } catch (err) {
    self.postMessage({
      type: 'error',
      compositionId,
      message: err instanceof Error ? err.message : 'Composition failed.',
    })
  } finally {
    isRunning = false
    latestCameraFrame?.close()
    latestCameraFrame = null
    renderer.close()

    await cameraLoop.catch(() => {})
    await displayReader.cancel().catch(() => {})
    await cameraReader.cancel().catch(() => {})
    await writer.close().catch(() => {})
  }
}