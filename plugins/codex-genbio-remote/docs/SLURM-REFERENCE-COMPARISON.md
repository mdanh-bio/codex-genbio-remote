# Public Slurm Skill Comparison

Reviewed at the following shallow-clone commits on September 4, 2026:

- TianyuDu `SLURM-HPC-AGENT-SKILL`: `694a93898a6459914b1e8b67ba161c197dd84bb5`
- dtunai `agent-skills-for-compute`: `34cde0c5d9695c0249bb6ed58f97d5938e101244`
- michaelrizvi `claude-config`: `42ff01e6b2b4550bf3cead5cfe4c243cc6a7`

Only Slurm material was considered.

## Adopt

- Discovery-first operation: inspect Slurm version/configuration, partitions, node/GRES inventory, queue pressure, and accounting visibility before site-specific commands.
- Separate reusable CPU, GPU, and array templates.
- Explicit array ranges and concurrency caps; inspect every array element before success.
- Use `squeue` for live jobs, `scontrol show job` for detailed state/pending reasons, `sstat` for running-job metrics when available, and `sacct` for completed-job evidence.
- Capture startup environment facts (host, date, job ID, resolved executables, and GPU visibility) and keep stderr available for diagnosis.

## Adapt to Genbio

- Public examples commonly use account, time, and memory directives; Genbio forbids those directives and relies on the active policy/envelope.
- Public examples permit multi-node jobs, interactive `salloc`/`srun`, generic GPU types, and site-specific limits; Genbio remains single-node, target-allowlisted, and policy-controlled.
- Public examples may retry or submit directly; Genbio persists intent first, treats lost transport as ambiguous, and never automatically resubmits.
- Public examples assume generic paths and environments; Genbio requires approved absolute paths, grants, checksums, and live-confirmed software.

## Reject

Do not copy site-specific node inventories, GPU names, accounts, quotas, dashboards, or memory/time heuristics into the Genbio skill. They are useful diagnostics only when verified live on the current target.
