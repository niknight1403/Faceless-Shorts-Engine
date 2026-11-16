export async function readJsonBody<T>(request: AsyncIterable<Uint8Array | string>, maxBytes = 16_384): Promise<T> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += part.byteLength;
    if (byteLength > maxBytes) throw new Error("body_too_large");
    chunks.push(part);
  }
  const raw = Buffer.concat(chunks, byteLength).toString("utf8");
  return JSON.parse(raw || "{}") as T;
}
