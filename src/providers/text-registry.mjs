import { FreeRouteRouter } from "./free-route-router.mjs";
import { createOllamaRoute } from "./ollama-route.mjs";
import { createCloudTextRoute } from "./cloud-text-route.mjs";

export function createTextRegistry(env = process.env, options = {}) {
  const routes = [];
  if (env.OLLAMA_MODEL) routes.push(createOllamaRoute({model:env.OLLAMA_MODEL,baseUrl:env.OLLAMA_BASE_URL,fetchImpl:options.fetchImpl}));
  for (const provider of ["cerebras","groq","openrouter"]) {
    const prefix = provider.toUpperCase();
    if (env[prefix+"_FREE_QUOTA_CONFIRMED"] !== "true") continue;
    routes.push(createCloudTextRoute({provider,model:env[prefix+"_MODEL"],apiKey:env[prefix+"_API_KEY"],freeQuotaConfirmed:true,fetchImpl:options.fetchImpl}));
  }
  const router = new FreeRouteRouter(routes,options);
  return {
    configuredRoutes: routes.length,
    generate: (prompt) => router.execute("text",{prompt})
  };
}
