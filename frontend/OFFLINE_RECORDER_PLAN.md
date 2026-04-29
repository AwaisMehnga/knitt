# Offline Recorder Implementation Plan

1. Define the final scope of your custom recorder and remove everything that is outside that scope.

2. Keep only the files needed for the local recorder path:
   - recorder core
   - background recording flow
   - content overlays
   - sandbox/editor
   - shared recorder helpers

3. Start with the recorder runtime shell:
   - `src/offline-recorder/recorder/Recorder.jsx`
   - `src/offline-recorder/recorder/RecorderUI.jsx`
   - `src/offline-recorder/recorder/messaging.js`
   - `src/offline-recorder/recorder/recorderConfig.js`

4. Make the recorder start and stop with hardcoded local state only.

5. Implement the background startup flow:
   - `src/offline-recorder/background/recording/startRecording.js`
   - `src/offline-recorder/background/recording/openRecorderTab.js`
   - `src/offline-recorder/background/recording/sendMessageRecord.js`
   - `src/offline-recorder/background/recording/getStreamingData.js`

6. Make the recorder open correctly and receive its initial recording config.

7. Implement screen/tab/camera stream acquisition inside the recorder core.

8. Implement microphone acquisition and device fallback.

9. Build the final composed `liveStream`:
   - primary video track
   - mixed audio track from mic and system audio

10. Add volume control for:
   - mic input
   - system/tab audio

11. Implement the basic recording flow with `MediaRecorder` only.

12. Add chunk persistence to IndexedDB/localforage.

13. Implement recorder stop, chunk flush, and rebuild-from-chunks flow.

14. Implement background chunk transport:
   - `src/offline-recorder/background/recording/chunkHandler.js`
   - `src/offline-recorder/background/recording/sendChunks.js`

15. Make the local sandbox receive chunks and rebuild a playable blob.

16. Implement the post-stop local flow:
   - `src/offline-recorder/background/recording/stopRecording.js`
   - `src/offline-recorder/sandbox/context/ContentState.jsx`

17. Add local preview/player support in the sandbox.

18. Add pause and resume support in the recorder and the content controls.

19. Add restart support in the recorder and background flow.

20. Add error handling for:
   - no stream
   - no tracks
   - mic unavailable
   - quota/storage failure
   - empty recorder chunks

21. Add keepalive handling so the recorder does not freeze during long recordings.

22. Add the direct MP4 fast path:
   - `src/offline-recorder/recorder/webcodecs/WebCodecsRecorder.js`
   - `src/offline-recorder/recorder/webcodecs/Mp4MuxerWrapper.ts`
   - `src/offline-recorder/shared/media/fastRecorderGate.ts`

23. Make encoder selection switch between:
   - WebCodecs MP4
   - MediaRecorder fallback

24. Validate the fast-recorder output and keep fallback behavior when it fails.

25. Add content-side recording state control:
   - `src/offline-recorder/content/context/ContentState.jsx`
   - `src/offline-recorder/content/context/messaging/handlers.js`

26. Add countdown handling before recording start.

27. Add recording toolbar controls:
   - start
   - stop
   - pause
   - resume
   - mic toggle
   - camera toggle

28. Add the content-side camera overlay.

29. Add the content-side annotation canvas.

30. Add drawing tools one by one:
   - pen
   - arrow
   - shapes
   - text
   - eraser
   - select

31. Add toolbar positioning, hiding, and interaction polish.

32. Add region recording support after the normal recorder path is stable.

33. Add region UI helpers:
   - region box
   - resize handles
   - region dimensions

34. Add cursor effects, click tracking, blur, and zoom after the core recorder is stable.

35. Add editor handoff modes:
   - normal editor
   - viewer-only fallback
   - fast local editor path

36. Add local editing/export support in this order:
   - trim
   - crop
   - mute
   - re-encode
   - frame extraction
   - GIF

37. Add MP4 and WebM export support.

38. Remove every copied file that is no longer used by your final custom flow.

39. Remove every feature branch you decided not to support.

40. Clean imports, folder structure, and dead helpers.

41. Rename files and folders into your final project naming.

42. Do one full pass to make the recorder work end to end:
   - start
   - capture
   - mix audio
   - encode
   - stop
   - rebuild
   - preview
   - edit
   - export

43. End with a final cleanup pass where only the files required for your custom offline recorder remain.
