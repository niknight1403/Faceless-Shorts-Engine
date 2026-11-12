import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const PORT = Number(process.env.MOCK_PROVIDER_PORT ?? process.env.MOCK_MEDIA_PORT ?? 4010);
const WIDTH = 360;
const HEIGHT = 640;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function makePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const offset = y * (WIDTH * 3 + 1);
    rows[offset] = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      const pixel = offset + 1 + x * 3;
      rows[pixel] = Math.round(18 + 45 * x / WIDTH);
      rows[pixel + 1] = Math.round(28 + 65 * y / HEIGHT);
      rows[pixel + 2] = Math.round(72 + 100 * (1 - y / HEIGHT));
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function makeWav(durationSeconds = 1.5) {
  const sampleRate = 16000;
  const samples = Math.floor(sampleRate * durationSeconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const envelope = Math.min(1, i / 800, (samples - i) / 1600);
    const value = Math.sin(2 * Math.PI * 220 * i / sampleRate) * 0.12 * Math.max(0, envelope);
    pcm.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const image = makePng();
const audio = makeWav();
const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", provider: "deterministic-e2e" }));
    return;
  }
  if (req.method === "POST" && req.url === "/audio/speech") {
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > 32_768) {
        res.writeHead(413).end();
        return;
      }
    }
    try {
      const payload = JSON.parse(body || "{}");
      if (typeof payload.input !== "string" || !payload.input.trim()) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "input_required" }));
        return;
      }
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_json" }));
      return;
    }
    res.writeHead(200, { "content-type": "audio/wav", "content-length": audio.length, "cache-control": "no-store" });
    res.end(audio);
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/prompt/")) {
    res.writeHead(200, { "content-type": "image/png", "content-length": image.length, "cache-control": "no-store" });
    res.end(image);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
server.listen(PORT, "0.0.0.0", () => console.log("deterministic E2E media provider listening on " + PORT));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
