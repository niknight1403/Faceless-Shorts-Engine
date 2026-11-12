import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

const required = ["DATABASE_URL", "REDIS_URL", "ASSET_SIGNING_SECRET"];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
  console.error("Missing required environment variables:", missing.join(", "));
  process.exit(1);
}
if (process.env.ASSET_SIGNING_SECRET.length < 32) {
  console.error("ASSET_SIGNING_SECRET must contain at least 32 characters.");
  process.exit(1);
}

const mediaDir = process.env.MEDIA_STORAGE_DIR ?? "/var/lib/faceless/media";
if (!mediaDir.startsWith("/")) {
  console.error("MEDIA_STORAGE_DIR must be an absolute path.");
  process.exit(1);
}
await mkdir(mediaDir, { recursive: true });

const migration = spawn("pnpm", ["exec", "prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: process.env
});
const migrationExit = await new Promise((resolve, reject) => {
  migration.once("error", reject);
  migration.once("exit", code => resolve(code ?? 1));
});
if (migrationExit !== 0) {
  console.error("Database migrations failed; application processes will not start.");
  process.exit(Number(migrationExit));
}

if (process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
  // First-run administrator creation for hosts without shell access. Failure is not fatal:
  // the script refuses to overwrite an existing administrator and that must not stop the app.
  const bootstrap = spawn("pnpm", ["admin:bootstrap"], { stdio: "inherit", env: process.env });
  const bootstrapExit = await new Promise((resolve, reject) => {
    bootstrap.once("error", reject);
    bootstrap.once("exit", code => resolve(code ?? 1));
  });
  if (bootstrapExit === 0) {
    console.log("Administrator bootstrapped from environment variables.");
  } else {
    console.warn("Administrator bootstrap exited with code " + bootstrapExit + "; continuing with the existing accounts.");
  }
}

const children = [
  spawn(process.execPath, ["apps/api/dist/index.js"], { stdio: "inherit", env: process.env }),
  spawn(process.execPath, ["apps/workers/dist/index.js"], { stdio: "inherit", env: process.env })
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(code);
  }, 8000).unref();
}
for (const child of children) {
  child.once("error", error => {
    console.error("Application process failed to start:", error);
    stop(1);
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error("Application process exited unexpectedly:", { code, signal });
      stop(code ?? 1);
    }
  });
}
process.once("SIGTERM", () => stop(0));
process.once("SIGINT", () => stop(0));
console.log("Faceless Shorts API and generation worker started under one supervisor.");
