# Screenity Local Recorder Architecture

This document explains the local extension recorder only.

It covers:

- screen, tab, window, and camera capture
- microphone and system-audio handling
- annotation and recording controls shown on the page
- preview and post-stop editor flow
- encoding paths
- MP4/WebM conversion paths
- helper files, classes, and important methods

It does not cover:

- cloud upload, server streaming, Bunny/TUS flows
- backend project processing

## Scope

The local recorder is the free, extension-side recording pipeline that records into IndexedDB first, then opens a local editor/viewer after stop.

Main runtime areas:

- Recorder tab or offscreen recorder host
- Content script overlays on the recorded page
- Background service worker orchestration
- Local sandbox/editor for rebuild, preview, edit, and export

## High-Level Flow

1. The content popup or content UI asks the background worker to start recording.
2. The background worker opens `recorder.html` and stores the recorder tab id.
3. The recorder tab receives the recording request and asks background for capture settings.
4. The recorder builds a final `liveStream`:
   - one video track from screen/tab/camera
   - one mixed audio track from mic and optional system/tab audio
5. The recorder starts one of two engines:
   - `WebCodecsRecorder` for direct fragmented MP4
   - `MediaRecorder` fallback for browser-native chunk recording
6. Chunks are persisted into IndexedDB.
7. On stop, the background opens:
   - `editorwebcodecs.html` for modern local conversion/edit path
   - `editor.html` for FFmpeg fallback
   - `editorviewer.html` for large/no-edit fallback
8. The sandbox/editor rebuilds the local file from IndexedDB chunks, previews it, and runs edits/export.

## Main Entry Points

### Recorder runtime

- `screenity/src/pages/Recorder/Recorder.jsx`
- `screenity/src/pages/Recorder/RecorderUI.jsx`
- `screenity/src/pages/Recorder/messaging.js`
- `screenity/src/pages/Recorder/mediaRecorderUtils.js`
- `screenity/src/pages/Recorder/recorderConfig.js`
- `screenity/src/pages/Recorder/webcodecs/WebCodecsRecorder.js`
- `screenity/src/pages/Recorder/webcodecs/Mp4MuxerWrapper.ts`

### Background orchestration

- `screenity/src/pages/Background/recording/startRecording.js`
- `screenity/src/pages/Background/recording/openRecorderTab.js`
- `screenity/src/pages/Background/recording/sendMessageRecord.js`
- `screenity/src/pages/Background/recording/getStreamingData.js`
- `screenity/src/pages/Background/recording/chunkHandler.js`
- `screenity/src/pages/Background/recording/sendChunks.js`
- `screenity/src/pages/Background/recording/stopRecording.js`

### Content-side recording UI and annotations

- `screenity/src/pages/Content/Content.jsx`
- `screenity/src/pages/Content/Wrapper.jsx`
- `screenity/src/pages/Content/context/ContentState.jsx`
- `screenity/src/pages/Content/context/messaging/handlers.js`
- `screenity/src/pages/Content/toolbar/`
- `screenity/src/pages/Content/canvas/`
- `screenity/src/pages/Content/camera/`
- `screenity/src/pages/Content/countdown/Countdown.jsx`
- `screenity/src/pages/Content/utils/ZoomContainer.jsx`
- `screenity/src/pages/Content/utils/BlurTool.jsx`
- `screenity/src/pages/Content/utils/CursorModes.jsx`
- `screenity/src/pages/Content/cursor/trackClicks.js`

### Local preview/edit/export

- `screenity/src/pages/Sandbox/context/ContentState.jsx`
- `screenity/src/pages/Sandbox/`
- `screenity/src/pages/Editor/`
- `screenity/src/pages/EditorWebCodecs/`

## Recorder Core

## `Recorder.jsx`

This is the main local recorder controller.

Responsibilities:

- receives start/stop/pause/resume/mic-volume messages
- acquires capture streams
- builds the composed stream used for recording
- selects WebCodecs vs MediaRecorder
- persists chunks to IndexedDB
- handles stop/finalize/restart
- keeps the recorder tab alive during capture

Important refs/state:

- `helperVideoStream`: raw capture stream from screen/tab/camera
- `helperAudioStream`: raw microphone stream
- `liveStream`: final composed recording stream
- `aCtx`, `destination`: Web Audio mix graph
- `audioInputGain`, `audioOutputGain`: mic/system volume controls
- `recorder`: active encoder instance
- `useWebCodecs`: whether the fast MP4 path is active

Important methods:

- `requestStart()`
  - start gate for delayed capture readiness
- `tryStartIfReady()`
  - starts once the stream is live
- `startStreaming(data)`
  - decides whether to capture camera, tab, or desktop
- `startStream(data, id, options, permissions, permissions2)`
  - acquires the real media streams and builds `liveStream`
- `startAudioStream(id)`
  - gets the microphone stream with device-id fallback logic
- `startRecording()`
  - clears chunk store, computes bitrate/fps, selects encoder path, starts recorder
- `warmUpStream(liveStream)`
  - waits for real video/audio frames before recording
- `saveChunk()` / `drainQueue()`
  - persist chunks safely to IndexedDB
- `rebuildBlobFromChunks()`
  - rebuilds the local recording from chunk storage
- `stopRecording()`
  - flushes/finalizes encoders and tears down streams
- `restartRecording()`
  - reset and start again without losing the session flow
- `setAudioInputVolume()` / `setAudioOutputVolume()`
  - controls mic/system audio levels
- `setMic()`
  - toggles mic via gain, not by stopping the track

## Capture: Screen, Tab, Window, Camera

### Screen/tab/window capture

For the local recorder, capture is created inside `startStream()` in `Recorder.jsx`.

Source selection comes from background:

- background opens recorder tab
- background sends `loaded`
- recorder asks background for current capture config
- background responds with `streaming-data`

The recorder then uses:

- `navigator.mediaDevices.getUserMedia(...)` with Chrome desktop/tab constraints for desktop and tab capture
- `getUserMediaWithFallback(...)` for camera and mic device-id fallback

The main captured surface stream is stored in:

- `helperVideoStream.current`

### Camera-only recording

For recording type `camera`, camera `getUserMedia` becomes the primary video stream.

That camera stream goes directly into `helperVideoStream`, then into `liveStream`.

### Region capture

Region capture is handled by a separate page, `screenity/src/pages/Region/Recorder.jsx`.

This README focuses on the local recorder page in `screenity/src/pages/Recorder/`, but content-side region overlay helpers still participate in local recording UX.

## Audio: Mic and System Audio

The local recorder mixes audio with Web Audio.

Graph:

- raw system/tab audio -> `audioOutputGain` -> `MediaStreamDestination`
- raw mic audio -> `audioInputGain` -> `MediaStreamDestination`
- destination output track -> added to `liveStream`

This means recording uses a single mixed audio track, not separate mic/system tracks.

### Mic cleanup

There is no custom denoise pipeline in the local recorder code.

What it does:

- acquires mic using `getUserMedia`
- uses gain nodes to mute/unmute or adjust levels
- relies on browser/device capture behavior for echo/noise processing

What it does not do:

- no `AudioWorklet`
- no compressor/noise gate chain
- no custom denoiser
- no custom echo cancellation stage

## Composed Recording Stream

The final stream used by encoders is `liveStream`.

It contains:

- exactly one video track
- zero or one mixed audio track

Construction steps:

1. create `AudioContext`
2. create `MediaStreamDestination`
3. add system audio source if present
4. add mic source if present
5. add video track from `helperVideoStream`
6. add mixed destination audio track if present

This is the final stream sent to:

- `WebCodecsRecorder`
- or `MediaRecorder`

## Encoding Paths

## Path A: `WebCodecsRecorder` fast path

Files:

- `screenity/src/pages/Recorder/webcodecs/WebCodecsRecorder.js`
- `screenity/src/pages/Recorder/webcodecs/Mp4MuxerWrapper.ts`
- `screenity/src/media/fastRecorderGate.ts`

What it does:

- uses `MediaStreamTrackProcessor` to read raw `VideoFrame` and `AudioData`
- uses `VideoEncoder` for H.264/AVC
- uses `AudioEncoder` for AAC
- uses MediaBunny to mux directly into fragmented MP4

Key class:

- `WebCodecsRecorder`

Important methods:

- `start()`
  - probes track resolution
  - selects video encoder config
  - probes AAC support
  - creates processors, readers, muxer, encoders
  - starts video and audio read loops
- `chooseVideoEncoderConfig({ width, height, fps, bitrate })`
  - tries supported H.264 encoder profiles
- `prepareAudioEncoderConfig()`
  - probes AAC support and sample rate/channel config
- `initVideoEncoder()`
- `initAudioEncoder()`
- `readVideoLoop()`
  - reads frames
  - draws to a resize canvas
  - creates monotonic timestamps
  - inserts keyframes periodically
  - drops/skips frames when the tab falls behind
- `readAudioLoop()`
  - reads `AudioData`
  - writes monotonic timestamps from sample count
  - drops audio while paused
- `pause()` / `resume()`
  - pause bookkeeping
- `stop()`
  - flush encoders
  - pads trailing video frames so audio does not outlast video visually
  - finalizes muxer

### Why the resize canvas exists

`WebCodecsRecorder` always draws captured frames onto an internal canvas before encoding.

Reasons:

- normalize output resolution
- avoid odd frame-size issues
- keep encoder input stable

### What MP4 is produced here

This path records to fragmented MP4 during recording, not after.

`Mp4MuxerWrapper` writes MP4 fragments continuously, buffers writes to reduce IndexedDB churn, and emits byte-order-correct MP4 chunks.

Key class:

- `Mp4MuxerWrapper`

Important methods:

- `start()`
- `enableAudio()`
- `addVideoChunk()`
- `addAudioChunk()`
- `bufferWrite()`
- `flushWriteBuffer()`
- `finalize()`
- `flushPending()`
- `buildPacket()`
- `normalizeTimestamp()`

## Path B: `MediaRecorder` fallback

Files:

- `screenity/src/pages/Recorder/mediaRecorderUtils.js`
- `screenity/src/pages/Recorder/recorderConfig.js`

What it does:

- creates a browser `MediaRecorder` on `liveStream`
- records with supported WebM-style MIME types
- emits chunks on a timeslice
- stores those chunks into IndexedDB

Helper functions:

- `createMediaRecorder(stream, { audioBitsPerSecond, videoBitsPerSecond })`
- `MIME_TYPES`
- `getBitrates(quality)`
- `getResolutionForQuality(qualityValue)`

Recorder-side callback handling:

- `ondataavailable`
- `onstop`
- `onerror`

## Fast Recorder Gate

File:

- `screenity/src/media/fastRecorderGate.ts`

Purpose:

- probe browser/device support for WebCodecs recording
- choose whether the fast local MP4 path should be used
- persist sticky disable state when a device repeatedly fails
- validate final fast-recorder output

Important helpers:

- `probeFastRecorderSupport()`
- `shouldUseFastRecorder(...)`
- `getFastRecorderStickyState()`
- `markFastRecorderFailure(...)`
- `validateFastRecorderOutputBlob(...)`

## Recorder UI

## `RecorderUI.jsx`

This is the lightweight recorder tab UI.

It shows:

- preparing/selecting message
- warning state
- branded background

It does not contain the recording logic itself.

## Background: Start, Route, Stop

## `startRecording.js`

Purpose:

- starts a new local recording attempt
- initializes diagnostics
- stores metadata like recording type, tab domain, alarm state
- sends `start-recording-tab` to the recorder tab

Important functions:

- `startRecording()`
- `startAfterCountdown()`

## `openRecorderTab.js`

Purpose:

- opens `recorder.html`
- stores `recordingTab`
- pins the tab
- disables `autoDiscardable`
- sends the initial `loaded` message

Important functions:

- `openRecorderTab(...)`
- `startRecorderSession(...)`

## `sendMessageRecord.js`

Purpose:

- routes messages to the active recorder host
- handles normal recorder tab or offscreen recorder host

Important function:

- `sendMessageRecord(message, responseCallback)`

## `getStreamingData.js`

Purpose:

- reads recording config from storage for the recorder

Returns:

- `micActive`
- `defaultAudioInput`
- `defaultAudioOutput`
- `defaultVideoInput`
- `systemAudio`
- `recordingType`

## `stopRecording.js`

Purpose:

- runs after recorder says `video-ready`
- decides which local editor/viewer to open
- routes free recordings to:
  - `editorwebcodecs.html`
  - `editor.html`
  - `editorviewer.html`

Important behavior:

- if fast recorder was in use and valid, prefer `editorwebcodecs.html`
- otherwise use FFmpeg/editor fallback
- for long recordings, open viewer mode

## Chunk Storage and Transport

## Recorder-side storage

The recorder writes chunks into IndexedDB via `localforage`.

Store:

- `chunks`

Chunk persistence in the recorder exists to:

- survive tab crashes better
- allow post-stop reconstruction
- enable editor handoff after recorder stop

## Background chunk transport

Files:

- `screenity/src/pages/Background/recording/chunkHandler.js`
- `screenity/src/pages/Background/recording/sendChunks.js`

Responsibilities:

- read persisted chunks from IndexedDB
- serialize chunk sending to prevent interleaving
- batch chunks and send them to the sandbox/editor tab
- trigger `make-video-tab` once delivery completes

Important functions:

- `handleChunks(chunks, override, target)`
- `sendChunks(override, target)`
- `clearAllRecordings()`
- `newChunk(...)`

## Content-Side Recording UX

The content script is the on-page recording UI.

It is not the actual video encoder, but it drives:

- countdown
- toolbar controls
- canvas annotations
- camera overlay
- zoom/blur/cursor effects
- stop/pause/resume
- click tracking metadata

## `Content.jsx`

Mounts the content-side UI shell and shadow-DOM styling.

## `Wrapper.jsx`

This is the content-side composition shell.

It mounts:

- popup container
- toolbar
- camera overlay
- drawing canvas
- countdown
- region overlay
- utility effects

It also:

- mounts a hidden permissions iframe
- mounts a hidden recorder/region iframe
- starts click tracking while recording

## `Content/context/ContentState.jsx`

This is the main state controller for the recording overlay.

Responsibilities:

- stores recording UI state
- syncs with extension storage
- starts, pauses, resumes, stops, and restarts local sessions from the UI side
- manages countdown state
- manages camera/mic toggles and toolbar state
- initializes message handlers

Important functions:

- `startRecording()`
- `restartRecording()`
- `stopRecording()`
- pause/resume helpers that send background messages
- storage hydration through `updateFromStorage(...)`

Important helper files used by content state:

- `screenity/src/pages/Content/context/utils/updateFromStorage.js`
- `screenity/src/pages/Content/context/utils/checkRecording.js`
- `screenity/src/pages/Content/context/utils/checkAuthStatus.js`
- `screenity/src/pages/Content/context/messaging/handlers.js`

## `Content/context/messaging/handlers.js`

Registers content-side message handlers.

For the local recorder path, it is important because it reacts to:

- recording status changes
- preparation state
- post-stop local playback handoff
- editor handoff support messages

Main exported setup function:

- `setupHandlers()`

## Toolbar, Controls, Annotations, Camera Overlay

## Toolbar

Files:

- `screenity/src/pages/Content/toolbar/Toolbar.jsx`
- `screenity/src/pages/Content/toolbar/layout/ToolbarWrap.jsx`
- `screenity/src/pages/Content/toolbar/layout/DrawingToolbar.jsx`
- `screenity/src/pages/Content/toolbar/layout/ShapeToolbar.jsx`
- `screenity/src/pages/Content/toolbar/layout/BlurToolbar.jsx`
- `screenity/src/pages/Content/toolbar/layout/CursorToolbar.jsx`

Purpose:

- stop/pause/resume recording
- toggle drawing/blur/cursor modes
- toggle camera and mic state
- reposition or hide the toolbar

Notable components/helpers:

- `MicToggle.jsx`
- `ToolTrigger.jsx`
- `RadialMenu.jsx`
- `Toast.jsx`
- `TooltipWrap.jsx`
- `ColorWheel.jsx`
- `StrokeWeight.jsx`

## Canvas annotations

Files:

- `screenity/src/pages/Content/canvas/Canvas.jsx`
- `screenity/src/pages/Content/canvas/layout/CanvasWrap.jsx`
- `screenity/src/pages/Content/canvas/layout/TextToolbar.jsx`

Tool modules:

- `ArrowTool.jsx`
- `PenTool.jsx`
- `ShapeTool.jsx`
- `TextTool.jsx`
- `ImageTool.jsx`
- `EraserTool.jsx`
- `SelectTool.jsx`
- `History.jsx`
- `CustomControls.jsx`

Purpose:

- draw on the recorded page during recording
- keep annotation state in a fixed overlay canvas
- provide shape/text/image editing helpers

This annotation layer is visual UX on the page. The actual recorder still captures the underlying page/tab/screen stream. Whether the annotation overlay is present in the captured pixels depends on the capture mode and how the page is being captured.

## Camera overlay

Files:

- `screenity/src/pages/Content/camera/Camera.jsx`
- `screenity/src/pages/Content/camera/layout/CameraWrap.jsx`
- `screenity/src/pages/Content/camera/layout/CameraToolbar.jsx`
- `screenity/src/pages/Content/camera/components/ResizeHandle.jsx`

Purpose:

- floating on-page camera bubble/window
- drag/resize camera preview
- on-page camera controls

## Region helpers

Files:

- `screenity/src/pages/Content/region/Region.jsx`
- `screenity/src/pages/Content/region/components/RegionHandles.jsx`
- `screenity/src/pages/Content/region/layout/CameraWrap.jsx`
- `screenity/src/pages/Content/region/layout/CameraToolbar.jsx`

These are local recording UX helpers for region selection and related overlays.

## Countdown, Zoom, Blur, Cursor Effects

Files:

- `screenity/src/pages/Content/countdown/Countdown.jsx`
- `screenity/src/pages/Content/utils/ZoomContainer.jsx`
- `screenity/src/pages/Content/utils/BlurTool.jsx`
- `screenity/src/pages/Content/utils/CursorModes.jsx`
- `screenity/src/pages/Content/cursor/trackClicks.js`

Purpose:

- countdown before actual recording starts
- visual zoom effect
- blur tool overlays
- cursor mode overlays and click event tracking

## Local Preview, Edit, and Export

## Sandbox/editor entry

Files:

- `screenity/src/pages/Sandbox/context/ContentState.jsx`
- `screenity/src/pages/Sandbox/Sandbox.jsx`

Responsibilities:

- receive `fallback-recording` / `viewer-recording`
- rebuild the video from IndexedDB chunks
- gate opening until finalize status is ready for post-stop mode
- manage preview/edit state
- hand off to player/editor UI

Important sandbox behaviors:

- rebuild chunks into one blob
- detect whether FFmpeg or fallback editing is available
- expose ready state and processing progress

## Legacy FFmpeg editor

Files:

- `screenity/src/pages/Editor/`

Helper utilities:

- `addAudioToVideo.js`
- `cutVideo.js`
- `cropVideo.js`
- `reencodeVideo.js`
- `muteVideo.js`
- `toWebM.js`
- `toGIF.js`
- `getFrame.js`
- `hasAudio.js`
- `blobToArrayBuffer.js`
- `base64toBlob.js`

Purpose:

- older in-browser editing/export path
- FFmpeg-based operations when WebCodecs path is not used

## Newer WebCodecs/MediaBunny editor

Files:

- `screenity/src/pages/EditorWebCodecs/`
- `screenity/src/pages/EditorWebCodecs/mediabunny/lib/videoConverter.ts`
- `screenity/src/pages/EditorWebCodecs/mediabunny/lib/videoAudioMixer.ts`
- `screenity/src/pages/EditorWebCodecs/mediabunny/lib/videoMuter.ts`
- `screenity/src/pages/EditorWebCodecs/mediabunny/lib/videoTrimmer.ts`
- `screenity/src/pages/EditorWebCodecs/mediabunny/lib/videoCropper.ts`
- `screenity/src/pages/EditorWebCodecs/mediabunny/lib/videoCutter.ts`

Purpose:

- client-side edit/export without the legacy FFmpeg-first flow
- modern conversion/remuxing path

Important class:

- `VideoConverter`

Important methods:

- `convertToMP4(sourceBlob, options)`
- `convertToWebM(sourceBlob, options)`
- `detectBestCodec(format)`
- `canEncodeCodec(codec)`

### MP4 conversion

There are two ways MP4 appears in the local recorder flow:

1. Direct during recording
   - from `WebCodecsRecorder` + `Mp4MuxerWrapper`
2. After recording
   - from MediaBunny or FFmpeg-based editor conversion of fallback chunks

So the local recorder is not always “record WebM then convert”.

It is:

- direct MP4 on supported devices
- fallback recording plus later conversion on unsupported devices

## Helper and Support Files

### Recorder helpers

- `screenity/src/pages/Recorder/messaging.js`
  - `sendRecordingError(...)`
  - `sendStopRecording(...)`
- `screenity/src/pages/Recorder/mediaRecorderUtils.js`
  - `createMediaRecorder(...)`
- `screenity/src/pages/Recorder/recorderConfig.js`
  - `MIME_TYPES`
  - `getBitrates(...)`
  - `getResolutionForQuality(...)`

### Shared media helper

- `screenity/src/pages/utils/mediaDeviceFallback.js`
  - `getUserMediaWithFallback(...)`
  - retries device selection by label when stored device ids go stale

### Recorder host helper

- `screenity/src/pages/utils/recordingHost.js`
  - host detection for recorder tab vs offscreen host

### Error and diagnostics helpers

- `screenity/src/pages/utils/errorCodes.js`
- `screenity/src/pages/utils/recordingDebug.js`
- `screenity/src/pages/utils/diagnosticLog.js`
- `screenity/src/pages/utils/startFlowTrace.js`
- `screenity/src/pages/utils/diagForward.js`

These do not record video directly, but they are used heavily to control recorder behavior, error routing, and post-stop readiness.

## What Is Used Where

### If you want to understand capture setup

Start here:

- `Recorder.jsx`
- `startStreaming(...)`
- `startStream(...)`
- `startAudioStream(...)`

### If you want to understand final composed stream creation

Start here:

- `Recorder.jsx`
- the `AudioContext` / `MediaStreamDestination` setup
- the `liveStream.current.addTrack(...)` calls

### If you want to understand direct MP4 recording

Start here:

- `fastRecorderGate.ts`
- `WebCodecsRecorder.js`
- `Mp4MuxerWrapper.ts`

### If you want to understand fallback recording

Start here:

- `mediaRecorderUtils.js`
- `Recorder.jsx` MediaRecorder branch
- `recorderConfig.js`

### If you want to understand local chunk persistence and transfer

Start here:

- `Recorder.jsx`
- `chunkHandler.js`
- `sendChunks.js`
- `Sandbox/context/ContentState.jsx`

### If you want to understand on-page controls and annotation

Start here:

- `Content/context/ContentState.jsx`
- `Wrapper.jsx`
- `toolbar/layout/ToolbarWrap.jsx`
- `canvas/layout/CanvasWrap.jsx`
- `camera/layout/CameraWrap.jsx`
- `Countdown.jsx`

### If you want to understand local editing/export

Start here:

- `Background/recording/stopRecording.js`
- `Sandbox/context/ContentState.jsx`
- `EditorWebCodecs/mediabunny/lib/videoConverter.ts`
- `Editor/utils/*`

## Practical Reading Order

Recommended order for understanding the whole local recorder:

1. `screenity/src/pages/Background/recording/startRecording.js`
2. `screenity/src/pages/Background/recording/openRecorderTab.js`
3. `screenity/src/pages/Recorder/Recorder.jsx`
4. `screenity/src/pages/Recorder/webcodecs/WebCodecsRecorder.js`
5. `screenity/src/pages/Recorder/webcodecs/Mp4MuxerWrapper.ts`
6. `screenity/src/pages/Background/recording/chunkHandler.js`
7. `screenity/src/pages/Background/recording/stopRecording.js`
8. `screenity/src/pages/Sandbox/context/ContentState.jsx`
9. `screenity/src/pages/EditorWebCodecs/mediabunny/lib/videoConverter.ts`
10. `screenity/src/pages/Content/context/ContentState.jsx`
11. `screenity/src/pages/Content/Wrapper.jsx`
12. `screenity/src/pages/Content/toolbar/`, `canvas/`, and `camera/`

## Summary

The local recorder is built around one composed `MediaStream` plus two encoding strategies.

- Capture and composition live in `Recorder.jsx`
- direct MP4 recording lives in `WebCodecsRecorder.js` and `Mp4MuxerWrapper.ts`
- fallback recording lives in `MediaRecorder` helpers inside `Recorder.jsx`
- chunk persistence and editor handoff live in background recording helpers
- on-page controls, annotations, countdown, cursor effects, and camera preview live in `Content/`
- local preview/edit/export live in `Sandbox/`, `Editor/`, and `EditorWebCodecs/`

The most important architectural fact is this:

- local recording always builds one final stream first
- then it chooses the encoder path
- then it persists chunks locally
- then a local editor rebuilds and exports the result
