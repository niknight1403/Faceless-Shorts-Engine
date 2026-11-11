import test from "node:test";
import assert from "node:assert/strict";
import { FreeRouteHunter, type FreeLlmRoute } from "./free-route-hunter.js";

test("free route hunter fails over after provider failure and records health", async () => {
  const routes: FreeLlmRoute[] = [
    { id: "primary", model: "free-a", baseUrl: "https://primary.invalid/v1", priority: 1, free: true },
    { id: "backup", model: "free-b", baseUrl: "https://backup.invalid/v1", priority: 2, free: true }
  ];
  const hunter = new FreeRouteHunter(routes);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.includes("primary")) return new Response("limited", { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await hunter.generate("return JSON");
    assert.equal(result.provider, "backup");
    assert.equal(calls.length, 2);
    assert.equal(hunter.snapshot()[0]?.available, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("route hunter reports when no free route is configured", async () => {
  const hunter = new FreeRouteHunter([]);
  await assert.rejects(() => hunter.generate("prompt"), /no_free_llm_route_available/);
});


test("Agentforge2 hub imports only enabled free keyless routes and reads hunter status", async () => {
  const oldUrl = process.env.AGENTFORGE_HUB_URL;
  const oldToken = process.env.AGENTFORGE_HUB_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.AGENTFORGE_HUB_URL = "https://hub.example";
  delete process.env.AGENTFORGE_HUB_TOKEN;
  const hunter = new FreeRouteHunter([]);
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/free-routes")) return new Response(JSON.stringify({ routes: [
      { id: 7, provider: "pollinations", base_url: "https://text.pollinations.ai/openai", model: "openai", is_free: 1, enabled: 1, priority: 20 },
      { id: 8, provider: "openrouter", base_url: "https://openrouter.ai/api/v1", model: "private-route", is_free: 1, enabled: 1, key_env: "AGENTFORGE_ONLY_KEY" },
      { id: 9, provider: "paid", base_url: "https://paid.example/v1", model: "paid", is_free: 0, enabled: 1 }
    ] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ routes: { total: 3, free: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await hunter.refreshFromAgentforgeHub(fakeFetch, true);
    assert.equal(hunter.snapshot().length, 1);
    assert.equal(hunter.snapshot()[0]?.id, "agentforge-hub-7");
    assert.equal((hunter.hubStatus()?.connected), true);
    assert.equal((hunter.hubStatus()?.routesImported), 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUrl === undefined) delete process.env.AGENTFORGE_HUB_URL; else process.env.AGENTFORGE_HUB_URL = oldUrl;
    if (oldToken === undefined) delete process.env.AGENTFORGE_HUB_TOKEN; else process.env.AGENTFORGE_HUB_TOKEN = oldToken;
  }
});
