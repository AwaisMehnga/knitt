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
    pipPosition,
    pipSize,
    pipOpacity,
    pipBorderRadius,
    pipShape,
    pipHidden,
    startRecording,
    stopRecording,
    toggleRecordCamera,
    toggleRecordMic,
    setPipPosition,
    setPipSize,
    setPipOpacity,
    setPipBorderRadius,
    setPipShape,
    updatePipPositionDuringRecording,
    updatePipVisibilityDuringRecording,
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
        <div className="flex flex-col gap-4 mt-8 p-6 bg-gray-100 rounded-lg max-w-md">
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

          {/* PiP customization - only show when camera is enabled */}
          {recordCamera && (
            <div className="ml-6 flex flex-col gap-4 p-4 bg-white rounded border border-gray-300">
              <h3 className="font-semibold text-sm">Camera Overlay Settings</h3>
              
              {/* Shape Selector */}
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Shape</label>
                <div className="flex gap-3 justify-center">
                  {/* Circle */}
                  <button
                    onClick={() => setPipShape("circle")}
                    className={`w-16 h-16 rounded-full border-2 flex items-center justify-center transition ${
                      pipShape === "circle"
                        ? "border-blue-500 bg-blue-100"
                        : "border-gray-300 bg-gray-100 hover:bg-gray-200"
                    }`}
                    title="Circle"
                  >
                    <div className="w-10 h-10 rounded-full bg-blue-400"></div>
                  </button>
                  {/* Square */}
                  <button
                    onClick={() => setPipShape("square")}
                    className={`w-16 h-16 border-2 flex items-center justify-center transition ${
                      pipShape === "square"
                        ? "border-blue-500 bg-blue-100"
                        : "border-gray-300 bg-gray-100 hover:bg-gray-200"
                    }`}
                    title="Square"
                  >
                    <div className="w-10 h-10 bg-blue-400"></div>
                  </button>
                  {/* Rectangle */}
                  <button
                    onClick={() => setPipShape("rectangle")}
                    className={`w-16 h-16 border-2 flex items-center justify-center transition ${
                      pipShape === "rectangle"
                        ? "border-blue-500 bg-blue-100"
                        : "border-gray-300 bg-gray-100 hover:bg-gray-200"
                    }`}
                    title="Rectangle"
                  >
                    <div className="w-12 h-8 bg-blue-400"></div>
                  </button>
                </div>
              </div>
              
              {/* Position Grid */}
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Position</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: "top-left", label: "↖" },
                    { value: "top-center", label: "⬆" },
                    { value: "top-right", label: "↗" },
                    { value: "center-left", label: "⬅" },
                    { value: "center", label: "⊙" },
                    { value: "center-right", label: "➡" },
                    { value: "bottom-left", label: "↙" },
                    { value: "bottom-center", label: "⬇" },
                    { value: "bottom-right", label: "↘" },
                  ].map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => setPipPosition(value)}
                      className={`p-2 rounded border-2 text-lg font-bold transition ${
                        pipPosition === value
                          ? "border-blue-500 bg-blue-100"
                          : "border-gray-300 bg-gray-100 hover:bg-gray-200"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              
              {/* Size */}
              <div className="flex flex-col gap-2">
                <label htmlFor="pipSize" className="text-sm font-medium">
                  Size: {pipSize}%
                </label>
                <input
                  type="range"
                  id="pipSize"
                  min="10"
                  max="50"
                  value={pipSize}
                  onChange={(e) => setPipSize(e.target.value)}
                  className="w-full"
                />
              </div>
              
              {/* Opacity */}
              <div className="flex flex-col gap-2">
                <label htmlFor="pipOpacity" className="text-sm font-medium">
                  Opacity: {pipOpacity}%
                </label>
                <input
                  type="range"
                  id="pipOpacity"
                  min="0"
                  max="100"
                  value={pipOpacity}
                  onChange={(e) => setPipOpacity(e.target.value)}
                  className="w-full"
                />
              </div>

              {/* Border radius */}
              <div className="flex flex-col gap-2">
                <label htmlFor="pipBorderRadius" className="text-sm font-medium">
                  Border Radius: {pipBorderRadius}%
                </label>
                <input
                  type="range"
                  id="pipBorderRadius"
                  min="0"
                  max="100"
                  value={pipBorderRadius}
                  onChange={(e) => setPipBorderRadius(e.target.value)}
                  className="w-full"
                />
              </div>
            </div>
          )}

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

      {/* Floating PiP controls during recording */}
      {isRecording && recordCamera && (
        <div className="fixed bottom-6 right-6 flex flex-col gap-3 p-4 bg-white rounded-lg shadow-lg border border-gray-300 z-50">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold text-sm">Camera Position</h3>
            <button
              onClick={updatePipVisibilityDuringRecording}
              className={`px-3 py-1 rounded text-sm font-medium transition ${
                pipHidden
                  ? "bg-gray-200 text-gray-700 hover:bg-gray-300"
                  : "bg-blue-500 text-white hover:bg-blue-600"
              }`}
              title={pipHidden ? "Show camera overlay" : "Hide camera overlay"}
            >
              {pipHidden ? "👁️ Show" : "👁️ Hide"}
            </button>
          </div>
          
          {!pipHidden && (
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: "top-left", label: "↖" },
                { value: "top-center", label: "⬆" },
                { value: "top-right", label: "↗" },
                { value: "center-left", label: "⬅" },
                { value: "center", label: "⊙" },
                { value: "center-right", label: "➡" },
                { value: "bottom-left", label: "↙" },
                { value: "bottom-center", label: "⬇" },
                { value: "bottom-right", label: "↘" },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => updatePipPositionDuringRecording(value)}
                  className={`p-2 rounded border-2 text-sm font-bold transition ${
                    pipPosition === value
                      ? "border-blue-500 bg-blue-100"
                      : "border-gray-300 bg-gray-100 hover:bg-gray-200"
                  }`}
                  title={value}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          
          <p className="text-xs text-gray-600 text-center">
            Click to move or hide camera overlay
          </p>
        </div>
      )}

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
