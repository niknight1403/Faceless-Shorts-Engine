import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedResponse } from "./http-response.js";
import { runRendererProcess } from "./video-renderer.js";
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

  /**
   * The anonymous route rate-limits bursts with 402/429 and occasionally 5xx while a scene set is
   * generated in parallel, so retry with a widening delay before the router falls back.
   */
  private async requestWithBackoff(url: string): Promise<Response> {
    const delays = [0, 3_000, 8_000];
    let last: Response | undefined;
    for (const waitMs of delays) {
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const response = await this.request(url, {
        signal: AbortSignal.timeout(120_000),
        headers: { accept: "image/jpeg,image/png,image/webp" },
      });
      last = response;
      if (response.ok || (response.status !== 402 && response.status !== 429 && response.status < 500)) {
        return response;
      }
    }
    return last!;
  }

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
    const response = await this.requestWithBackoff(url);
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

const PLATE_PALETTES: ReadonlyArray<readonly [string, string]> = [
  ["0x101828", "0x2f5060"],
  ["0x1b1030", "0x4b2f6b"],
  ["0x0f2420", "0x2f6b57"],
  ["0x241a10", "0x6b4a2f"],
];

function platePalette(seed: string): readonly [string, string] {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return PLATE_PALETTES[hash % PLATE_PALETTES.length]!;
}

/**
 * Offline fallback: renders a deterministic gradient plate with ffmpeg so a job still finishes when
 * every hosted image route is rate limited. It is only reached after the hosted routes failed.
 */
export class LocalPlateVisualProvider implements VisualProvider {
  readonly id = "local-plate";

  async generate(input: VisualRequest): Promise<VisualResult> {
    const width = input.width ?? 720;
    const height = input.height ?? 1280;
    if (typeof input.prompt !== "string" || !input.prompt.trim()) {
      throw new Error("visual_prompt_required");
    }
    const [c0, c1] = platePalette(input.prompt);
    const directory = await mkdtemp(join(tmpdir(), "faceless-plate-"));
    const output = join(directory, "plate.jpg");
    try {
      await runRendererProcess(process.env.FFMPEG_BIN?.trim() || "ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `gradients=s=${width}x${height}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${width}:y1=${height}:d=1`,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        output,
      ]);
      const image = await readFile(output);
      if (image.byteLength < 1024) throw new Error("visual_provider_image_too_small");
      return { provider: this.id, mimeType: "image/jpeg", extension: "jpg", image };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export class VisualRouter {
  constructor(
    private readonly providers: VisualProvider[] = [
      new PollinationsVisualProvider(),
      ...(process.env.VISUALS_LOCAL_ENABLED === "false" ? [] : [new LocalPlateVisualProvider()]),
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
