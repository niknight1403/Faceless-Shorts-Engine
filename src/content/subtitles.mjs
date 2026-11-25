function timestamp(seconds) {
  const ms = Math.round(seconds * 1000);
  const pad = (n, width=2) => String(n).padStart(width,"0");
  return pad(Math.floor(ms/3600000))+":"+pad(Math.floor(ms/60000)%60)+":"+pad(Math.floor(ms/1000)%60)+","+pad(ms%1000,3);
}
export function createSubtitles(scenes) {
  if (!Array.isArray(scenes) || !scenes.length || scenes.length > 12) throw new Error("Invalid scenes");
  let elapsed = 0;
  return scenes.map((scene,index)=>{
    if (!Number.isInteger(scene.seconds) || scene.seconds < 1 || typeof scene.narration !== "string" || !scene.narration.trim()) throw new Error("Invalid subtitle scene");
    const start=elapsed;
    elapsed+=scene.seconds;
    if(elapsed>60) throw new Error("Duration exceeds 60 seconds");
    const caption=scene.narration.replace(/[\r\n\t]+/g," ").replace(/</g,"‹").replace(/>/g,"›").trim();
    return (index+1)+"\n"+timestamp(start)+" --> "+timestamp(elapsed)+"\n"+caption+"\n";
  }).join("\n");
}
