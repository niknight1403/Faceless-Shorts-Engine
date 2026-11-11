import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const scrypt = (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> => new Promise((resolve, reject) => {
  scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
    if (error) reject(error);
    else resolve(derivedKey);
  });
});

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  if (password.length > 1024) return false;
  const parts = encoded?.split("$") ?? [];
  const validFormat = parts.length === 6 && parts[0] === "scrypt" &&
    Number(parts[1]) === 16384 && Number(parts[2]) === 8 && Number(parts[3]) === 1 &&
    /^[a-f0-9]{32}$/i.test(parts[4] ?? "") && /^[a-f0-9]{128}$/i.test(parts[5] ?? "");
  // Perform the same expensive KDF for unknown users to reduce account-enumeration timing leaks.
  const salt = validFormat ? Buffer.from(parts[4]!, "hex") : Buffer.alloc(16);
  const expected = validFormat ? Buffer.from(parts[5]!, "hex") : Buffer.alloc(64);
  try {
    const actual = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return validFormat && actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
