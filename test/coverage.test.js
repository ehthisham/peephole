import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCoverage, coverageStamp } from "../src/coverage.js";

// detectCoverage reads coverage artifacts straight from the working tree and now finds them in the
// standard places (root + monorepo subdirs), merging across sources. Pure fs parsing, no toolchain.

let tmp;
function w(rel, body) {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peephole-cov-")); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const GO_PROFILE =
  "mode: set\n" +
  "example.com/o/r/internal/a/x.go:1.1,2.2 2 1\n" +
  "example.com/o/r/internal/a/y.go:1.1,2.2 2 0\n" +
  "example.com/o/r/internal/b/z.go:1.1,2.2 1 1\n";

test("no coverage anywhere → null, and the stamp is null", async () => {
  assert.equal(await detectCoverage(tmp), null);
  assert.equal(await coverageStamp(tmp), null);
});

test("a Go profile at the repo root is parsed, statement-weighted, worst-first", async () => {
  w("coverage.out", GO_PROFILE);
  const cov = await detectCoverage(tmp);
  assert.equal(cov.tool, "go");
  assert.equal(Math.round(cov.pct), 60); // 3 of 5 statements
  assert.deepEqual(cov.modules.map((m) => m.pkg), ["internal/a", "internal/b"]); // 50% before 100%
  assert.equal(cov.modules[0].pct, 50);
  assert.ok((await coverageStamp(tmp)) !== null);
});

test("an istanbul summary in a monorepo subdir is found and merged, pkg prefixed by the subdir", async () => {
  // Alongside the root Go profile from the previous test — detection must union both.
  w("client/coverage/coverage-summary.json", JSON.stringify({
    total: { lines: { total: 10, covered: 5, pct: 50 } },
    "src/app.js": { lines: { total: 10, covered: 5, pct: 50 } },
  }));
  const cov = await detectCoverage(tmp);
  assert.equal(cov.tool, "mixed"); // go + istanbul
  assert.equal(Math.round(cov.pct), 53); // (3+5) of (5+10)
  assert.ok(cov.modules.some((m) => m.pkg === "client/src"), "istanbul module is prefixed by its base dir");
  assert.ok(cov.modules.some((m) => m.pkg === "internal/a"), "root go module keeps its bare pkg");
  assert.equal(cov.sources.length, 2);
});

test("the stamp changes when a profile changes on disk", async () => {
  const before = await coverageStamp(tmp);
  w("coverage.out", GO_PROFILE + "example.com/o/r/internal/c/w.go:1.1,2.2 3 1\n");
  assert.notEqual(await coverageStamp(tmp), before);
});
