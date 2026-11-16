export type JobStatus = "queued" | "planning" | "generating_script" | "generating_voice" | "generating_visuals" | "rendering" | "validating" | "awaiting_approval" | "publishing" | "completed" | "failed" | "cancelled";
export interface SceneBeat { id: string; order: number; narration: string; visualPrompt: string; durationMs: number }
export interface VideoJobRequest { projectId: string; topic: string; language: string; targetPlatforms: Array<"youtube" | "tiktok" | "instagram">; targetDurationSeconds: number }
export interface VideoJobSnapshot { id: string; status: JobStatus; progress: number; errorCode?: string; outputAssetId?: string; createdAt: string; updatedAt: string }
export interface ProviderResult<T> { provider: string; model: string; requestId?: string; usage?: { inputTokens?: number; outputTokens?: number; costMicros?: number }; data: T }
