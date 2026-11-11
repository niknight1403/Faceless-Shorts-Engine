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
