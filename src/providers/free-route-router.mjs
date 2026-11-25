// Only explicitly configured, verified zero-cost routes are eligible.
export class FreeRouteRouter {
  constructor(routes, { timeoutMs = 15000, cooldownMs = 30000, now = Date.now } = {}) {
    this.routes = routes.filter(r => r.zeroCost === true);
    this.timeoutMs = timeoutMs;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.blocked = new Map();
  }
  async execute(capability, input) {
    for (const route of this.routes) {
      if (typeof route[capability] !== "function" || (this.blocked.get(route) ?? 0) > this.now()) continue;
      const controller = new AbortController();
      const signal = controller.signal;
      let timer;
      try {
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("Provider timeout")); }, this.timeoutMs);
        });
        const result = await Promise.race([Promise.resolve().then(() => route[capability](input, { signal })), deadline]);
        signal.throwIfAborted();
        if (result == null) throw new Error("Empty provider result");
        this.blocked.delete(route);
        return result;
      } catch (error) {
        this.blocked.set(route, this.now() + this.cooldownMs);
      } finally {
        clearTimeout(timer);
      }
    }
    throw Object.assign(new Error("No eligible zero-cost provider available"), { code: "FREE_ROUTE_UNAVAILABLE" });
  }
}
