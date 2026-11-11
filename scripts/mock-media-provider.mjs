import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const port = Number(process.env.MOCK_MEDIA_PORT ?? 4010);
const directory = "/tmp/faceless-mock-media";

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error("mock_ffmpeg_exit_" + code + ":" + stderr.slice(-500))));
  });
}

await mkdir(directory, { recursive: true });
const imagePath = join(directory, "scene.png");
const audioPath = join(directory, "voice.wav");
await runFfmpeg(["-f", "lavfi", "-i", "color=c=0x244466:s=720x1280", "-frames:v", "1", imagePath]);
await runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1", "-ac", "1", "-c:a", "pcm_s16le", audioPath]);

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "ok" })); return;
  }
  if (req.method === "GET" && path.startsWith("/prompt/")) {
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    const { createReadStream } = await import("node:fs");
    createReadStream(imagePath).pipe(res); return;
  }
  if (req.method === "POST" && path === "/audio/speech") {
    res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" });
    const { createReadStream } = await import("node:fs");
    createReadStream(audioPath).pipe(res); return;
  }
  res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not_found" }));
});
server.listen(port, "0.0.0.0", () => console.log("mock media provider listening on :" + port));
