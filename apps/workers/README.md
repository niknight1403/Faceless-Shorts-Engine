# Workers

Redis-backed workers own long-running generation and rendering tasks. Jobs must be idempotent, retryable and observable; provider failures must never be reported as successful output.

## Video generation pipeline

The worker now executes script generation → per-scene TTS → per-scene visual generation → vertical MP4 rendering. It stores scene audio, scene images, an SRT caption track, and `final.mp4` as Prisma assets under `MEDIA_STORAGE_DIR/<job-id>/`. A job is marked `COMPLETED` only after FFmpeg has produced a non-empty MP4; provider or render errors leave a specific failure code.

### Runtime requirements

- Install FFmpeg with the `libx264` and AAC encoders in the worker runtime. Set `FFMPEG_BIN` if the executable is not named `ffmpeg`.
- Set `MEDIA_STORAGE_DIR` to persistent storage shared with the API process that serves assets. The default `./data/media` is suitable only when both processes share the same filesystem.
- Visuals use the anonymous Pollinations image endpoint (`image.pollinations.ai`) and require outbound HTTPS access. It is a best-effort free route with external rate limits and availability; no API key is required.
- TTS still requires at least one configured route. `TTS_AI_ENABLED=true` enables the anonymous TTS.ai fallback; its upstream service may rate-limit or change availability.

Captions are burned into each scene during rendering and the complete SRT file is also stored as a separate caption asset. The worker requires an FFmpeg build with the `subtitles` filter (libass), in addition to `libx264` and AAC. The video itself is a 720×1280, 30 FPS H.264/AAC MP4.
