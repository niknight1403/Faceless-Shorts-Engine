console.log("faceless worker process booted; queue adapter is implemented in Sprint 2");
const shutdown = () => process.exit(0);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
