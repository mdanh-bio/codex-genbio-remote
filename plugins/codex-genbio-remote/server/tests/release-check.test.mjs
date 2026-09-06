import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRelease } from "../lib/release-check.js";

test("release metadata and single skill are coherent; global duplicates fail discovery", async (t) => {
  const globalSkillsRoot = await mkdtemp(join(tmpdir(), "genbio-skill-check-"));
  t.after(() => rm(globalSkillsRoot, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  assert.equal((await checkRelease(root, { globalSkillsRoot })).duplicateAbsent, true);
  await mkdir(join(globalSkillsRoot, "operate-genbio-hpc-remote"));
  await assert.rejects(checkRelease(root, { globalSkillsRoot }), /duplicate global/);
});
