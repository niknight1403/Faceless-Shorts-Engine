import test from "node:test";
import assert from "node:assert/strict";
import { parseProductionEnv, validateProductionEnv } from "./production-preflight.js";

const base = {
  POSTGRES_USER: "shorts",
  POSTGRES_PASSWORD: "p".repeat(40),
  API_ACCESS_TOKEN: "a".repeat(40),
  ASSET_SIGNING_SECRET: "b".repeat(40),
  JWT_ACCESS_SECRET: "c".repeat(40),
  DATABASE_URL: "postgresql://shorts:" + "p".repeat(40) + "@postgres:5432/shorts_engine",
  REDIS_URL: "redis://redis:6379",
  MEDIA_STORAGE_DIR: "/var/lib/faceless-shorts/media",
  EXPO_PUBLIC_API_URL: "https://api.faceless-shorts.example.net",
  PIPER_MODEL: "/models/de_DE-thorsten-medium.onnx",
  TTS_AI_ENABLED: "false"
};

test("production preflight accepts unique secrets and a local TTS route", () => {
  const result = validateProductionEnv(base);
  assert.deepEqual(result.errors, []);
  assert.ok(result.enabledRoutes.includes("piper-local"));
  assert.ok(!result.warnings.some(w => w.includes("external_provider")));
});

test("production preflight blocks placeholders and reused secrets", () => {
  const result = validateProductionEnv({ ...base, API_ACCESS_TOKEN: "CHANGE_TO_A_LONG_RANDOM_SERVER_ONLY_TOKEN", JWT_ACCESS_SECRET: base.ASSET_SIGNING_SECRET });
  assert.ok(result.errors.includes("API_ACCESS_TOKEN_missing_or_placeholder"));
  assert.ok(result.errors.includes("production_secrets_must_be_unique"));
});

test("production preflight blocks a deployment without a TTS route", () => {
  const result = validateProductionEnv({ ...base, PIPER_MODEL: undefined, TTS_AI_ENABLED: "false" });
  assert.ok(result.errors.includes("no_tts_route_enabled_configure_local_route_or_explicitly_enable_tts_ai"));
});

test("production preflight requires HTTPS for the mobile production URL", () => {
  const result = validateProductionEnv({ ...base, EXPO_PUBLIC_API_URL: "http://api.example.com" });
  assert.ok(result.errors.includes("EXPO_PUBLIC_API_URL_must_be_a_valid_https_url"));
});

test("anonymous TTS opt-in emits an external processing warning", () => {
  const result = validateProductionEnv({ ...base, PIPER_MODEL: undefined, TTS_AI_ENABLED: "true" });
  assert.ok(result.enabledRoutes.includes("tts-ai-free"));
  assert.ok(result.warnings.includes("tts_ai_free_sends_narration_text_to_external_provider_review_privacy_and_provider_terms"));
});

test("production preflight blocks a missing public API URL", () => {
  const result = validateProductionEnv({ ...base, EXPO_PUBLIC_API_URL: undefined });
  assert.ok(result.errors.includes("EXPO_PUBLIC_API_URL_missing_or_placeholder"));
});

test("production preflight strips trailing unquoted env comments", () => {
  const parsed = parseProductionEnv("TTS_AI_ENABLED=false # local-only TTS required\nEXPO_PUBLIC_API_URL=https://api.example.net # public endpoint");
  const result = validateProductionEnv({ ...base, ...parsed });
  assert.equal(parsed.TTS_AI_ENABLED, "false");
  assert.equal(parsed.EXPO_PUBLIC_API_URL, "https://api.example.net");
  assert.ok(!result.enabledRoutes.includes("tts-ai-free"));
  assert.ok(!result.warnings.some(w => w.includes("external_provider")));
});

test("production preflight detects mismatched PostgreSQL URL credentials", () => {
  const result = validateProductionEnv({ ...base, DATABASE_URL: "postgresql://shorts:wrong@postgres:5432/shorts_engine" });
  assert.ok(result.errors.includes("DATABASE_URL_password_must_match_POSTGRES_PASSWORD"));
});
