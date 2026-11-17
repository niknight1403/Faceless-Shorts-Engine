import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { YouTubePublisher } from "../../src/publishing/platforms/youtube.mjs";
import { chooseTikTokChunkPlan, TikTokPublisher } from "../../src/publishing/platforms/tiktok.mjs";

const videoMetadata = { title: "Test Short", description: "Beschreibung", privacyStatus: "private", containsSyntheticMedia: false };

test("YouTube resumable Adapter setzt Privatsphäre explizit und lädt das MP4 hoch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-youtube-upload-"));
  const filePath = join(directory, "short.mp4");
  const calls = [];
  try {
    await writeFile(filePath, Buffer.alloc(1024, 0x55));
    const publisher = new YouTubePublisher({
      accessToken: "fake-token",
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        if (options.method === "POST") return new Response(null, { status: 200, headers: { location: "https://upload.example/session" } });
        return new Response(JSON.stringify({ id: "youtube-video-1", status: { uploadStatus: "uploaded" } }), { status: 201, headers: { "content-type": "application/json" } });
      },
    });
    const result = await publisher.uploadVideo({ filePath, metadata: videoMetadata });
    assert.equal(result.videoId, "youtube-video-1");
    assert.equal(calls.length, 2);
    const init = new URL(calls[0].url);
    assert.equal(init.searchParams.get("uploadType"), "resumable");
    assert.equal(init.searchParams.get("notifySubscribers"), "false");
    const requestBody = JSON.parse(calls[0].options.body);
    assert.equal(requestBody.status.privacyStatus, "private");
    assert.equal(requestBody.status.containsSyntheticMedia, false);
    assert.equal(calls[1].options.headers["Content-Range"], "bytes 0-1023/1024");
    assert.equal(calls[1].options.headers.Authorization, "Bearer fake-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("YouTube Adapter setzt Upload nach 308 Range fort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-youtube-resume-"));
  const filePath = join(directory, "short.mp4");
  const ranges = [];
  let putCount = 0;
  try {
    await writeFile(filePath, Buffer.alloc(600_000, 0x44));
    const publisher = new YouTubePublisher({
      accessToken: "fake-token",
      chunkSize: 256 * 1024,
      fetchImpl: async (_url, options) => {
        if (options.method === "POST") return new Response(null, { status: 200, headers: { location: "https://upload.example/session" } });
        putCount += 1;
        ranges.push(options.headers["Content-Range"]);
        if (putCount === 1) return new Response(null, { status: 308, headers: { range: "bytes=0-262143" } });
        return new Response(JSON.stringify({ id: "youtube-resumed" }), { status: 201 });
      },
    });
    const result = await publisher.uploadVideo({ filePath, metadata: videoMetadata });
    assert.equal(result.videoId, "youtube-resumed");
    assert.deepEqual(ranges, ["bytes 0-262143/600000", "bytes 262144-524287/600000"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("YouTube-Resume fragt gespeicherte Session ab und sendet nur noch fehlende Bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-youtube-resume-probe-"));
  const filePath = join(directory, "short.mp4");
  const ranges = [];
  try {
    await writeFile(filePath, Buffer.alloc(300_000, 0x44));
    const publisher = new YouTubePublisher({
      accessToken: "fake-token",
      fetchImpl: async (_url, options) => {
        const range = options.headers["Content-Range"];
        ranges.push(range);
        if (range === "bytes */300000") return new Response(null, { status: 308, headers: { range: "bytes=0-262143" } });
        assert.equal(range, "bytes 262144-299999/300000");
        return new Response(JSON.stringify({ id: "youtube-resumed-existing" }), { status: 201 });
      },
    });
    const result = await publisher.uploadVideo({ filePath, metadata: videoMetadata, sessionUri: "https://upload.example/session-existing" });
    assert.equal(result.videoId, "youtube-resumed-existing");
    assert.deepEqual(ranges, ["bytes */300000", "bytes 262144-299999/300000"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("YouTube-Resume erkennt eine bereits abgeschlossene Session ohne erneuten Chunkupload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-youtube-resume-complete-"));
  const filePath = join(directory, "short.mp4");
  let calls = 0;
  try {
    await writeFile(filePath, Buffer.alloc(1024, 0x44));
    const publisher = new YouTubePublisher({
      accessToken: "fake-token",
      fetchImpl: async (_url, options) => {
        calls += 1;
        assert.equal(options.headers["Content-Range"], "bytes */1024");
        return new Response(JSON.stringify({ id: "youtube-already-finished" }), { status: 200 });
      },
    });
    const result = await publisher.uploadVideo({ filePath, metadata: videoMetadata, sessionUri: "https://upload.example/session-finished" });
    assert.equal(result.videoId, "youtube-already-finished");
    assert.equal(result.resumed, true);
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TikTok-Chunkplan beachtet kleine Dateien, 64-MB-Chunks und finale Chunks", () => {
  const small = chooseTikTokChunkPlan(4 * 1024 * 1024);
  assert.deepEqual(small, { chunkSize: 4 * 1024 * 1024, totalChunkCount: 1 });
  const large = chooseTikTokChunkPlan(65 * 1024 * 1024);
  assert.equal(large.totalChunkCount, 2);
  assert.ok(large.chunkSize >= 5 * 1024 * 1024 && large.chunkSize <= 64 * 1024 * 1024);
  const finalSize = 65 * 1024 * 1024 - large.chunkSize;
  assert.ok(finalSize >= 5 * 1024 * 1024 && finalSize <= 128 * 1024 * 1024);
  assert.throws(() => chooseTikTokChunkPlan(4 * 1024 * 1024 * 1024 + 1), { code: "TIKTOK_FILE_TOO_LARGE" });
});

test("TikTok Inbox-Upload initialisiert und überträgt Datei mit sequentiellen Headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-tiktok-upload-"));
  const filePath = join(directory, "short.mp4");
  const calls = [];
  try {
    await writeFile(filePath, Buffer.alloc(1024 * 1024, 0x66));
    const publisher = new TikTokPublisher({
      accessToken: "fake-token",
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        if (options.method === "POST") return new Response(JSON.stringify({ data: { publish_id: "inbox-job-1", upload_url: "https://upload.example/tiktok" }, error: { code: "ok" } }), { status: 200 });
        return new Response(null, { status: 201 });
      },
    });
    const result = await publisher.uploadToInbox({ filePath });
    assert.equal(result.publishId, "inbox-job-1");
    assert.equal(result.status, "PROCESSING_UPLOAD");
    const initBody = JSON.parse(calls[0].options.body);
    assert.equal(calls[0].url.endsWith("/post/publish/inbox/video/init/"), true);
    assert.equal(initBody.source_info.source, "FILE_UPLOAD");
    assert.equal(calls[1].options.headers["Content-Range"], "bytes 0-1048575/1048576");
    assert.equal(calls[1].options.headers["Content-Length"], "1048576");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TikTok Direct Post blockiert fehlende Freigabe und setzt ausgewählte Optionen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-tiktok-direct-"));
  const filePath = join(directory, "short.mp4");
  const calls = [];
  try {
    await writeFile(filePath, Buffer.alloc(1024, 0x66));
    const publisher = new TikTokPublisher({
      accessToken: "fake-token",
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        if (options.method === "POST") return new Response(JSON.stringify({ data: { publish_id: "direct-job-1", upload_url: "https://upload.example/direct" }, error: { code: "ok" } }), { status: 200 });
        return new Response(null, { status: 201 });
      },
    });
    const base = { creatorInfo: { privacy_level_options: ["SELF_ONLY"] }, privacyLevel: "SELF_ONLY", title: "Test", confirmed: true, disableDuet: true, disableStitch: true, disableComment: true, brandContentToggle: false, brandOrganicToggle: false, isAigc: true };
    await assert.rejects(() => publisher.directPost({ filePath, metadata: { ...base, confirmed: false } }), { code: "TIKTOK_CONSENT_REQUIRED" });
    const result = await publisher.directPost({ filePath, metadata: base });
    assert.equal(result.publishId, "direct-job-1");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(calls[0].url.endsWith("/post/publish/video/init/"), true);
    assert.equal(body.post_info.privacy_level, "SELF_ONLY");
    assert.equal(body.post_info.is_aigc, true);
    assert.equal(body.post_info.brand_content_toggle, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TikTok Statusadapter normalisiert den Status aus der API", async () => {
  const publisher = new TikTokPublisher({
    accessToken: "fake-token",
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).publish_id, "publish-1");
      return new Response(JSON.stringify({ data: { status: "SEND_TO_USER_INBOX", uploaded_bytes: 1000 }, error: { code: "ok" } }), { status: 200 });
    },
  });
  const status = await publisher.getStatus("publish-1");
  assert.equal(status.status, "SEND_TO_USER_INBOX");
  assert.equal(status.uploadedBytes, 1000);
});

test("YouTube-Statusabfrage wiederholt nur transienten 429-Fehler mit injiziertem Backoff", async () => {
  let calls = 0;
  const waits = [];
  const events = [];
  const publisher = new YouTubePublisher({
    accessToken: "fake-token",
    retryOptions: { baseDelayMs: 12, wait: async delay => waits.push(delay), onRetry: async event => events.push(event) },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("{}", { status: 429 });
      return new Response(JSON.stringify({ items: [{ id: "video-1", status: { uploadStatus: "processed" }, processingDetails: { processingStatus: "succeeded" } }] }), { status: 200 });
    },
  });
  const status = await publisher.getVideoStatus("video-1");
  assert.equal(status.processingStatus, "succeeded");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [12]);
  assert.equal(events[0].platform, "youtube");
  assert.equal(events[0].action, "video-status");
});

test("YouTube-Chunk wird erst nach Statusabgleich ohne Fortschritt und mit Backoff erneut gesendet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-youtube-retry-safe-"));
  const filePath = join(directory, "short.mp4");
  const waits = [];
  const events = [];
  let chunkCalls = 0;
  let probeCalls = 0;
  try {
    await writeFile(filePath, Buffer.alloc(1024, 0x55));
    const publisher = new YouTubePublisher({
      accessToken: "fake-token",
      retryOptions: { baseDelayMs: 9, wait: async delay => waits.push(delay), onRetry: async event => events.push(event) },
      fetchImpl: async (_url, options) => {
        if (options.method === "POST") return new Response(null, { status: 200, headers: { location: "https://upload.example/session" } });
        if (options.headers["Content-Range"] === "bytes */1024") {
          probeCalls += 1;
          return new Response(null, { status: 308 });
        }
        chunkCalls += 1;
        if (chunkCalls === 1) return new Response("temporary", { status: 503 });
        return new Response(JSON.stringify({ id: "youtube-safe-retry" }), { status: 201 });
      },
    });
    const result = await publisher.uploadVideo({ filePath, metadata: videoMetadata });
    assert.equal(result.videoId, "youtube-safe-retry");
    assert.equal(chunkCalls, 2);
    assert.equal(probeCalls, 1);
    assert.deepEqual(waits, [9]);
    assert.equal(events[0].platform, "youtube");
    assert.equal(events[0].action, "upload-chunk-confirmed-not-accepted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("YouTube-Sessionstart mit unklarem HTTP-Ausgang wird nicht wiederholt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-youtube-init-unknown-"));
  const filePath = join(directory, "short.mp4");
  let calls = 0;
  try {
    await writeFile(filePath, Buffer.alloc(1024, 0x55));
    const publisher = new YouTubePublisher({
      accessToken: "fake-token",
      retryOptions: { wait: async () => assert.fail("Sessionstart darf nicht wiederholt werden") },
      fetchImpl: async () => { calls += 1; return new Response("temporary", { status: 503 }); },
    });
    await assert.rejects(() => publisher.uploadVideo({ filePath, metadata: videoMetadata }), error => {
      assert.equal(error.code, "YOUTUBE_SESSION_INIT_STATE_UNKNOWN");
      assert.equal(error.uncertainAcceptance, true);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TikTok-Statusabfrage wiederholt transienten Fehler begrenzt und protokolliert die Plattform", async () => {
  let calls = 0;
  const waits = [];
  const events = [];
  const publisher = new TikTokPublisher({
    accessToken: "fake-token",
    retryOptions: { baseDelayMs: 15, wait: async delay => waits.push(delay), onRetry: async event => events.push(event) },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: { code: "RATE_LIMIT" } }), { status: 429 });
      return new Response(JSON.stringify({ data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } }), { status: 200 });
    },
  });
  const status = await publisher.getStatus("publish-1");
  assert.equal(status.status, "PUBLISH_COMPLETE");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [15]);
  assert.equal(events[0].platform, "tiktok");
  assert.equal(events[0].action, "/post/publish/status/fetch/");
});

test("TikTok-Uploadinitialisierung und unklare Chunkannahme werden nie blind wiederholt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "faceless-tiktok-unknown-"));
  const filePath = join(directory, "short.mp4");
  let initCalls = 0;
  let chunkCalls = 0;
  try {
    await writeFile(filePath, Buffer.alloc(1024, 0x66));
    const initPublisher = new TikTokPublisher({
      accessToken: "fake-token",
      retryOptions: { wait: async () => assert.fail("Uploadinitialisierung darf nicht wiederholt werden") },
      fetchImpl: async () => { initCalls += 1; return new Response(JSON.stringify({ error: { code: "TEMPORARY" } }), { status: 503 }); },
    });
    await assert.rejects(() => initPublisher.initializeUpload({ fileSize: 1024 }), error => {
      assert.equal(error.code, "TIKTOK_UPLOAD_INIT_STATE_UNKNOWN");
      assert.equal(error.uncertainAcceptance, true);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(initCalls, 1);

    const chunkPublisher = new TikTokPublisher({
      accessToken: "fake-token",
      retryOptions: { wait: async () => assert.fail("Chunk mit unklarer Annahme darf nicht wiederholt werden") },
      fetchImpl: async (_url, options) => {
        if (options.method === "POST") return new Response(JSON.stringify({ data: { publish_id: "publish-1", upload_url: "https://upload.example/tiktok" }, error: { code: "ok" } }), { status: 200 });
        chunkCalls += 1;
        return new Response("temporary", { status: 503 });
      },
    });
    await assert.rejects(() => chunkPublisher.uploadToInbox({ filePath }), error => {
      assert.equal(error.code, "TIKTOK_UPLOAD_STATE_UNKNOWN");
      assert.equal(error.uncertainAcceptance, true);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(chunkCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
