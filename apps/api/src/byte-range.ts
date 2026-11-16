export type ByteRange = { start: number; end: number };

/** Parse one RFC 9110 byte range. Returns null for malformed or unsatisfiable ranges. */
export function parseByteRange(header: string, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;

  const first = match[1]!;
  const last = match[2]!;
  if (!first) {
    const suffixLength = Number(last);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(first);
  const requestedEnd = last ? Number(last) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
      start < 0 || requestedEnd < start || start >= size) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}
