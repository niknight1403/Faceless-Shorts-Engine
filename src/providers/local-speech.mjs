import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
const run = promisify(execFile);
export class LocalSpeech {
  constructor({ voice = "de", timeoutMs = 15000 } = {}) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(voice)) throw new Error("Invalid voice");
    this.voice = voice;
    this.timeoutMs = timeoutMs;
  }
  async synthesizeSpeech({ text, outputPath }) {
    if (typeof text !== "string" || !text.trim() || text.length > 12000 || text.includes("\0")) throw new Error("Invalid speech text");
    await mkdir(dirname(outputPath), {recursive:true});
    await run("espeak-ng", ["-v",this.voice,"-w",outputPath,"--",text], {timeout:this.timeoutMs,maxBuffer:65536});
    const info = await stat(outputPath);
    if (!info.isFile() || info.size <= 44) throw new Error("Empty speech output");
    return {mimeType:"audio/wav",sizeBytes:info.size,provider:"espeak-ng"};
  }
}
