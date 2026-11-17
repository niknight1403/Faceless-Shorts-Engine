import { OAuthProviderClient, OAuthStateStore } from "./oauth.mjs";

export class ConnectionServiceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ConnectionServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function parseScopes(platform, scope) {
  if (Array.isArray(scope)) return scope;
  if (typeof scope !== "string") return [];
  return scope.split(platform === "tiktok" ? "," : " ").map(value => value.trim()).filter(Boolean);
}

async function revokeUnpersistedGrant(client, accessToken) {
  try {
    if (!accessToken || typeof client.revoke !== "function") return false;
    await client.revoke(accessToken);
    return true;
  } catch {
    return false;
  }
}

export class PlatformConnectionService {
  constructor({ config, vault, tokenManager, clientFactory, fetchImpl = fetch, stateStore = new OAuthStateStore() }) {
    this.config = config;
    this.vault = vault;
    this.tokenManager = tokenManager;
    this.clientFactory = clientFactory || (platform => {
      const values = config.oauth?.[platform];
      if (!values?.clientId || !values?.clientSecret || !values?.redirectUri) {
        throw new ConnectionServiceError("OAUTH_NOT_CONFIGURED", `${platform} OAuth-Client-ID, Secret oder Redirect-URI fehlen.`, 503);
      }
      return new OAuthProviderClient({ platform, ...values, fetchImpl });
    });
    this.fetchImpl = fetchImpl;
    this.stateStore = stateStore;
  }

  scopesFor(platform, mode) {
    if (platform === "youtube") return [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ];
    if (platform !== "tiktok") throw new ConnectionServiceError("UNSUPPORTED_PLATFORM", "Plattform wird nicht unterstützt.");
    if (!['upload', 'direct_post'].includes(mode)) throw new ConnectionServiceError("PUBLISHING_MODE_INVALID", "TikTok-Modus muss upload oder direct_post sein.");
    if (mode === "direct_post") {
      if (!this.config.tiktokDirectPostApproved) throw new ConnectionServiceError("TIKTOK_DIRECT_POST_DISABLED", "TikTok Direct Post ist erst nach App-Prüfung und ausdrücklicher Aktivierung verfügbar.", 403);
      return ["user.info.basic", "video.publish"];
    }
    if (!this.config.tiktokUploadApproved) throw new ConnectionServiceError("TIKTOK_UPLOAD_DISABLED", "TikTok-Inbox-Upload ist erst nach App-Prüfung und ausdrücklicher Aktivierung verfügbar.", 403);
    return ["user.info.basic", "video.upload"];
  }

  start(platform, { mode = "upload" } = {}) {
    const scopes = this.scopesFor(platform, mode);
    const client = this.clientFactory(platform);
    const redirectUri = client.redirectUri;
    const state = this.stateStore.issue({ platform, redirectUri, metadata: { mode } });
    return {
      state,
      mode,
      authorizationUrl: client.authorizationUrl({ state, scopes, forceConsent: platform === "youtube" }),
    };
  }

  async finish(platform, { code, state, providerError = null }) {
    if (!state) throw new ConnectionServiceError("OAUTH_CALLBACK_INVALID", "OAuth-State fehlt.", 400);
    const stateData = this.stateStore.consume(state, platform);
    if (providerError) throw new ConnectionServiceError("OAUTH_PROVIDER_DENIED", "Die Kontoautorisierung wurde beim Anbieter abgebrochen.", 400);
    if (!code) throw new ConnectionServiceError("OAUTH_CALLBACK_INVALID", "OAuth-Code fehlt.", 400);
    const client = this.clientFactory(platform);
    const tokens = await client.exchangeCode(code, stateData.redirectUri);
    const scopes = parseScopes(platform, tokens.scope);
    const required = platform === "youtube"
      ? ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"]
      : stateData.metadata.mode === "direct_post" ? ["user.info.basic", "video.publish"] : ["user.info.basic", "video.upload"];
    const missing = required.filter(scope => !scopes.includes(scope));
    if (missing.length) {
      const revoked = await revokeUnpersistedGrant(client, tokens.access_token);
      if (!revoked) {
        throw new ConnectionServiceError("OAUTH_SCOPE_REVOCATION_FAILED", "Die Berechtigungen reichen nicht aus. Das Token wurde nicht lokal gespeichert; widerrufe die App-Berechtigung zusätzlich im Plattformkonto.", 502);
      }
      throw new ConnectionServiceError("OAUTH_SCOPE_MISSING", "Die erteilten Berechtigungen reichen für den gewählten Publishing-Modus nicht aus.", 403);
    }

    let accountId;
    let displayName;
    try {
      if (platform === "youtube") {
        const url = new URL("https://www.googleapis.com/youtube/v3/channels");
        url.searchParams.set("part", "id,snippet");
        url.searchParams.set("mine", "true");
        const response = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new ConnectionServiceError("YOUTUBE_CHANNEL_LOOKUP_FAILED", "YouTube-Kanal konnte nicht ermittelt werden.", 502);
        const result = await response.json();
        const channel = result.items?.[0];
        if (!channel?.id) throw new ConnectionServiceError("YOUTUBE_CHANNEL_NOT_FOUND", "Mit diesem Google-Konto wurde kein YouTube-Kanal gefunden.", 404);
        accountId = channel.id;
        displayName = channel.snippet?.title || accountId;
      } else {
        accountId = tokens.open_id;
        displayName = tokens.display_name || accountId;
        if (!accountId) throw new ConnectionServiceError("TIKTOK_OPEN_ID_MISSING", "TikTok lieferte keine Creator-ID zurück.", 502);
      }
    } catch (error) {
      const revoked = await revokeUnpersistedGrant(client, tokens.access_token);
      if (!revoked) {
        throw new ConnectionServiceError("OAUTH_ACCOUNT_REVOCATION_FAILED", "Das Plattformkonto konnte nicht ermittelt werden. Tokens wurden nicht lokal gespeichert; widerrufe die App-Berechtigung zusätzlich im Plattformkonto.", 502);
      }
      if (error instanceof ConnectionServiceError) throw error;
      throw new ConnectionServiceError("PLATFORM_ACCOUNT_LOOKUP_FAILED", "Das Plattformkonto konnte nicht ermittelt werden. Tokens wurden nicht lokal gespeichert.", 502);
    }

    const now = Date.now();
    const connectionId = `${platform}:${accountId}`;
    let saved;
    try {
      saved = await this.vault.put({
        id: connectionId,
        platform,
        accountId,
        displayName,
        scopes,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || this.vault.get(connectionId)?.refreshToken || null,
        accessTokenExpiresAt: Number.isFinite(Number(tokens.expires_in)) ? new Date(now + Number(tokens.expires_in) * 1000).toISOString() : null,
        refreshTokenExpiresAt: Number.isFinite(Number(tokens.refresh_expires_in)) ? new Date(now + Number(tokens.refresh_expires_in) * 1000).toISOString() : null,
      });
    } catch {
      const revoked = await revokeUnpersistedGrant(client, tokens.access_token);
      if (!revoked) {
        throw new ConnectionServiceError("OAUTH_CONNECTION_SAVE_REVOCATION_FAILED", "Die Verbindung konnte nicht lokal gespeichert werden. Tokens wurden nicht lokal abgelegt; widerrufe die App-Berechtigung zusätzlich im Plattformkonto.", 502);
      }
      throw new ConnectionServiceError("OAUTH_CONNECTION_SAVE_FAILED", "Die Verbindung konnte nicht sicher lokal gespeichert werden. Eine bestehende Verbindung blieb unverändert.", 500);
    }
    return saved;
  }

  async disconnect(connectionId) {
    return this.tokenManager.disconnect(connectionId);
  }
}
