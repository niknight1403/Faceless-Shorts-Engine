export interface ScriptRequest { topic: string; language: string; targetDurationSeconds: number }
export interface ScriptScene { order: number; narration: string; visualPrompt: string; durationMs: number }
export interface GeneratedScript { title: string; hook: string; scenes: ScriptScene[]; callToAction: string }
export interface ScriptProvider { readonly name: string; generate(input: ScriptRequest): Promise<GeneratedScript> }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function validateScript(script: GeneratedScript, targetDurationSeconds: number): GeneratedScript {
  if (typeof script.title !== "string" || !script.title.trim() || script.title.length > 500 ||
      typeof script.hook !== "string" || !script.hook.trim() || script.hook.length > 1000 ||
      typeof script.callToAction !== "string" || !script.callToAction.trim() || script.callToAction.length > 500) {
    throw new Error("script_metadata_invalid");
  }
  if (!Array.isArray(script.scenes) || script.scenes.length < 3 || script.scenes.length > 20) throw new Error("script_scene_count_invalid");
  script.scenes.forEach((scene, index) => {
    if (!scene || scene.order !== index + 1 ||
        typeof scene.narration !== "string" || !scene.narration.trim() || scene.narration.length > 1000 ||
        typeof scene.visualPrompt !== "string" || !scene.visualPrompt.trim() || scene.visualPrompt.length > 2000) {
      throw new Error("script_scene_invalid");
    }
    if (!Number.isInteger(scene.durationMs) || scene.durationMs < 1000 || scene.durationMs > 30000) throw new Error("script_scene_duration_invalid");
  });
  const total = script.scenes.reduce((sum, scene) => sum + scene.durationMs, 0);
  const target = targetDurationSeconds * 1000;
  if (Math.abs(total - target) > Math.max(5000, target * 0.15)) throw new Error("script_duration_out_of_tolerance");
  return script;
}

/** Deterministic provider for local development and CI; it does not call an LLM. */
export class LocalScriptProvider implements ScriptProvider {
  readonly name = "local-template";
  async generate(input: ScriptRequest): Promise<GeneratedScript> {
    const duration = clamp(Math.round(input.targetDurationSeconds), 10, 180);
    const sceneCount = clamp(Math.ceil(duration / 8), 3, 20);
    const base = Math.floor((duration * 1000) / sceneCount);
    const remainder = duration * 1000 - base * sceneCount;
    const beats = [
      { narration: `Wusstest du, was hinter ${input.topic} steckt?`, visualPrompt: `Cinematic opening shot illustrating ${input.topic}, vertical 9:16` },
      { narration: `Der entscheidende Punkt ist einfacher, als viele denken.`, visualPrompt: `Close-up explanatory visual, clean composition, vertical 9:16` },
      { narration: `Achte besonders auf den Unterschied zwischen Ursache und Wirkung.`, visualPrompt: `Dynamic visual comparison with clear focal point, vertical 9:16` },
      { narration: `So kannst du das Wissen direkt im Alltag nutzen.`, visualPrompt: `Practical real-world example, cinematic lighting, vertical 9:16` },
      { narration: `Wenn du mehr dazu möchtest, bleib für den nächsten Tipp dabei.`, visualPrompt: `Memorable closing frame with room for captions, vertical 9:16` }
    ];
    const scenes = Array.from({ length: sceneCount }, (_, index) => {
      const beat = beats[index % beats.length]!;
      return { order: index + 1, narration: beat.narration, visualPrompt: beat.visualPrompt, durationMs: base + (index < remainder ? 1 : 0) };
    });
    return validateScript({ title: input.topic.trim(), hook: scenes[0]!.narration, scenes, callToAction: "Folge für weitere kurze Tipps." }, duration);
  }
}
