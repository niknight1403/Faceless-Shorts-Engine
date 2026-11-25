import test from "node:test";
import assert from "node:assert/strict";
import { FreeRouteRouter } from "../src/providers/free-route-router.mjs";
test("paid routes never execute", async () => {
  let called = false;
  const router = new FreeRouteRouter([{zeroCost:false, text:async()=>{called=true;}}]);
  await assert.rejects(router.execute("text",{}), {code:"FREE_ROUTE_UNAVAILABLE"});
  assert.equal(called,false);
});
test("failed route cools down and fallback succeeds", async () => {
  let calls=0;
  const router=new FreeRouteRouter([
    {zeroCost:true,text:async()=>{calls++;throw Error("offline");}},
    {zeroCost:true,text:async()=>"ok"}
  ],{now:()=>100});
  assert.equal(await router.execute("text",{}),"ok");
  assert.equal(await router.execute("text",{}),"ok");
  assert.equal(calls,1);
});
