import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../lib/aizyme-h100.js", import.meta.url), "utf8");

test("Stage-2 lock reconciliation is narrow and evidence-bound", () => {
  assert.match(source, /old_token=.*token\.txt/u);
  assert.match(source, /reason=absent_run_dir/u);
  assert.match(source, /terminal_token_bound_run/u);
  assert.match(source, /old_exit.*pending/u);
  assert.match(source, /kill -0.*old_pid/u);
  assert.match(source, /historical_env_i_failure/u);
  assert.match(source, /AIZH100_RUN_DIR must be set by the plugin launcher/u);
  assert.match(source, /lock_age.*-ge 300/u);
  assert.match(source, /test .* = .*old_token/u);
  assert.match(source, /STALE_LOCK_CLEARED/u);
});

test("ambiguous or live locks remain authoritative conflicts", () => {
  const conflicts = source.match(/LOCK_CONFLICT=1/g) ?? [];
  assert.ok(conflicts.length >= 3, "all non-proven-stale paths must preserve the lock conflict");
});

test("terminal lock release parses the token.txt key-value record", () => {
  assert.match(source, /lock_token=\$\(sed -n 's\/\^token=\/\/p'/u);
  assert.doesNotMatch(source, /lock_token=\$\(cat "\$lock\/token\.txt"/u);
});
