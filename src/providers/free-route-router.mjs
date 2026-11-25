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
      const signal = AbortSignal.timeout(this.timeoutMs);
      try {
        const result = await route[capability](input, { signal });
        signal.throwIfAborted();
        if (result == null) throw new Error("Empty provider result");
        this.blocked.delete(route);
        return result;
      } catch (error) {
        this.blocked.set(route, this.now() + this.cooldownMs);
      }
    }
    throw Object.assign(new Error("No eligible zero-cost provider available"), { code: "FREE_ROUTE_UNAVAILABLE" });
  }
}
