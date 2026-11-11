import { FreeRouteHunter, buildFreeLlmRoutes } from "./free-route-hunter.js";
import { LocalScriptProvider, validateScript, type GeneratedScript, type ScriptProvider, type ScriptRequest } from "./script-generator.js";

export class FreeRoutedScriptProvider implements ScriptProvider {
  readonly name = "free-route-hunter";
  private readonly local = new LocalScriptProvider();
  private readonly hunter: FreeRouteHunter;
  constructor(hunter = new FreeRouteHunter(buildFreeLlmRoutes())) { this.hunter = hunter; }
  routeStatus() { return this.hunter.snapshot(); }
  hubStatus() { return this.hunter.hubStatus(); }
  async generate(input: ScriptRequest): Promise<GeneratedScript> {
    await this.hunter.refreshFromAgentforgeHub();
    if (this.hunter.snapshot().length === 0) return this.local.generate(input);
    const prompt = [
      "Create a concise, engaging vertical short-video script.",
      "Return ONLY JSON with keys title, hook, scenes, callToAction.",
      "Each scene must contain order (1-based integer), narration, visualPrompt, durationMs.",
      "Use the requested language. Make scene durations sum exactly to targetDurationSeconds * 1000.",
      "Use 3 to 20 scenes, each between 1000 and 30000 milliseconds.",
      JSON.stringify(input)
    ].join("\n");
    try {
      const result = await this.hunter.generate(prompt);
      const cleaned = result.text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
      const parsed = JSON.parse(cleaned) as GeneratedScript;
      const validated = validateScript(parsed, input.targetDurationSeconds);
      console.log("script generated via " + result.provider + "/" + result.model + " in " + result.latencyMs + "ms");
      return validated;
    } catch (error) {
      console.warn("Free LLM routes unavailable or returned invalid script; using local template fallback", error);
      return this.local.generate(input);
    }
  }
}
