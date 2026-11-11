# Free Route Hunter

The worker uses a free-only provider cascade. Local Ollama is first when `OLLAMA_MODEL` is configured, followed by Groq, Gemini API, Cloudflare Workers AI and OpenRouter Free. Providers without credentials are skipped. Custom OpenAI-compatible routes can be added with `FREE_LLM_CUSTOM_ROUTES`; each entry must explicitly set `free: true`.

OpenRouter is accepted only with `openrouter/free` or a model ID ending in `:free`. Never set a paid model ID. Cloud provider quotas are finite and account-specific; the router records latency, failures, 429 cooldowns and remaining-request headers when supplied. It does not purchase credits or retry through paid routes.

## LLM environment

- `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434/v1`), `OLLAMA_MODEL`
- `GROQ_API_KEY`, optional `GROQ_MODEL`
- `GEMINI_API_KEY`, optional `GEMINI_MODEL`
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, optional `CLOUDFLARE_AI_MODEL`
- `OPENROUTER_API_KEY`, optional `OPENROUTER_MODEL` (must be `openrouter/free` or end in `:free`)
- `FREE_LLM_CUSTOM_ROUTES`: JSON array of `{id,baseUrl,model,apiKeyEnv?,priority?,free:true}`

## Free TTS cascade

1. Local Piper when `PIPER_MODEL` points to an installed voice model (optional `PIPER_BIN`).
2. A local OpenAI-compatible Kokoro server when `KOKORO_TTS_BASE_URL` and `KOKORO_TTS_VOICE` are set.
3. TTS.ai anonymous free Piper endpoint (enabled by default; disable with `TTS_AI_ENABLED=false`; optional `TTS_AI_VOICE`, default `de_DE-thorsten-medium`).

TTS.ai anonymous requests are limited to 500 characters per call and 5,000 characters/day per IP according to its current published documentation. Keep narration chunks within the per-request limit. Local Piper/Kokoro remain the no-cloud fallback. Provider/model availability and licensing must be checked before commercial publication.

## Security

Only server-side environment variables are read. Never put provider keys in the mobile app, logs, or committed environment files. Free quotas are not unlimited and may change; the router does not upgrade accounts or silently spend money.
