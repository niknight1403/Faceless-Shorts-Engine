function managerError(code, message, statusCode) {
  const error = new Error(message);
  error.name = "OAuthTokenManagerError";
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export class OAuthTokenManager {
  constructor({ vault, clientFactory, now = () => Date.now(), refreshSkewMs = 60_000 }) {
    this.vault = vault;
    this.clientFactory = clientFactory;
    this.now = now;
    this.refreshSkewMs = refreshSkewMs;
    this.refreshes = new Map();
  }

  async getAccessToken(connectionId) {
    const connection = this.vault.get(connectionId);
    if (!connection) {
      throw managerError("CONNECTION_NOT_FOUND", "Plattformkonto ist nicht verbunden.", 404);
    }
    const expiry = connection.accessTokenExpiresAt ? Date.parse(connection.accessTokenExpiresAt) : NaN;
    if (!Number.isFinite(expiry) || expiry > this.now() + this.refreshSkewMs) return connection.accessToken;
    if (!connection.refreshToken) {
      throw managerError("REAUTHENTICATION_REQUIRED", "Das Plattformkonto muss erneut verbunden werden.", 401);
    }
    if (this.refreshes.has(connectionId)) return this.refreshes.get(connectionId);
    const refreshPromise = this.refreshConnection(connection).finally(() => this.refreshes.delete(connectionId));
    this.refreshes.set(connectionId, refreshPromise);
    return refreshPromise;
  }

  async refreshConnection(connection) {
    let result;
    try {
      const client = this.clientFactory(connection.platform);
      result = await client.refresh(connection.refreshToken);
    } catch (cause) {
      if (cause?.code === "OAUTH_REFRESH_TOKEN_INVALID") {
        try {
          await this.vault.remove(connection.id);
        } catch {
          throw managerError("TOKEN_CLEANUP_FAILED", "Der abgelehnte lokale Token konnte nicht sicher entfernt werden. Bitte Verbindung manuell prüfen.", 500);
        }
        throw managerError("REAUTHENTICATION_REQUIRED", "Der Plattform-Refresh-Token ist abgelaufen oder ungültig. Bitte Konto erneut verbinden.", 401);
      }
      if (cause?.code === "OAUTH_NOT_CONFIGURED") {
        throw managerError("OAUTH_NOT_CONFIGURED", "OAuth-Zugangsdaten sind nicht konfiguriert; die gespeicherte Verbindung bleibt erhalten.", 503);
      }
      throw managerError("TOKEN_REFRESH_FAILED", "Das Zugriffstoken konnte nicht erneuert werden. Die lokale Verbindung bleibt erhalten; bitte später erneut versuchen.", 502);
    }

    if (typeof result?.access_token !== "string" || !result.access_token) {
      throw managerError("TOKEN_REFRESH_FAILED", "Der Anbieter lieferte kein gültiges Zugriffstoken. Die lokale Verbindung bleibt erhalten.", 502);
    }

    const now = this.now();
    const scopes = typeof result.scope === "string"
      ? result.scope.split(connection.platform === "tiktok" ? "," : " ").map(value => value.trim()).filter(Boolean)
      : connection.scopes;
    try {
      await this.vault.put({
        id: connection.id,
        platform: connection.platform,
        accountId: connection.accountId,
        displayName: connection.displayName,
        scopes,
        accessToken: result.access_token,
        refreshToken: result.refresh_token || connection.refreshToken,
        accessTokenExpiresAt: Number.isFinite(Number(result.expires_in)) ? new Date(now + Number(result.expires_in) * 1000).toISOString() : null,
        refreshTokenExpiresAt: Number.isFinite(Number(result.refresh_expires_in)) ? new Date(now + Number(result.refresh_expires_in) * 1000).toISOString() : connection.refreshTokenExpiresAt,
      });
    } catch {
      throw managerError("TOKEN_PERSIST_FAILED", "Die erneuerte Verbindung konnte lokal nicht gespeichert werden.", 500);
    }
    return result.access_token;
  }

  async disconnect(connectionId) {
    const connection = this.vault.get(connectionId);
    if (!connection) return false;

    let removed;
    try {
      removed = await this.vault.remove(connectionId);
    } catch {
      throw managerError("LOCAL_DISCONNECT_FAILED", "Lokale Zugangsdaten konnten nicht sicher entfernt werden; ein Anbieterwiderruf wurde nicht gestartet.", 500);
    }
    if (!removed) return false;

    try {
      const client = this.clientFactory(connection.platform);
      await client.revoke(connection.accessToken);
    } catch {
      throw managerError(
        "CONNECTION_DISCONNECTED_REVOCATION_FAILED",
        "Die Verbindung wurde lokal getrennt. Der Anbieterwiderruf konnte nicht bestätigt werden; widerrufe die App-Berechtigung zusätzlich in deinem Plattformkonto.",
        502,
      );
    }
    return true;
  }
}
