import test from "node:test";
import assert from "node:assert/strict";
import { createOllamaRoute } from "../src/providers/ollama-route.mjs";
test("reject remote endpoint",()=>assert.throws(()=>createOllamaRoute({model:"local",baseUrl:"https://example.com"})));
test("generate local script",async()=>{
 const route=createOllamaRoute({model:"local",fetchImpl:async(url,opts)=>{
 assert.equal(url.href,"http://127.0.0.1:11434/api/generate");
 assert.equal(JSON.parse(opts.body).stream,false);
 assert.equal(opts.redirect,"error");
 return new Response(JSON.stringify({response:"A script"}));
 }});
 assert.equal(await route.text({prompt:"Write a short"}),"A script");
});
test("reject provider failure",async()=>{
 const route=createOllamaRoute({model:"local",fetchImpl:async()=>new Response("",{status:503})});
 await assert.rejects(route.text({prompt:"test"}),/503/);
});
