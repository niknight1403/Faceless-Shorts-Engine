import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function parseKey(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return value;
  if (typeof value !== "string" || !value) throw new Error("PUBLISHING_TOKEN_KEY muss als 32-Byte-Schlüssel gesetzt sein.");
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) {
    throw new Error("PUBLISHING_TOKEN_KEY muss ein gültiger base64url-kodierter 32-Byte-Schlüssel sein.");
  }
  return key;
}

function publicConnection(connection) {
  return {
    id: connection.id,
    platform: connection.platform,
    accountId: connection.accountId,
    displayName: connection.displayName || null,
    scopes: connection.scopes || [],
    accessTokenExpiresAt: connection.accessTokenExpiresAt || null,
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt || null,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export class TokenVault {
  constructor({ filePath, key }) {
    if (!filePath) throw new TypeError("filePath ist erforderlich.");
    this.filePath = filePath;
    this.key = parseKey(key);
    this.connections = new Map();
  }

  static fromEnvironment({ filePath, env = process.env } = {}) {
    return new TokenVault({ filePath, key: env.PUBLISHING_TOKEN_KEY });
  }

  async initialize() {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const content = JSON.parse(await readFile(this.filePath, "utf8"));
      for (const connection of content.connections || []) {
        this.connections.set(connection.id, connection);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Token-Vault konnte nicht gelesen werden: ${error.message}`);
    }
    return this;
  }

  list() {
    return [...this.connections.values()].map(publicConnection);
  }

  has(id) {
    return this.connections.has(id);
  }

  get(id) {
    const connection = this.connections.get(id);
    if (!connection) return null;
    return { ...publicConnection(connection), ...this.decrypt(connection.encryptedTokens) };
  }

  async put({ id, platform, accountId, displayName = null, scopes = [], accessToken, refreshToken = null, accessTokenExpiresAt = null, refreshTokenExpiresAt = null }) {
    if (!id || !["youtube", "tiktok"].includes(platform) || !accountId) throw new TypeError("id, eine unterstützte Plattform und accountId sind erforderlich.");
    if (typeof accessToken !== "string" || !accessToken) throw new TypeError("accessToken ist erforderlich.");
    if (!Array.isArray(scopes)) throw new TypeError("scopes muss eine Liste sein.");
    const now = new Date().toISOString();
    const previous = this.connections.get(id);
    const connection = {
      id,
      platform,
      accountId,
      displayName,
      scopes: [...new Set(scopes)],
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      encryptedTokens: this.encrypt({ accessToken, refreshToken }),
    };
    const nextConnections = new Map(this.connections);
    nextConnections.set(id, connection);
    await this.persist(nextConnections);
    this.connections = nextConnections;
    return publicConnection(connection);
  }

  async remove(id) {
    if (!this.connections.has(id)) return false;
    const nextConnections = new Map(this.connections);
    nextConnections.delete(id);
    await this.persist(nextConnections);
    this.connections = nextConnections;
    return true;
  }

  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { algorithm: "aes-256-gcm", iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  }

  decrypt(encrypted) {
    if (!encrypted || encrypted.algorithm !== "aes-256-gcm") throw new Error("Token-Verschlüsselungsformat wird nicht unterstützt.");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(encrypted.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
      return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8"));
    } catch {
      throw new Error("Token-Vault kann mit diesem Schlüssel nicht entschlüsselt werden.");
    }
  }

  async persist(connections = this.connections) {
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, connections: [...connections.values()] }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
