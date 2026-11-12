import test from "node:test";
import assert from "node:assert/strict";
import { parseByteRange } from "./byte-range.js";

test("parses explicit and open-ended byte ranges", () => {
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=90-", 100), { start: 90, end: 99 });
});

test("parses suffix ranges from the end of the file", () => {
  assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-500", 100), { start: 0, end: 99 });
});

test("clamps an explicit end to the file size", () => {
  assert.deepEqual(parseByteRange("bytes=90-500", 100), { start: 90, end: 99 });
});

test("rejects malformed and unsatisfiable ranges", () => {
  for (const value of ["bytes=", "bytes=-0", "bytes=100-", "bytes=9-2", "items=0-1", "bytes=0-1,4-5"]) {
    assert.equal(parseByteRange(value, 100), null, value);
  }
  assert.equal(parseByteRange("bytes=0-1", 0), null);
});
