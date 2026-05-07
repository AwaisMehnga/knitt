import { useEffect, useMemo, useRef } from "react";

import { useRecorderStore } from "./stores/recorder";
import {
  BITRATE_PRESETS,
  RECORDING_FPS_OPTIONS,
  RECORDING_QUALITIES,
  computeScreenVideoBitrate,
} from "./utils/recorderConfig";

const PIP_POSITIONS = [
  { value: "top-left", label: "↖" },
  { value: "top-center", label: "⬆" },
  { value: "top-right", label: "↗" },
  { value: "center-left", label: "⬅" },
  { value: "center", label: "⊙" },
  { value: "center-right", label: "➡" },
  { value: "bottom-left", label: "↙" },
  { value: "bottom-center", label: "⬇" },
  { value: "bottom-right", label: "↘" },
];

const overlayPositionClass = (position) => {
  switch (position) {
    case "top-left":
      return "top-4 left-4";
    case "top-center":
      return "top-4 left-1/2 -translate-x-1/2";
    case "top-right":
      return "top-4 right-4";
    case "center-left":
      return "left-4 top-1/2 -translate-y-1/2";
    case "center":
      return "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2";
    case "center-right":
      return "right-4 top-1/2 -translate-y-1/2";
    case "bottom-left":
      return "bottom-4 left-4";
    case "bottom-center":
      return "bottom-4 left-1/2 -translate-x-1/2";
    case "bottom-right":
    default:
      return "bottom-4 right-4";
  }
};

function App() {
  const {
    isRecording,
    isStarting,
    isPaused,
    status,
    error,
    videoUrl,
    previewStream,
    cameraStream,
    recordCamera,
    recordMic,
    recordingQuality,
    recordingFps,
    bitratePreset,
    customVideoBitrateMbps,
    audioBitrateKbps,
    pipPosition,
    pipSize,
    pipOpacity,
    pipShape,
    pipHidden,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    cleanup,
    toggleRecordCamera,
    toggleRecordMic,
    setRecordingQuality,
    setRecordingFps,
    setBitratePreset,
    setCustomVideoBitrateMbps,
    setAudioBitrateKbps,
    setPipPosition,
    setPipSize,
    setPipOpacity,
    setPipShape,
    updatePipPositionDuringRecording,
    updatePipVisibilityDuringRecording,
  } = useRecorderStore();

  const screenPreviewRef = useRef(null);
  const cameraPreviewRef = useRef(null);

  const previewMeta = useMemo(
    () => [
      { label: "Screen", value: "live" },
      { label: "Camera", value: recordCamera ? "on" : "off" },
      { label: "Mic", value: recordMic ? "on" : "off" },
    ],
    [recordCamera, recordMic]
  );

  const selectedQuality =
    RECORDING_QUALITIES.find((quality) => quality.value === recordingQuality) ||
    RECORDING_QUALITIES.find((quality) => quality.value === "1080p");
  const estimatedVideoBitrate =
    bitratePreset === "custom"
      ? Number(customVideoBitrateMbps) || 3
      : computeScreenVideoBitrate({
          width: selectedQuality?.width || 1920,
          height: selectedQuality?.height || 1080,
          fps: recordingFps,
          preset: bitratePreset,
        }) / 1_000_000;
  const estimatedMegabytesPerMinute =
    ((estimatedVideoBitrate * 1_000_000 + audioBitrateKbps * 1000) * 60) /
    8 /
    1024 /
    1024;

  useEffect(() => {
    const attachStream = async (video, stream) => {
      if (!video) return;

      if (stream) {
        if (video.srcObject !== stream) {
          video.srcObject = stream;
        }

        try {
          await video.play();
        } catch {
          // Autoplay is muted; browser may still delay until the stream is ready.
        }
      } else {
        video.srcObject = null;
      }
    };

    void attachStream(screenPreviewRef.current, isRecording ? previewStream : null);
  }, [isRecording, previewStream]);

  useEffect(() => {
    const attachStream = async (video, stream) => {
      if (!video) return;

      if (stream) {
        if (video.srcObject !== stream) {
          video.srcObject = stream;
        }

        try {
          await video.play();
        } catch {
          // Ignore; video will render once metadata is available.
        }
      } else {
        video.srcObject = null;
      }
    };

    void attachStream(cameraPreviewRef.current, isRecording && recordCamera ? cameraStream : null);
  }, [cameraStream, isRecording, recordCamera]);

  const handleRestart = async () => {
    await cleanup();
    await startRecording();
  };

  const handleDelete = async () => {
    await cleanup();
  };

  const isBusy = isRecording || isStarting;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.12),transparent_30%),linear-gradient(180deg,#0b1020_0%,#111827_45%,#f8fafc_100%)] text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-4 py-6 md:px-8">
        <header className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-white/5 px-6 py-5 shadow-2xl backdrop-blur md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-sky-300/80">Knitt recorder</p>
            <h1 className="mt-2 text-3xl font-semibold text-white md:text-5xl">
              Record screen, camera, and mic without losing focus.
            </h1>
            <p className="mt-3 max-w-2xl text-sm text-slate-300 md:text-base">
              Live preview stays visible while you record. Camera placement can be changed on the preview, and switching tabs or windows will not interrupt the recording.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.2em] text-slate-300">
            {previewMeta.map((item) => (
              <span key={item.label} className="rounded-full border border-white/10 bg-black/20 px-3 py-1">
                {item.label}: {item.value}
              </span>
            ))}
          </div>
        </header>

        <main className="grid flex-1 gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
          <section className="rounded-3xl border border-slate-200/80 bg-white p-5 text-slate-900 shadow-xl">
            <div className="space-y-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Setup</p>
                <h2 className="mt-1 text-xl font-semibold text-slate-950">Capture options</h2>
              </div>

              <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <input
                  type="checkbox"
                  checked={recordCamera}
                  onChange={toggleRecordCamera}
                  className="mt-1 h-4 w-4 cursor-pointer rounded border-slate-300 text-sky-600"
                />
                <span>
                  <span className="block font-medium text-slate-950">Record camera</span>
                  <span className="block text-sm text-slate-500">Show a PiP camera overlay on the screen recording.</span>
                </span>
              </label>

              <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <input
                  type="checkbox"
                  checked={recordMic}
                  onChange={toggleRecordMic}
                  className="mt-1 h-4 w-4 cursor-pointer rounded border-slate-300 text-sky-600"
                />
                <span>
                  <span className="block font-medium text-slate-950">Record microphone</span>
                  <span className="block text-sm text-slate-500">Capture voice with echo cancellation and noise suppression.</span>
                </span>
              </label>

              <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div>
                  <h3 className="font-semibold text-slate-950">Recording quality</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    Variable bitrate keeps screen text sharp while avoiding oversized files.
                  </p>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Resolution</label>
                  <div className="grid grid-cols-2 gap-2">
                    {RECORDING_QUALITIES.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        disabled={isBusy}
                        onClick={() => setRecordingQuality(item.value)}
                        className={`rounded-2xl border px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
                          recordingQuality === item.value
                            ? "border-sky-500 bg-sky-50 text-sky-700"
                            : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Frame rate</label>
                  <div className="grid grid-cols-4 gap-2">
                    {RECORDING_FPS_OPTIONS.map((fps) => (
                      <button
                        key={fps}
                        type="button"
                        disabled={isBusy}
                        onClick={() => setRecordingFps(fps)}
                        className={`rounded-2xl border px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
                          recordingFps === fps
                            ? "border-sky-500 bg-sky-50 text-sky-700"
                            : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                        }`}
                      >
                        {fps}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Bitrate</label>
                  <div className="grid grid-cols-3 gap-2">
                    {Object.entries(BITRATE_PRESETS).map(([value, preset]) => (
                      <button
                        key={value}
                        type="button"
                        disabled={isBusy}
                        onClick={() => setBitratePreset(value)}
                        className={`rounded-2xl border px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
                          bitratePreset === value
                            ? "border-sky-500 bg-sky-50 text-sky-700"
                            : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                        } ${value === "custom" ? "col-span-3" : ""}`}
                        title={preset.description}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {bitratePreset === "custom" ? (
                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">
                      Video bitrate: {Number(customVideoBitrateMbps).toFixed(1)} Mbps
                    </label>
                    <input
                      type="number"
                      min="0.5"
                      step="0.5"
                      disabled={isBusy}
                      value={customVideoBitrateMbps}
                      onChange={(event) => setCustomVideoBitrateMbps(event.target.value)}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 disabled:opacity-60"
                    />
                  </div>
                ) : null}

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">
                    Audio bitrate: {audioBitrateKbps} kbps
                  </label>
                  <input
                    type="range"
                    min="48"
                    max="192"
                    step="16"
                    disabled={isBusy}
                    value={audioBitrateKbps}
                    onChange={(event) => setAudioBitrateKbps(event.target.value)}
                    className="w-full accent-sky-600 disabled:opacity-60"
                  />
                </div>

                <div className="rounded-2xl bg-white p-3 text-sm text-slate-600">
                  <div className="flex items-center justify-between">
                    <span>Estimated video bitrate</span>
                    <span className="font-semibold text-slate-950">{estimatedVideoBitrate.toFixed(1)} Mbps</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <span>Estimated storage</span>
                    <span className="font-semibold text-slate-950">{estimatedMegabytesPerMinute.toFixed(1)} MB/min</span>
                  </div>
                </div>
              </div>

              {recordCamera ? (
                <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-semibold text-slate-950">Camera overlay</h3>
                    <button
                      type="button"
                      onClick={updatePipVisibilityDuringRecording}
                      className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white transition hover:bg-slate-700"
                    >
                      {pipHidden ? "Show" : "Hide"}
                    </button>
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">Shape</label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { value: "circle", label: "Circle" },
                        { value: "square", label: "Square" },
                        { value: "rectangle", label: "Wide" },
                      ].map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => setPipShape(item.value)}
                          className={`rounded-2xl border px-3 py-2 text-sm font-medium transition ${
                            pipShape === item.value
                              ? "border-sky-500 bg-sky-50 text-sky-700"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                          }`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">
                      Position: {pipPosition}
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {PIP_POSITIONS.map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => setPipPosition(item.value)}
                          className={`rounded-xl border px-2 py-2 text-lg font-semibold transition ${
                            pipPosition === item.value
                              ? "border-sky-500 bg-sky-50 text-sky-700"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                          }`}
                          title={item.value}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-slate-500">You can also click the overlay grid on the preview while recording.</p>
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">Size: {pipSize}%</label>
                    <input
                      type="range"
                      min="10"
                      max="50"
                      value={pipSize}
                      onChange={(event) => setPipSize(event.target.value)}
                      className="w-full accent-sky-600"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">Opacity: {pipOpacity}%</label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={pipOpacity}
                      onChange={(event) => setPipOpacity(event.target.value)}
                      className="w-full accent-sky-600"
                    />
                  </div>

                  {/* Border radius control removed */}
                </div>
              ) : null}

              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                Screen capture uses the selected quality settings. Native and 60 FPS are larger; 1080p at 30 FPS is the best default for crisp recordings with sane file sizes.
              </div>

              <div className="flex gap-3">
                {!isBusy ? (
                  <button
                    type="button"
                    onClick={startRecording}
                    className="flex-1 rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                  >
                    Start recording
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={isPaused ? resumeRecording : pauseRecording}
                      className={`flex-1 rounded-2xl px-4 py-3 text-sm font-semibold text-white transition ${
                        isPaused ? "bg-emerald-600 hover:bg-emerald-500" : "bg-amber-500 hover:bg-amber-400"
                      }`}
                    >
                      {isPaused ? "Resume" : "Pause"}
                    </button>
                    <button
                      type="button"
                      onClick={stopRecording}
                      className="flex-1 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500"
                    >
                      Save
                    </button>
                  </>
                )}
              </div>

              {isBusy ? (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={handleRestart}
                    className="rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm font-semibold text-violet-700 transition hover:bg-violet-100"
                  >
                    Restart
                  </button>
                </div>
              ) : null}

              <div className="rounded-2xl bg-slate-100 p-4 text-sm text-slate-600">
                <div className="flex items-center justify-between">
                  <span>Status</span>
                  <span className="font-medium text-slate-900">{status}</span>
                </div>
                {isPaused && isRecording ? (
                  <p className="mt-2 text-amber-700">Recording is paused manually.</p>
                ) : null}
                {error ? <p className="mt-2 text-rose-600">{error}</p> : null}
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <div className="overflow-hidden rounded-3xl border border-white/10 bg-black shadow-2xl ring-1 ring-white/10">
              <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/40 px-4 py-3 text-sm text-slate-200">
                <div>
                  <p className="font-semibold text-white">Live preview</p>
                  <p className="text-xs text-slate-400">This shows the screen stream plus camera overlay during recording.</p>
                </div>
                <div className={`rounded-full px-3 py-1 text-xs font-semibold ${isRecording ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-700 text-slate-300"}`}>
                  {isPaused ? "Paused" : isRecording ? "Recording" : "Idle"}
                </div>
              </div>

              <div className="relative aspect-video bg-slate-950">
                <video
                  ref={screenPreviewRef}
                  autoPlay
                  muted
                  playsInline
                  className="absolute inset-0 h-full w-full object-cover"
                />

                {!isBusy ? (
                  <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.12),transparent_40%)] px-8 text-center">
                    <div className="max-w-lg rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                      <p className="text-lg font-semibold text-white">Preview will appear here when recording starts.</p>
                      <p className="mt-2 text-sm text-slate-300">
                        The screen stream should appear immediately after capture begins. If camera is enabled, its preview is layered on top and can be repositioned live.
                      </p>
                    </div>
                  </div>
                ) : null}

                {recordCamera && cameraStream ? (
                  <div
                    className={`absolute ${overlayPositionClass(pipPosition)} z-20 overflow-hidden shadow-2xl ring-2 ring-white/70 ${pipShape === "circle" ? "rounded-full" : "rounded-none"}`}
                    style={{
                      width: `${pipSize}%`,
                      opacity: pipOpacity / 100,
                      aspectRatio: pipShape === "rectangle" ? "16 / 9" : "1 / 1",
                      display: pipHidden ? "none" : "block",
                    }}
                  >
                    <video
                      ref={cameraPreviewRef}
                      autoPlay
                      muted
                      playsInline
                      className={`h-full w-full object-cover ${pipShape === "circle" ? "rounded-full" : "rounded-none"}`}
                    />
                  </div>
                ) : null}

                {recordCamera && pipShape !== "rectangle" ? (
                  <div className="absolute inset-0 z-30 grid grid-cols-3 grid-rows-3">
                    {PIP_POSITIONS.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => updatePipPositionDuringRecording(item.value)}
                        className="border border-transparent bg-transparent transition hover:bg-white/10 focus:bg-white/10"
                        aria-label={`Move camera to ${item.value}`}
                      />
                    ))}
                  </div>
                ) : null}

                <div className="absolute left-4 top-4 z-40 flex items-center gap-2 rounded-full bg-rose-600 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-white shadow-lg">
                  <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                  {isPaused ? "Paused" : isRecording ? "Live" : "Ready"}
                </div>
              </div>
            </div>

            {videoUrl ? (
              <div className="rounded-3xl border border-slate-200 bg-white p-4 text-slate-900 shadow-xl">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-slate-950">Saved recording</h3>
                    <p className="text-sm text-slate-500">The last finished recording is ready to review below.</p>
                  </div>
                </div>
                <video src={videoUrl} controls className="mt-4 w-full rounded-2xl bg-black shadow-lg" />
              </div>
            ) : null}
          </section>
        </main>
      </div>
    </div>
  );
}

export default App;
