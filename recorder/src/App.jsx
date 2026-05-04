import { useRecorderStore } from "./stores/recorder";

function App() {
  const {
    isRecording,
    isStarting,
    status,
    error,
    videoUrl,
    recordCamera,
    recordMic,
    startRecording,
    stopRecording,
    toggleRecordCamera,
    toggleRecordMic,
  } = useRecorderStore();

  return (
    <div className="container mx-auto p-4 flex flex-col items-center h-screen justify-center">
      <h1 className="text-4xl font-bold">Knitt | sew your own video</h1>
      <p className="mt-4 text-lg">
        A tool to record your screen and webcam, and stitch them together into a
        single video.
      </p>

      {/* Recording options - only show when not recording */}
      {!isRecording && !isStarting && (
        <div className="flex flex-col gap-4 mt-8 p-6 bg-gray-100 rounded-lg">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="recordCamera"
              checked={recordCamera}
              onChange={toggleRecordCamera}
              className="w-4 h-4 cursor-pointer"
            />
            <label htmlFor="recordCamera" className="cursor-pointer font-medium">
              Record Camera (PiP overlay)
            </label>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="recordMic"
              checked={recordMic}
              onChange={toggleRecordMic}
              className="w-4 h-4 cursor-pointer"
            />
            <label htmlFor="recordMic" className="cursor-pointer font-medium">
              Record Microphone
            </label>
          </div>
          <p className="text-sm text-gray-600">Full screen recording is always enabled</p>
        </div>
      )}

      <div className="flex items-center gap-4 mt-8">
        <button
          onClick={isRecording || isStarting ? stopRecording : startRecording}
          className={`${isRecording || isStarting ? "bg-red-500" : "bg-amber-300"} text-white px-4 py-2 rounded`}
        >
          {isRecording || isStarting ? "Stop" : "Start"} Recording
        </button>
      </div>

      <p className="mt-4 text-sm text-gray-600">Status: {status}</p>
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}

      {videoUrl ? (
        <div className="mt-8 w-full max-w-4xl">
          <video src={videoUrl} controls className="w-full rounded-lg shadow" />
        </div>
      ) : null}
    </div>
  );
}

export default App;
