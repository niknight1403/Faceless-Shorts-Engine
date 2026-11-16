import { readFile } from "node:fs/promises";

export type PreflightResult = { errors: string[]; warnings: string[]; enabledRoutes: string[] };

const requiredSecrets = ["POSTGRES_PASSWORD", "API_ACCESS_TOKEN", "ASSET_SIGNING_SECRET", "JWT_ACCESS_SECRET"];

export function validateProductionEnv(env: Record<string, string | undefined>): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const enabledRoutes: string[] = [];
  for (const name of requiredSecrets) {
    const value = env[name]?.trim() ?? "";
    if (!value || value.startsWith("CHANGE_TO_")) errors.push(name + "_missing_or_placeholder");
    else if (value.length < 32) errors.push(name + "_must_be_at_least_32_characters");
  }
  const configured = requiredSecrets.map(name => env[name]?.trim()).filter(Boolean);
  if (new Set(configured).size !== configured.length) errors.push("production_secrets_must_be_unique");
  if (!env.DATABASE_URL?.startsWith("postgresql://")) errors.push("DATABASE_URL_must_use_postgresql");
  else {
    try {
      const database = new URL(env.DATABASE_URL);
      if (decodeURIComponent(database.username) !== (env.POSTGRES_USER ?? "shorts")) errors.push("DATABASE_URL_user_must_match_POSTGRES_USER");
      if (decodeURIComponent(database.password) !== (env.POSTGRES_PASSWORD ?? "")) errors.push("DATABASE_URL_password_must_match_POSTGRES_PASSWORD");
      if (database.pathname.slice(1) !== (env.POSTGRES_DB ?? "shorts_engine")) errors.push("DATABASE_URL_database_must_match_POSTGRES_DB");
    } catch { errors.push("DATABASE_URL_invalid"); }
  }
  if (env.BOOTSTRAP_ADMIN_PASSWORD && env.BOOTSTRAP_ADMIN_PASSWORD.length < 14) errors.push("BOOTSTRAP_ADMIN_PASSWORD_must_be_at_least_14_characters");
  if (!env.REDIS_URL?.startsWith("redis://") && !env.REDIS_URL?.startsWith("rediss://")) errors.push("REDIS_URL_must_use_redis");
  if (!env.MEDIA_STORAGE_DIR || !env.MEDIA_STORAGE_DIR.startsWith("/")) errors.push("MEDIA_STORAGE_DIR_must_be_absolute");
  if (!env.EXPO_PUBLIC_API_URL) errors.push("EXPO_PUBLIC_API_URL_missing_or_placeholder");
  else if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?(?:\/[^\s]*)?$/i.test(env.EXPO_PUBLIC_API_URL)) errors.push("EXPO_PUBLIC_API_URL_must_be_a_valid_https_url");
  else if (env.EXPO_PUBLIC_API_URL.includes("example.com")) errors.push("EXPO_PUBLIC_API_URL_missing_or_placeholder");
  if (env.API_BIND && env.API_BIND !== "127.0.0.1" && env.API_BIND !== "localhost") warnings.push("API_BIND_is_not_loopback_put_TLS_proxy_and_firewall_in_front");

  if (env.PIPER_MODEL) enabledRoutes.push("piper-local");
  if (env.KOKORO_TTS_BASE_URL && env.KOKORO_TTS_VOICE) enabledRoutes.push("kokoro-local");
  if (env.OPENROUTER_API_KEY && env.OPENROUTER_TTS_MODEL?.endsWith(":free") && env.OPENROUTER_TTS_VOICE) enabledRoutes.push("openrouter-free-tts");
  if (env.TTS_AI_ENABLED !== "false") enabledRoutes.push("tts-ai-free");
  if (!enabledRoutes.length) errors.push("no_tts_route_enabled_configure_local_route_or_explicitly_enable_tts_ai");
  if (env.TTS_AI_ENABLED !== "false") warnings.push("tts_ai_free_sends_narration_text_to_external_provider_review_privacy_and_provider_terms");
  if (!env.OLLAMA_MODEL && !env.CEREBRAS_API_KEY && !env.GROQ_API_KEY && !env.GEMINI_API_KEY &&
      !(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) && !env.OPENROUTER_API_KEY &&
      !env.FREE_LLM_CUSTOM_ROUTES && !env.AGENTFORGE_HUB_URL) {
    warnings.push("no_remote_or_local_llm_configured_script_generation_uses_local_template_fallback");
  }
  enabledRoutes.push("pollinations-free-visuals");
  return { errors, warnings, enabledRoutes };
}

export function parseProductionEnv(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if (!value.startsWith('"') && !value.startsWith("'")) value = value.replace(/\s+#.*$/, "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]!] = value;
  }
  return result;
}

async function main() {
  const file = process.argv[2] ?? ".env";
  let source: string;
  try { source = await readFile(file, "utf8"); }
  catch { console.error("production_preflight_failed: cannot_read_" + file); process.exitCode = 1; return; }
  const result = validateProductionEnv(parseProductionEnv(source));
  console.log(JSON.stringify({ file, status: result.errors.length ? "blocked" : "ready_for_manual_review", enabledRoutes: result.enabledRoutes, warnings: result.warnings, errors: result.errors }, null, 2));
  if (result.errors.length) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("production-preflight.ts")) void main();
