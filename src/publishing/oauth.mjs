import { randomBytes } from "node:crypto";

const INVALID_REFRESH_CODES = new Set(["invalid_grant", "invalid_refresh_token", "refresh_token_expired"]);

export class OAuthProviderError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = "OAuthProviderError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function providerErrorCode(payload) {
  const value = payload?.error ?? payload?.data?.error;
  if (typeof value === "string") return value.trim().toLowerCase();
  if (value && typeof value === "object") {
    const code = value.code ?? value.error;
    return typeof code === "string" ? code.trim().toLowerCase() : "";
  }
  return "";
}

export class OAuthStateStore {
  constructor({ ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.states = new Map();
  }

  issue({ platform, redirectUri, metadata = {} }) {
    if (!["youtube", "tiktok"].includes(platform)) throw new TypeError("OAuth-Plattform wird nicht unterstützt.");
    if (!redirectUri) throw new TypeError("redirectUri ist erforderlich.");
    const state = randomBytes(32).toString("base64url");
    this.states.set(state, { platform, redirectUri, metadata: structuredClone(metadata), expiresAt: this.now() + this.ttlMs });
    return state;
  }

  consume(state, platform) {
    const entry = this.states.get(state);
    this.states.delete(state);
    if (!entry || entry.expiresAt <= this.now() || entry.platform !== platform) {
      const error = new Error("OAuth-State fehlt, ist abgelaufen oder passt nicht zur Plattform.");
      error.code = "OAUTH_STATE_INVALID";
      throw error;
    }
    return { platform: entry.platform, redirectUri: entry.redirectUri, metadata: entry.metadata };
  }
}

export const OAUTH_PROVIDERS = Object.freeze({
  youtube: Object.freeze({
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revokeEndpoint: "https://oauth2.googleapis.com/revoke",
    scope: "https://www.googleapis.com/auth/youtube.upload",
    responseFormat: "form",
  }),
  tiktok: Object.freeze({
    authorizationEndpoint: "https://www.tiktok.com/v2/auth/authorize/",
    tokenEndpoint: "https://open.tiktokapis.com/v2/oauth/token/",
    revokeEndpoint: "https://open.tiktokapis.com/v2/oauth/revoke/",
    scope: "user.info.basic,video.upload",
    responseFormat: "form",
  }),
});

export class OAuthProviderClient {
  constructor({ platform, clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
    const provider = OAUTH_PROVIDERS[platform];
    if (!provider) throw new TypeError("OAuth-Plattform wird nicht unterstützt.");
    if (!clientId || !clientSecret || !redirectUri) throw new TypeError("OAuth-Client-ID, Secret und Redirect-URI sind erforderlich.");
    this.platform = platform;
    this.provider = provider;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.fetchImpl = fetchImpl;
  }

  authorizationUrl({ state, scopes, forceConsent = false }) {
    if (!state) throw new TypeError("OAuth-State ist erforderlich.");
    const url = new URL(this.provider.authorizationEndpoint);
    if (this.platform === "tiktok") url.searchParams.set("client_key", this.clientId);
    else url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", (scopes?.length ? scopes : this.provider.scope.split(this.platform === "tiktok" ? "," : " ")).join(this.platform === "tiktok" ? "," : " "));
    url.searchParams.set("state", state);
    if (this.platform === "youtube") {
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "true");
      if (forceConsent) url.searchParams.set("prompt", "consent");
    }
    return url.toString();
  }

  async exchangeCode(code, redirectUri = this.redirectUri) {
    return this.postToken({ code, grant_type: "authorization_code", redirect_uri: redirectUri });
  }

  async refresh(refreshToken) {
    if (!refreshToken) throw new TypeError("refreshToken ist erforderlich.");
    return this.postToken({ refresh_token: refreshToken, grant_type: "refresh_token" });
  }

  async revoke(token) {
    if (!token) return;
    const body = new URLSearchParams({ token });
    if (this.platform === "tiktok") {
      body.set("client_key", this.clientId);
      body.set("client_secret", this.clientSecret);
    }
    const response = await this.fetchImpl(this.provider.revokeEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new OAuthProviderError("OAUTH_REVOKE_FAILED", "OAuth-Tokenwiderruf fehlgeschlagen.");
  }

  async postToken(parameters) {
    const body = new URLSearchParams(parameters);
    if (this.platform === "tiktok") {
      body.set("client_key", this.clientId);
      body.set("client_secret", this.clientSecret);
    } else {
      body.set("client_id", this.clientId);
      body.set("client_secret", this.clientSecret);
    }
    const response = await this.fetchImpl(this.provider.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new OAuthProviderError("OAUTH_PROVIDER_RESPONSE_INVALID", "OAuth-Provider lieferte keine gültige Antwort.");
    }
    const code = providerErrorCode(payload);
    if (!response.ok || (code && code !== "ok")) {
      if (parameters.grant_type === "refresh_token" && INVALID_REFRESH_CODES.has(code)) {
        throw new OAuthProviderError("OAUTH_REFRESH_TOKEN_INVALID", "Der Refresh-Token wurde vom Anbieter abgelehnt.", 401);
      }
      throw new OAuthProviderError("OAUTH_PROVIDER_ERROR", "OAuth-Tokenaustausch fehlgeschlagen.");
    }
    const result = payload.data && typeof payload.data === "object" ? payload.data : payload;
    if (!result.access_token) throw new Error("OAuth-Provider hat kein gültiges Zugriffstoken geliefert.");
    return result;
  }
}
