import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fetchArtifacts } from "../lib/execution-core.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "fetch-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = { "a.txt": "alpha", "b.txt": "bravo" };
  let selected = [], active = 0, peak = 0;
  const args = {
    manifest: { target: "NHPC", project: "demo", localRoot: root, remoteRoot: "/approved/run", fetch: { dest: "results", files: Object.keys(data), maxBytes: 1024 } },
    exec: {}, config: {},
    userQuestions: { ask: async ({ questions }) => ({ answers: [{ id: questions[0].id, selected: ["Approve this retrieval"] }] }) },
    runRemote: async (target, command) => {
      assert.equal(target, "NHPC");
      selected = Object.keys(data).filter((name) => command.includes(`'${name}'`));
      return { exitCode: 0, stdout: selected.map((name) => `OK|${name}|${Buffer.byteLength(data[name])}|${createHash("sha256").update(data[name]).digest("hex")}`).join("\n") };
    },
    shell: { resolve: (request) => request, run: async ({ command }) => {
      active++; peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const destination = command.match(/'([^']+)'$/u)[1];
        const name = destination.split("/").at(-1);
        await writeFile(destination, data[name]);
        return { exitCode: 0 };
      } finally { active--; }
    } }
  };
  return { root, data, args, peak: () => peak, fetch: (files) => fetchArtifacts({ ...args, requested: files }) };
}
test("repeat fetch merges new files, preserves identical bytes, and serializes concurrent calls", async (t) => {
  const f = await fixture(t);
  await f.fetch(["a.txt"]);
  await Promise.all([f.fetch(["a.txt"]), f.fetch(["b.txt"])]);
  assert.equal(f.peak(), 1);
  assert.equal(await readFile(join(f.root, "results/a.txt"), "utf8"), "alpha");
  assert.equal(await readFile(join(f.root, "results/b.txt"), "utf8"), "bravo");
  assert.equal((await readdir(join(f.root, "results"))).filter((name) => name.startsWith("FETCH_RECEIPT_")).length, 3);
});
test("merge prevalidates all conflicts before adding files", async (t) => {
  const f = await fixture(t);
  await f.fetch(["a.txt"]);
  f.data["a.txt"] = "changed";
  await assert.rejects(f.fetch(["b.txt", "a.txt"]), /conflict/u);
  await assert.rejects(readFile(join(f.root, "results/b.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.root, "results/a.txt"), "utf8"), "alpha");
});
test("corrupt receipts and symlinked destination files fail closed", async (t) => {
  const f = await fixture(t);
  const first = await f.fetch(["a.txt"]);
  await writeFile(first.receiptPath, "{corrupt");
  await assert.rejects(f.fetch(["b.txt"]));
  await rm(join(f.root, "results"), { recursive: true });
  await f.fetch(["a.txt"]);
  await rm(join(f.root, "results/a.txt"));
  await symlink(join(f.root, "outside"), join(f.root, "results/a.txt"));
  await assert.rejects(f.fetch(["a.txt"]), /symbolic link/u);
});
