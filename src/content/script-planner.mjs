export async function planScript(registry, {topic, durationSeconds}) {
  if (typeof topic !== "string" || !topic.trim() || topic.length > 240 || !Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) throw new Error("Invalid short request");
  const raw = await registry.generate("Create a factual short video script in the language of the topic. Return only JSON with title and scenes (array of objects with narration, visual, seconds as positive integer). Total seconds must equal "+durationSeconds+". Do not invent factual claims. Topic data: "+JSON.stringify(topic));
  if (typeof raw !== "string" || raw.length > 30000) throw new Error("Invalid script response");
  const plan = JSON.parse(raw);
  const validText = (s,max) => typeof s === "string" && s.trim().length > 0 && s.length <= max;
  if (!plan || !validText(plan.title,120) || !Array.isArray(plan.scenes) || plan.scenes.length < 1 || plan.scenes.length > 12) throw new Error("Invalid script structure");
  let total=0;
  const scenes=plan.scenes.map(s=>{
    if (!s || !validText(s.narration,1000) || !validText(s.visual,500) || !Number.isInteger(s.seconds) || s.seconds < 1) throw new Error("Invalid scene");
    total+=s.seconds;
    return {narration:s.narration,visual:s.visual,seconds:s.seconds};
  });
  if(total!==durationSeconds) throw new Error("Scene duration mismatch");
  return {title:plan.title,scenes};
}
