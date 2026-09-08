import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRelease, compareReleaseInventory } from "../lib/release-check.js";

test("release inventory detects changed, added and missing cache source bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "release-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), cache = join(root, "cache");
  await mkdir(source); await mkdir(cache);
  await writeFile(join(source, "runtime.js"), "original");
  await writeFile(join(cache, "runtime.js"), "original");
  assert.equal((await compareReleaseInventory(source, cache)).installedMatches, true);
  await writeFile(join(cache, "runtime.js"), "changed!");
  await assert.rejects(compareReleaseInventory(source, cache), /runtime.js/u);
  await writeFile(join(cache, "runtime.js"), "original");
  await writeFile(join(cache, "extra.js"), "extra");
  await assert.rejects(compareReleaseInventory(source, cache), /extra.js/u);
  await rm(join(cache, "extra.js")); await rm(join(cache, "runtime.js"));
  await assert.rejects(compareReleaseInventory(source, cache), /runtime.js/u);
});

test("release metadata and single skill are coherent; global duplicates fail discovery", async (t) => {
  const globalSkillsRoot = await mkdtemp(join(tmpdir(), "genbio-skill-check-"));
  t.after(() => rm(globalSkillsRoot, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  assert.equal((await checkRelease(root, { globalSkillsRoot })).duplicateAbsent, true);
  await mkdir(join(globalSkillsRoot, "operate-genbio-hpc-remote"));
  await assert.rejects(checkRelease(root, { globalSkillsRoot }), /duplicate global/);
});
