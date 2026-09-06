import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createAizymeH100PrepTools, H100_PREP_ARCHIVE_SHA } from "../lib/aizyme-h100-prep.js";

const payload = await readFile(new URL("../fixtures/aizyme-h100/stage2_prepare_genbioh100.sh", import.meta.url), "utf8");
const source = await readFile(new URL("../lib/aizyme-h100-prep.js", import.meta.url), "utf8");
const registrationSource = await readFile(new URL("../mcp/h100-tools.js", import.meta.url), "utf8");

test("preparation payload is syntax-valid and cannot certify G2", () => {
  const r = spawnSync("/bin/bash", ["-n", "-"], { input: payload, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(payload, />\s*"?\$?[^\n]*G2_PASS/u);
  assert.doesNotMatch(payload, />\s*"?\$?[^\n]*STAGE2_PASS/u);
  assert.match(payload, /PREPARATION_PASS/u);
  assert.match(payload, /tar -xzf "\$ARCHIVE" -C "\$rm_guard" \.\/environment\.yml/u);
  assert.match(payload, /CUDA_VISIBLE_DEVICES=0/u);
  assert.match(payload, /torch\.cuda\.device_count\(\) == 1/u);
  assert.match(payload, /facebook\/esmfold_v1/u);
  assert.match(payload, /HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1/u);
});

test("preparation launcher is registered and pins exact-once safeguards", () => {
  assert.match(registrationSource, /createAizymeH100PrepTools/u);
  assert.match(registrationSource, /register\("genbio_aizyme_h100_prepare"/u);
  assert.match(registrationSource, /register\("genbio_aizyme_h100_prepare_status"/u);
  assert.match(source, /randomBytes\(16\)/u);
  assert.match(source, /runRegistry\.list\(exec\.agent\.session\.id\)/u);
  assert.match(source, /prep-h100-\$\{token\}/u);
  assert.match(source, /rclone copyto/u);
  assert.match(source, /StrictHostKeyChecking=yes/u);
  assert.match(source, /Approve preparation/u);
  assert.match(source, /PREPARATION_PASS/u);
  assert.match(source, /token=\/\/p/u);
  assert.equal(H100_PREP_ARCHIVE_SHA, "f408113ab7c2fbbfa2771312d0c0eaae308565da521f0d01f713ddc04441a70a");
});

test("preparation admission fails without exact H100 envelope", async () => {
  const state = { policy: { hash: "x" }, envelope: null, runs: [] };
  const tools = createAizymeH100PrepTools({
    makeTool: (name, description, parameters, execute) => ({ name, description, parameters, execute }),
    requirePolicy: () => ({ targets: { genbioh100: { surface: "direct", login_shell: false, limits: { gpus_allowed: [0] } } } }),
    requireState: () => state,
    publicState: () => ({}), runRemote: async () => ({}), shell: {}, userQuestions: {}, jobs: {}, config: {}, requireRemoteAccess: async () => [], runRegistry: null,
  });
  await assert.rejects(() => tools.prepareTool.execute({}, { agent: { session: { id: "s" } } }), /set a direct genbioh100 envelope first/u);
});
