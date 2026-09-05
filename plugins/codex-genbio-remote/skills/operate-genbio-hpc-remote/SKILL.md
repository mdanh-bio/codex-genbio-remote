---
name: operate-genbio-hpc-remote
description: >-
  Operate Genbio Slurm and direct compute targets through the codex-genbio-remote
  MCP plugin. Use for policy, project planning, staging, launch, monitoring,
  retrieval, cancellation, and evidence-bound finalization on HPC, NHPC,
  genbio_mdanh, and genbioh100. Requires explicit owner approvals; not a generic
  SSH toolkit.
---

# Operate Genbio HPC Remote

Use the plugin's genbio_* MCP tools for consequential operations. Do not fall
back to raw SSH, SCP, scheduler, transfer, or installation commands when a tool
is missing or fails. Report the unavailable capability and stop that operation.
Plugin installation and reading this skill do not authorize remote actions.

Read [remote-cluster-policy.md](references/remote-cluster-policy.md) before a
workload. Its command examples explain policy, not an alternative execution route.
The configured runtime policy returned by the tools is authoritative; the bundled
[policy YAML](references/genbio-compute-policy.yaml) documents package defaults.
If those differ, report the difference rather than silently replacing either file.

## Select the exact target

| Target | Execution surface |
| --- | --- |
| HPC/gpu04 | Slurm, partition gpus |
| HPC/cpu01 | Slurm, partition cpus |
| NHPC/gpu01 | Slurm, partition gpu |
| genbio_mdanh | Direct workstation |
| genbioh100 | Direct workstation with separate CPU/GPU/memory policy |

Do not substitute aliases or treat a node name as portable between clusters.
Use only native, noninteractive OpenSSH with strict known-host verification.
Never weaken host-key checks, enable forwarding, or inspect credentials to
recover a failed operation. GPU 1 and gpu_util on genbioh100 are protected.

## Owner and approval workflow

1. Inspect policy and available project/workflow definitions locally first.
2. Resolve the exact workload, inputs, expected outputs, target, run roots,
   environment, and success criteria. Do not invent installation paths.
3. Use genbio_set_envelope to request explicit approval of the target-specific
   resource ceiling. Retain its owner_handle within the current task.
4. Plan through genbio_project_plan or genbio_workflow_plan. Execute only the
   approved immutable plan through the corresponding execute tool.
5. Review each elicitation's server-bound operation, target, roots/modes,
   resources, transfer classification, and policy hash. Free text is not approval.
6. Keep all unfinished, pending, and reconciling runs counted against capacity.
   Status checks never advance workflows; genbio_workflow_advance is explicit.

Policy is freshly read before consequential operations and before remote
execution. A changed policy invalidates the old envelope; it does not authorize
replaying an outstanding launch. Resolve outstanding attempts before new work.
A persisted handle is a recovery identifier, not permission to carry an envelope
into another task without owner review and renewed approval.

## Launch and monitor

Use project and H100-specific tools for real workloads. genbio_launch retains
the fixed diagnostic smoke interface, not arbitrary commands:

- HPC permits gpu04-smoke only on HPC/gpu04.
- NHPC preflight-smoke runs under Slurm on NHPC/gpu01.
- Direct preflight-smoke is CPU-only, requires explicit mem_gb and a configured
  smokeRoots entry, and runs in a fresh approved directory. It does not certify
  CUDA availability or the scientific application's correctness.
- Smoke concurrency is exactly one. Declared resources must fit the envelope.
- genbio_monitor is local-only by default. With reconcile=true, supply an exact
  run_id to collect bounded smoke evidence without resubmission.

Submission acknowledgement, SSH exit zero, or an empty queue is not success.
Slurm success requires exact job identity, terminal COMPLETED/0:0 accounting,
job-owned output identity, and verified output checksums. Direct success also
requires matching PID/start identity, process termination, and exit-code evidence.
Missing evidence or transport ambiguity remains reconciling; never retry launch
because the connection was lost. Unsupported legacy smoke records cannot be
replayed automatically.

## Retrieve and finalize

Use the matching fetch tool for verified, allowlisted outputs with explicit
material-transfer approval. Scheduler/process success is distinct from successful
retrieval and scientific acceptance. Inspect every array element and workload-
specific pass/failure criteria before making scientific claims.

Use genbio_finalize_run for the owned terminal run. The server supplies immutable
compute identity and evidence; do not override them in a summary. Curate concise
findings, limitations, next steps, and artifact references, not raw logs,
credentials, trajectories, or environment dumps. Use genbio_publish_run only to
retry publication of the frozen record. Report compute and memory-publication
status separately; unavailable publication does not invalidate compute evidence.

## Local helpers

The bundled load_policy.py, validate_sbatch.py, and record_run.py are local
validation/provenance utilities. They do not authorize remote execution or
replace MCP finalization. Templates are starting points for validated wrappers,
not files to submit directly. No separate global copy of this skill is supported.
