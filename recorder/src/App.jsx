import { useRecorderStore } from "./stores/recorder";

function App() {
  const {
    isRecording,
    isStarting,
    status,
    error,
    videoUrl,
    startRecording,
    stopRecording,
  } = useRecorderStore();

  return (
    <div className="container mx-auto p-4 flex flex-col items-center h-screen justify-center">
      <h1 className="text-4xl font-bold">Knitt | sew your own video</h1>
      <p className="mt-4 text-lg">
        A tool to record your screen and webcam, and stitch them together into a
        single video.
      </p>

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
