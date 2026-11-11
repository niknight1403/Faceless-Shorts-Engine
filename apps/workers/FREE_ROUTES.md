# Free Route Hunter

The worker uses a free-only provider cascade: local Ollama first, then opt-in Cerebras Free Trial, Groq, Gemini API, Cloudflare Workers AI and OpenRouter Free. Providers without credentials are skipped. Additional OpenAI-compatible providers (for example Cohere or Novita, when their account actually has a no-cost quota) can be added with `FREE_LLM_CUSTOM_ROUTES`; each entry must explicitly set `free: true`.

OpenRouter is accepted only with `openrouter/free` or a model ID ending in `:free`. Never set a paid model ID. Cloud quotas are finite and account-specific; the router records latency, failures, 429 cooldowns and remaining-request headers when supplied. It does not purchase credits or retry through paid routes. The API exposes the last known route snapshot at `GET /v1/providers`.

## LLM environment

- `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434/v1`), `OLLAMA_MODEL`
- `CEREBRAS_API_KEY` plus `CEREBRAS_FREE_TRIAL_ENABLED=true` (explicit opt-in; verify the account remains on the free-trial tier), optional `CEREBRAS_MODEL`
- `GROQ_API_KEY`, optional `GROQ_MODEL`
- `GEMINI_API_KEY`, optional `GEMINI_MODEL`
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, optional `CLOUDFLARE_AI_MODEL`
- `OPENROUTER_API_KEY`, optional `OPENROUTER_MODEL` (must be `openrouter/free` or end in `:free`)
- `FREE_LLM_CUSTOM_ROUTES`: JSON array of `{id,baseUrl,model,apiKeyEnv?,priority?,free:true}`

## Free TTS cascade

1. Local Piper when `PIPER_MODEL` points to an installed voice model (optional `PIPER_BIN`).
2. A local OpenAI-compatible Kokoro server when `KOKORO_TTS_BASE_URL` and `KOKORO_TTS_VOICE` are set.
3. OpenRouter free TTS model when `OPENROUTER_TTS_MODEL` ends in `:free` and a voice is configured.
4. TTS.ai anonymous free Piper endpoint (enabled by default; disable with `TTS_AI_ENABLED=false`; optional `TTS_AI_VOICE`).

OpenRouter TTS is enabled only for model IDs ending in `:free`; paid TTS model IDs are ignored. TTS.ai anonymous requests are capped at 500 characters per request and 5,000 characters/day per IP according to its published docs. The worker chunks narration to stay under that request cap and rate-limits anonymous calls. Local Piper/Kokoro remain the no-cloud routes. Provider/model availability and licenses must be checked before commercial publication.

## Security

Only server-side environment variables are read. Never put provider keys in the mobile app, logs, or committed environment files. Free quotas are not unlimited and may change; the router does not upgrade accounts or silently spend money. Network/VPN gateway routing is a separate concern from LLM provider routing.
