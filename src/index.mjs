import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { createApiServer } from "./api/server.mjs";

export async function startServer(config = loadConfig()) {
  const application = await createApiServer({ config });
  await new Promise((resolveListen, rejectListen) => {
    application.server.once("error", rejectListen);
    application.server.listen(config.port, config.host, resolveListen);
  });
  console.log(`Faceless-Shorts-Engine API läuft auf http://${config.host}:${config.port}`);
  console.log(`Mock-Medienanbieter: ${config.providerBaseUrl}`);

  let closing = false;
  const shutdown = signal => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} empfangen; HTTP-Server wird beendet.`);
    const hardStop = setTimeout(() => process.exit(1), 10_000);
    hardStop.unref?.();
    application.server.close(() => {
      clearTimeout(hardStop);
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  return application;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  startServer().catch(error => {
    console.error(`Start fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
  });
}
