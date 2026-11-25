import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { planScript } from "../content/script-planner.mjs";
import { createSubtitles } from "../content/subtitles.mjs";

const ACTIVE_STATUSES = new Set(["generating_assets", "rendering", "validating"]);

export class JobRunner {
  constructor({ store, provider, renderer, validator, config, textRegistry = null, speechProvider = null }) {
    this.store = store;
    this.provider = provider;
    this.renderer = renderer;
    this.validator = validator;
    this.config = config;
    this.textRegistry = textRegistry;
    this.speechProvider = speechProvider;
    this.queue = [];
    this.scheduled = new Set();
    this.isPumping = false;
  }

  async recover() {
    for (const job of this.store.list()) {
      if (job.status === "queued") {
        this.enqueue(job.id);
      } else if (ACTIVE_STATUSES.has(job.status)) {
        await this.store.update(job.id, current => {
          current.status = "failed";
          current.currentStep = "failed";
          current.error = {
            code: "PROCESS_INTERRUPTED",
            message: "Der lokale Prozess wurde während der Verarbeitung beendet. Du kannst den Schritt erneut starten.",
          };
          current.completedAt = new Date().toISOString();
        });
      }
    }
  }

  enqueue(jobId) {
    if (this.scheduled.has(jobId)) return;
    this.scheduled.add(jobId);
    this.queue.push(jobId);
    void this.pump();
  }

  async retry(jobId) {
    const existing = this.store.get(jobId);
    if (!existing) return null;
    if (existing.status !== "failed") {
      const error = new Error("Nur fehlgeschlagene Aufträge können erneut gestartet werden.");
      error.code = "JOB_NOT_RETRYABLE";
      throw error;
    }
    await this.store.update(jobId, job => {
      job.status = "queued";
      job.progress = 0;
      job.currentStep = "queued";
      job.steps = [];
      job.output = null;
      job.error = null;
      job.completedAt = null;
    });
    this.enqueue(jobId);
    return this.store.get(jobId);
  }

  async pump() {
    if (this.isPumping) return;
    this.isPumping = true;
    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift();
        try {
          await this.run(jobId);
        } catch (error) {
          console.error(`[job:${jobId}] Queue error: ${error.code || error.name || "UNKNOWN"}`);
        } finally {
          this.scheduled.delete(jobId);
        }
      }
    } finally {
      this.isPumping = false;
      if (this.queue.length > 0) void this.pump();
    }
  }

  async run(jobId) {
    const job = this.store.get(jobId);
    if (!job || job.status !== "queued") return;
    const jobDirectory = this.store.getJobDirectory(jobId);
    const assetDirectory = join(jobDirectory, "assets");
    try {
      await mkdir(assetDirectory, { recursive: true });
      const imagePath = join(assetDirectory, "scene.png");
      const audioPath = join(assetDirectory, "voice.wav");
      const outputPath = join(jobDirectory, "final.mp4");

      let plan = null;
      if (this.textRegistry) {
        plan = await this.runStep(jobId, "plan_script", "generating_assets", 5, async () => {
          const result = await planScript(this.textRegistry, job);
          await writeFile(join(assetDirectory, "script.json"), JSON.stringify(result), {mode:0o600});
          await writeFile(join(assetDirectory, "subtitles.srt"), createSubtitles(result.scenes), {mode:0o600});
          return result;
        });
      }
      await this.runStep(jobId, "fetch_image", "generating_assets", 10, async () => {
        return this.provider.fetchImage({ prompt: plan?.scenes[0].visual || job.topic, outputPath: imagePath });
      });
      await this.runStep(jobId, "fetch_audio", "generating_assets", 22, async () => {
        return (this.speechProvider || this.provider).synthesizeSpeech({ text: plan ? plan.scenes.map(s => s.narration).join(" ") : job.topic, outputPath: audioPath });
      });
      await this.runStep(jobId, "render_video", "rendering", 55, async () => {
        return this.renderer.render({
          imagePath,
          audioPath,
          outputPath,
          caption: plan?.title || job.topic,
          speech: Boolean(this.speechProvider),
          durationSeconds: job.durationSeconds,
        });
      });
      const metadata = await this.runStep(jobId, "validate_video", "validating", 85, async () => {
        return this.validator.validate({
          filePath: outputPath,
          expectedDurationSeconds: job.durationSeconds,
        });
      });

      await this.store.update(jobId, current => {
        current.status = "completed";
        current.progress = 100;
        current.currentStep = "completed";
        current.output = { filename: "final.mp4", ...metadata };
        current.error = null;
        current.completedAt = new Date().toISOString();
      });
    } catch (error) {
      console.error(`[job:${jobId}] ${error.name || "Error"}: ${error.message || "unknown error"}`);
      try {
        await this.store.update(jobId, current => {
          current.status = "failed";
          current.currentStep = "failed";
          current.error = {
            code: error.code || "JOB_FAILED",
            message: error.publicMessage || "Der Auftrag ist fehlgeschlagen. Prüfe die Server-Logs und starte den Job bei Bedarf erneut.",
          };
          current.completedAt = new Date().toISOString();
        });
      } catch (storeError) {
        console.error(`[job:${jobId}] Status konnte nicht gespeichert werden: ${storeError.message}`);
      }
    }
  }

  async runStep(jobId, name, status, progress, action) {
    const startedAt = new Date().toISOString();
    await this.store.update(jobId, job => {
      job.status = status;
      job.progress = progress;
      job.currentStep = name;
      job.error = null;
      job.steps.push({ name, status: "running", startedAt, finishedAt: null, errorCode: null });
    });

    try {
      const result = await action();
      const finishedAt = new Date().toISOString();
      await this.store.update(jobId, job => {
        const step = [...job.steps].reverse().find(item => item.name === name && item.status === "running");
        if (step) {
          step.status = "completed";
          step.finishedAt = finishedAt;
          if (result && typeof result === "object") step.result = result;
        }
      });
      return result;
    } catch (error) {
      const finishedAt = new Date().toISOString();
      await this.store.update(jobId, current => {
        const step = [...current.steps].reverse().find(item => item.name === name && item.status === "running");
        if (step) {
          step.status = "failed";
          step.finishedAt = finishedAt;
          step.errorCode = error.code || "STEP_FAILED";
        }
      });
      throw error;
    }
  }
}
