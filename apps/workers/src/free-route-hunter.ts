export interface FreeLlmRoute { id: string; model: string; baseUrl: string; apiKey?: string; priority: number; free: true }
export interface LlmRouteResult { provider: string; model: string; text: string; latencyMs: number }
export interface RouteSnapshot { id: string; model: string; priority: number; available: boolean; failures: number; latencyMs: number | null; cooldownUntil: string | null; remainingRequests: number | null; remainingTokens: number | null }
type RouteState = { failures: number; latencyMs: number | null; cooldownUntil: number; remainingRequests: number | null; remainingTokens: number | null };
const env = (name: string) => process.env[name]?.trim() || undefined;
const endpoint = (baseUrl: string) => baseUrl.replace(/\/+$/, "") + "/chat/completions";

/** Free-only route registry. Paid models are rejected rather than used as fallbacks. */
export function buildFreeLlmRoutes(): FreeLlmRoute[] {
  const routes: FreeLlmRoute[] = [];
  const ollamaModel = env("OLLAMA_MODEL");
  if (ollamaModel) routes.push({ id: "ollama-local", model: ollamaModel, baseUrl: env("OLLAMA_BASE_URL") ?? "http://127.0.0.1:11434/v1", priority: 1, free: true });
  const cerebrasKey = env("CEREBRAS_API_KEY");
  if (cerebrasKey && env("CEREBRAS_FREE_TRIAL_ENABLED") === "true") routes.push({ id: "cerebras-free-trial", model: env("CEREBRAS_MODEL") ?? "gpt-oss-120b", baseUrl: "https://api.cerebras.ai/v1", apiKey: cerebrasKey, priority: 2, free: true });
  const groqKey = env("GROQ_API_KEY");
  if (groqKey) routes.push({ id: "groq-free-tier", model: env("GROQ_MODEL") ?? "openai/gpt-oss-20b", baseUrl: "https://api.groq.com/openai/v1", apiKey: groqKey, priority: 3, free: true });
  const geminiKey = env("GEMINI_API_KEY");
  if (geminiKey) routes.push({ id: "gemini-free-tier", model: env("GEMINI_MODEL") ?? "gemini-2.5-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: geminiKey, priority: 4, free: true });
  const account = env("CLOUDFLARE_ACCOUNT_ID"), token = env("CLOUDFLARE_API_TOKEN");
  if (account && token) routes.push({ id: "cloudflare-workers-ai-free", model: env("CLOUDFLARE_AI_MODEL") ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast", baseUrl: "https://api.cloudflare.com/client/v4/accounts/" + account + "/ai/v1", apiKey: token, priority: 5, free: true });
  const openRouterKey = env("OPENROUTER_API_KEY"), openRouterModel = env("OPENROUTER_MODEL") ?? "openrouter/free";
  if (openRouterKey && (openRouterModel === "openrouter/free" || openRouterModel.endsWith(":free"))) routes.push({ id: "openrouter-free", model: openRouterModel, baseUrl: "https://openrouter.ai/api/v1", apiKey: openRouterKey, priority: 6, free: true });
  const custom = env("FREE_LLM_CUSTOM_ROUTES");
  if (custom) {
    try {
      const parsed = JSON.parse(custom) as Array<{ id: string; model: string; baseUrl: string; apiKeyEnv?: string; priority?: number; free?: boolean }>;
      for (const item of parsed) {
        if (!item.free || !item.id || !item.model || !item.baseUrl || !/^https?:\/\//.test(item.baseUrl)) continue;
        routes.push({ id: item.id, model: item.model, baseUrl: item.baseUrl, apiKey: item.apiKeyEnv ? env(item.apiKeyEnv) : undefined, priority: item.priority ?? 20, free: true });
      }
    } catch { console.warn("FREE_LLM_CUSTOM_ROUTES is invalid JSON; custom routes ignored"); }
  }
  return routes.sort((a, b) => a.priority - b.priority);
}

export class FreeRouteHunter {
  private readonly state = new Map<string, RouteState>();
  constructor(private readonly routes: FreeLlmRoute[], private readonly timeoutMs = 20_000, private readonly cooldownMs = 60_000) {
    for (const route of routes) this.state.set(route.id, { failures: 0, latencyMs: null, cooldownUntil: 0, remainingRequests: null, remainingTokens: null });
  }
  snapshot(): RouteSnapshot[] {
    const now = Date.now();
    return this.routes.map(route => {
      const state = this.state.get(route.id)!;
      return { id: route.id, model: route.model, priority: route.priority, available: state.cooldownUntil <= now && state.remainingRequests !== 0, failures: state.failures, latencyMs: state.latencyMs, cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : null, remainingRequests: state.remainingRequests, remainingTokens: state.remainingTokens };
    });
  }
  async generate(prompt: string): Promise<LlmRouteResult> {
    const now = Date.now();
    const candidates = this.routes.filter(route => route.free === true).filter(route => {
      const state = this.state.get(route.id)!;
      return state.cooldownUntil <= now && state.remainingRequests !== 0;
    }).sort((a, b) => {
      const sa = this.state.get(a.id)!, sb = this.state.get(b.id)!;
      return (a.priority + (sa.latencyMs ?? 0) / 5000 + sa.failures * 3) - (b.priority + (sb.latencyMs ?? 0) / 5000 + sb.failures * 3);
    });
    let lastError: unknown;
    for (const route of candidates) {
      const state = this.state.get(route.id)!, started = Date.now();
      try {
        const response = await fetch(endpoint(route.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json", ...(route.apiKey ? { authorization: "Bearer " + route.apiKey } : {}), ...(route.id.startsWith("openrouter") ? { "HTTP-Referer": "https://github.com/niknight1403/Faceless-Shorts-Engine", "X-Title": "Faceless Shorts Engine" } : {}) },
          body: JSON.stringify({ model: route.model, messages: [{ role: "system", content: "Return only valid JSON matching the requested schema. Do not use markdown fences." }, { role: "user", content: prompt }], temperature: 0.7 }),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        const remaining = response.headers.get("x-ratelimit-remaining-requests");
        if (remaining !== null && Number.isFinite(Number(remaining))) state.remainingRequests = Number(remaining);
        const remainingTokens = response.headers.get("x-ratelimit-remaining-tokens");
        if (remainingTokens !== null && Number.isFinite(Number(remainingTokens))) state.remainingTokens = Number(remainingTokens);
        if (!response.ok) {
          if (response.status === 429 || response.status === 402 || response.status === 403 || response.status >= 500) {
            const retryAfter = response.headers.get("retry-after");
            const retrySeconds = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : 0;
            const retryDate = retryAfter && !retrySeconds ? Date.parse(retryAfter) - Date.now() : 0;
            state.cooldownUntil = Date.now() + (response.status === 429 ? Math.max(this.cooldownMs, retrySeconds, retryDate) : 15_000);
          }
          throw new Error(route.id + "_http_" + response.status);
        }
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
        const content = payload.choices?.[0]?.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part.text ?? "").join("") : "";
        if (!text.trim()) throw new Error(route.id + "_empty_response");
        state.latencyMs = Date.now() - started; state.failures = 0; state.cooldownUntil = 0;
        return { provider: route.id, model: route.model, text, latencyMs: state.latencyMs };
      } catch (error) {
        lastError = error;
        if (state.cooldownUntil <= Date.now()) state.cooldownUntil = Date.now() + this.cooldownMs;
        state.failures += 1;
      }
    }
    throw new Error("no_free_llm_route_available:" + (lastError instanceof Error ? lastError.message : "no_routes_configured"));
  }
}
export function createFreeRouteHunter(): FreeRouteHunter { return new FreeRouteHunter(buildFreeLlmRoutes()); }
