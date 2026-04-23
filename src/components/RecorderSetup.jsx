function RecorderSetup({ options, onOptionChange, onStart, startDisabled }) {
  return (
    <section className="setup" aria-label="Capture setup">
      <div className="source-row">
        <span className="source-label">Source</span>
        <span className="source-value">Entire screen (default)</span>
      </div>

      <label className="setup-item" htmlFor="include-camera">
        <input
          id="include-camera"
          type="checkbox"
          checked={options.includeCamera}
          onChange={(event) => onOptionChange('includeCamera', event.target.checked)}
        />
        <span>Camera overlay</span>
      </label>

      <label className="setup-item" htmlFor="include-microphone">
        <input
          id="include-microphone"
          type="checkbox"
          checked={options.includeMicrophone}
          onChange={(event) => onOptionChange('includeMicrophone', event.target.checked)}
        />
        <span>Microphone audio</span>
      </label>

      <label className="setup-item" htmlFor="include-system-audio">
        <input
          id="include-system-audio"
          type="checkbox"
          checked={options.includeSystemAudio}
          onChange={(event) => onOptionChange('includeSystemAudio', event.target.checked)}
        />
        <span>System audio</span>
      </label>

      <button
        type="button"
        className="control-button start"
        onClick={onStart}
        disabled={startDisabled}
      >
        Start
      </button>
    </section>
  )
}

export default RecorderSetup
