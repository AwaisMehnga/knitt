import RecorderSetup from './components/RecorderSetup.jsx'
import { useRecorder } from './hooks/useRecorder.js'
import './App.css'

function App() {
  const {
    captureOptions,
    downloadUrl,
    errorMessage,
    phase,
    startRecording,
    stopRecording,
    updateCaptureOption,
    videoRef,
  } = useRecorder()

  return (
    <main className="app-shell">
      <section className="stage" aria-label="Screen recording preview">
        <video ref={videoRef} className="preview" playsInline controls={false} />
      </section>

      <RecorderSetup
        options={captureOptions}
        onOptionChange={updateCaptureOption}
        onStart={startRecording}
        startDisabled={phase === 'recording' || phase === 'converting'}
      />

      <div className="controls">
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
            download="screen-recording.mp4"
            aria-disabled={!downloadUrl}
            onClick={(event) => {
              if (!downloadUrl) {
                event.preventDefault()
              }
            }}
          >
            {phase === 'converting'
              ? 'Processing...'
              : phase === 'error' && !downloadUrl
                ? 'Processing failed'
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
