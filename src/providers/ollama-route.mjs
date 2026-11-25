export function createOllamaRoute({ model, baseUrl = "http://127.0.0.1:11434", fetchImpl = fetch } = {}) {
  if (typeof model !== "string" || !model.trim()) throw new Error("Local model required");
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Only local Ollama is supported");
  return {
    zeroCost: true,
    async text({ prompt }, { signal } = {}) {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000) throw new Error("Invalid prompt");
      const response = await fetchImpl(new URL("/api/generate", url), {
        method: "POST", redirect: "error", signal,
        headers: {"content-type":"application/json"},
        body: JSON.stringify({model, prompt, stream:false})
      });
      if (!response.ok) throw new Error("Ollama HTTP " + response.status);
      const data = await response.json();
      if (typeof data.response !== "string" || !data.response.trim()) throw new Error("Empty Ollama response");
      return data.response;
    }
  };
}
