import { readBoundedResponse } from "./http-response.js";
export interface VisualRequest {
  prompt: string;
  width?: number;
  height?: number;
}

export interface VisualResult {
  provider: string;
  mimeType: string;
  extension: string;
  image: Buffer;
}

export interface VisualProvider {
  readonly id: string;
  generate(input: VisualRequest): Promise<VisualResult>;
}

/** Anonymous Pollinations image route. No API key or paid model is used. */
export class PollinationsVisualProvider implements VisualProvider {
  readonly id = "pollinations-free";

  constructor(private readonly request: typeof fetch = fetch) {}

  async generate(input: VisualRequest): Promise<VisualResult> {
    const width = input.width ?? 720;
    const height = input.height ?? 1280;
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 2_000) {
      throw new Error("visual_prompt_must_be_1_to_2000_characters");
    }
    if (!Number.isInteger(width) || width < 256 || width > 2048 ||
        !Number.isInteger(height) || height < 256 || height > 2048) {
      throw new Error("visual_dimensions_must_be_integers_between_256_and_2048");
    }
    const prompt = [
      input.prompt,
      "cinematic editorial illustration, high detail, no text, vertical composition",
    ].join(", ");
    const endpoint = process.env.VISUALS_BASE_URL?.trim().replace(/\/+$/, "") ||
      "https://image.pollinations.ai/prompt";
    const url =
      endpoint +
      "/" +
      encodeURIComponent(prompt) +
      "?width=" +
      width +
      "&height=" +
      height +
      "&nologo=true&safe=true";
    const response = await this.request(url, {
      signal: AbortSignal.timeout(120_000),
      headers: { accept: "image/jpeg,image/png,image/webp" },
    });
    if (!response.ok) throw new Error("pollinations_http_" + response.status);

    const mimeType = (response.headers.get("content-type") ?? "")
      .split(";")[0]!
      .toLowerCase();
    const extension =
      mimeType === "image/png"
        ? "png"
        : mimeType === "image/webp"
          ? "webp"
          : mimeType === "image/jpeg"
            ? "jpg"
            : "";
    if (!extension) {
      throw new Error("visual_provider_unsupported_content_type:" + mimeType);
    }

    const image = await readBoundedResponse(response, 20971520, "visual_provider_image");
    if (image.byteLength < 1024) {
      throw new Error("visual_provider_image_too_small");
    }
    if (image.byteLength > 20 * 1024 * 1024) {
      throw new Error("visual_provider_image_too_large");
    }
    return { provider: this.id, mimeType, extension, image };
  }
}

export class VisualRouter {
  constructor(
    private readonly providers: VisualProvider[] = [
      new PollinationsVisualProvider(),
    ],
  ) {}

  availableRoutes(): string[] {
    return this.providers.map((provider) => provider.id);
  }

  async generate(input: VisualRequest): Promise<VisualResult> {
    const errors: string[] = [];
    for (const provider of this.providers) {
      try {
        return await provider.generate(input);
      } catch (error) {
        errors.push(
          provider.id +
            ":" +
            (error instanceof Error ? error.message : "failed"),
        );
      }
    }
    throw new Error(
      "no_visual_route_available:" +
        (errors.join("|") || "no_routes_configured"),
    );
  }
}
