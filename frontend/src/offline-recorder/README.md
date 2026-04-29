# Offline Recorder Reference Copy

This folder is a structured copy of the local Screenity recorder stack.

## Layout

- `recorder/`
  - main local recorder runtime
  - capture, stream composition, encoder selection, chunk persistence
- `background/recording/`
  - background service-worker orchestration for local recording
  - recorder tab startup, message routing, stop flow, chunk delivery
- `content/`
  - on-page recording UI
  - toolbar, canvas annotations, camera overlay, countdown, region helpers
- `sandbox/`
  - local rebuild, preview, and post-stop editor/viewer handoff state
- `editor/`
  - legacy local editing/export helpers
- `editor-webcodecs/`
  - newer WebCodecs and MediaBunny-based local editing/export helpers
- `shared/pages-utils/`
  - shared recorder-related page utilities
- `shared/media/`
  - shared media helpers like fast recorder capability gating

## Best Starting Points

- local recorder core: `recorder/Recorder.jsx`
- direct MP4 path: `recorder/webcodecs/WebCodecsRecorder.js`
- MP4 muxer: `recorder/webcodecs/Mp4MuxerWrapper.ts`
- start flow: `background/recording/startRecording.js`
- stop/editor flow: `background/recording/stopRecording.js`
- on-page controls: `content/context/ContentState.jsx`
- local rebuild/edit flow: `sandbox/context/ContentState.jsx`

## Notes

- This is a copied reference set, not a rewired runnable package.
- Imports still point to their original Screenity-relative structure.
- Use this folder for reading, extraction, porting, and architecture review.
