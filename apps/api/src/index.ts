import { createServer } from "node:http";

const port = Number(process.env.API_PORT ?? 4000);

const server = createServer((request, response) => {
  if (request.url === "/health/live") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "faceless-api" }));
    return;
  }

  if (request.url === "/health/ready") {
    const ready = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: ready ? "ready" : "configuration_missing" }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`faceless-api listening on :${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
