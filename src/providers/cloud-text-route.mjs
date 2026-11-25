const endpoints = Object.freeze({
  cerebras: "https://api.cerebras.ai/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions"
});
export function createCloudTextRoute({ provider, model, apiKey, freeQuotaConfirmed = false, fetchImpl = fetch } = {}) {
  if (!Object.hasOwn(endpoints, provider) || !model || !apiKey || freeQuotaConfirmed !== true) throw new Error("Explicit free-quota configuration required");
  if (provider === "openrouter" && !model.endsWith(":free")) throw new Error("Free model required");
  return {
    zeroCost: true,
    async text({prompt}, {signal} = {}) {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000) throw new Error("Invalid prompt");
      const response = await fetchImpl(endpoints[provider], {
        method:"POST", redirect:"error", signal,
        headers:{"content-type":"application/json",authorization:"Bearer "+apiKey},
        body:JSON.stringify({model,messages:[{role:"user",content:prompt}],max_tokens:1024,stream:false})
      });
      if (!response.ok) throw new Error("Provider HTTP "+response.status);
      const data=await response.json();
      const result=data.choices?.[0]?.message?.content;
      if(typeof result!=="string" || !result.trim()) throw new Error("Empty provider response");
      return result;
    }
  };
}
