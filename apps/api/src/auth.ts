import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  if (!encoded || password.length > 1024) return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (N !== 16384 || r !== 8 || p !== 1 || !/^[a-f0-9]{32}$/i.test(parts[4]!) || !/^[a-f0-9]{128}$/i.test(parts[5]!)) return false;
  try {
    const expected = Buffer.from(parts[5]!, "hex");
    const actual = await scrypt(password, Buffer.from(parts[4]!, "hex"), expected.length, { N, r, p }) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
