import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface VisualRequest { prompt: string; width?: number; height?: number }
export interface VisualResult { provider: string; mimeType: string; extension: string; image: Buffer }
export interface VisualProvider { readonly id: string; generate(input: VisualRequest): Promise<VisualResult> }

const env = (name: string) => process.env[name]?.trim() || undefined;

/** Anonymous Pollinations image route. No API key or paid model is used. */
export class PollinationsVisualProvider implements VisualProvider {
  readonly id = "pollinations-free";
  constructor(private readonly request: typeof fetch = fetch) {}
  async generate(input: VisualRequest): Promise<VisualResult> {
    const prompt = [input.prompt, "cinematic editorial illustration, high detail, no text, vertical composition"].join(", ");
    const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt)
      + "?width=" + (input.width ?? 720) + "&height=" + (input.height ?? 1280) + "&nologo=true&safe=true";
    const response = await this.request(url, { signal: AbortSignal.timeout(120_000), headers: { accept: "image/jpeg,image/png,image/webp" } });
    if (!response.ok) throw new Error("pollinations_http_" + response.status);
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.toLowerCase();
    const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    if (!mimeType.startsWith("image/")) throw new Error("visual_provider_invalid_content_type:" + mimeType);
    const image = Buffer.from(await response.arrayBuffer());
    if (image.byteLength < 1024) throw new Error("visual_provider_image_too_small");
    if (image.byteLength > 20 * 1024 * 1024) throw new Error("visual_provider_image_too_large");
    return { provider: this.id, mimeType, extension, image };
  }
}

export class VisualRouter {
  constructor(private readonly providers: VisualProvider[] = [new PollinationsVisualProvider()]) {}
  availableRoutes(): string[] { return this.providers.map(provider => provider.id); }
  async generate(input: VisualRequest): Promise<VisualResult> {
    const errors: string[] = [];
    for (const provider of this.providers) {
      try { return await provider.generate(input); }
      catch (error) { errors.push(provider.id + ":" + (error instanceof Error ? error.message : "failed")); }
    }
    throw new Error("no_visual_route_available:" + (errors.join("|") || "no_routes_configured"));
  }
}

export async function persistVisual(result: VisualResult, directory: string, index: number): Promise<{ fileName: string; storageKey: string }> {
  await mkdir(directory, { recursive: true });
  const fileName = String(index + 1).padStart(3, "0") + "." + result.extension;
  await writeFile(join(directory, fileName), result.image);
  return { fileName, storageKey: fileName };
}
