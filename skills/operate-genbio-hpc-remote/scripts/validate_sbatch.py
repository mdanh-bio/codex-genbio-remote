#!/usr/bin/env python3
"""Validate a Genbio HPC sbatch script against policy and its session envelope."""

from __future__ import annotations

import argparse
import re
import shlex
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from load_policy import DEFAULT_POLICY_PATH, PolicyError, load_policy


def _policy_constants(target: str = "HPC", policy_path: str | Path | None = None) -> tuple[dict[str, str], dict[str, dict[str, int]]]:
    policy, _digest = load_policy(policy_path)
    target_policy = policy["targets"].get(target)
    if not isinstance(target_policy, dict) or target_policy.get("surface") != "slurm":
        raise PolicyError(f"target {target!r} is not a policy-managed Slurm target")
    allowlist = target_policy["allowlist"]
    node_partition = {
        node: entry["partition"]
        for node, entry in allowlist.items()
        if node != "forbidden_nodes"
    }
    node_caps = {
        node: {key: int(value) for key, value in entry.get("caps", {}).items() if isinstance(value, int)}
        for node, entry in allowlist.items()
        if node != "forbidden_nodes"
    }
    return node_partition, node_caps


DEFAULT_TARGET = "HPC"
DEFAULT_NODE_PARTITION, DEFAULT_NODE_CAPS = _policy_constants(DEFAULT_TARGET)

OPTION_ALIASES = {
    "--job-name": "job-name",
    "-J": "job-name",
    "--partition": "partition",
    "-p": "partition",
    "--account": "account",
    "-A": "account",
    "--nodes": "nodes",
    "-N": "nodes",
    "--nodelist": "nodelist",
    "-w": "nodelist",
    "--ntasks": "ntasks",
    "-n": "ntasks",
    "--ntasks-per-node": "ntasks-per-node",
    "--cpus-per-task": "cpus-per-task",
    "-c": "cpus-per-task",
    "--gres": "gres",
    "--gpus": "gpus",
    "-G": "gpus",
    "--gpus-per-node": "gpus-per-node",
    "--gpus-per-task": "gpus-per-task",
    "--array": "array",
    "-a": "array",
    "--dependency": "dependency",
    "-d": "dependency",
    "--output": "output",
    "-o": "output",
    "--error": "error",
    "-e": "error",
    "--time": "time",
    "-t": "time",
    "--time-min": "time-min",
    "--mem": "mem",
    "--mem-per-cpu": "mem-per-cpu",
    "--mem-per-gpu": "mem-per-gpu",
}

FLAG_ALIASES = {
    "--exclusive": "exclusive",
}

ATTACHED_SHORT_ALIASES = {
    "-J": "job-name",
    "-p": "partition",
    "-A": "account",
    "-N": "nodes",
    "-w": "nodelist",
    "-n": "ntasks",
    "-c": "cpus-per-task",
    "-G": "gpus",
    "-a": "array",
    "-d": "dependency",
    "-o": "output",
    "-e": "error",
    "-t": "time",
}

PROHIBITED = {
    "account": "omit --account/-A; let Slurm use the user's default account",
    "time": "omit --time/-t; this cluster uses its walltime default",
    "time-min": "omit --time-min; this cluster uses its walltime default",
    "mem": "omit --mem; memory is not a scheduled consumable on this cluster",
    "mem-per-cpu": "omit --mem-per-cpu; memory is not a scheduled consumable on this cluster",
    "mem-per-gpu": "omit --mem-per-gpu; memory is not a scheduled consumable on this cluster",
    "exclusive": "omit --exclusive under the current policy",
    "gpus": "use the explicit --gres=gpu:N form for GPU work",
    "gpus-per-node": "use the explicit --gres=gpu:N form for GPU work",
    "gpus-per-task": "use the explicit --gres=gpu:N form for GPU work",
}

UNRESOLVED = re.compile(r"__[A-Z0-9_]+__|\bPREPARED_ONLY\b|\bTODO\b")
JOB_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
CD_SUBMIT_DIR = re.compile(
    r'^\s*cd\s+(?:--\s+)?["\']\$\{?SLURM_SUBMIT_DIR\}?["\']\s*(?:#.*)?$'
)

SRUN_RESOURCE_FLAGS = {
    "--account",
    "-A",
    "--nodes",
    "-N",
    "--ntasks",
    "-n",
    "--cpus-per-task",
    "-c",
    "--nodelist",
    "-w",
    "--partition",
    "-p",
    "--gres",
    "--gpus",
    "-G",
    "--gpus-per-node",
    "--gpus-per-task",
    "--exclusive",
    "--mem",
    "--mem-per-cpu",
    "--mem-per-gpu",
    "--time",
    "-t",
    "--time-min",
}


@dataclass(frozen=True)
class Directive:
    value: str | None
    line: int
    raw: str


@dataclass(frozen=True)
class BodyLine:
    line: int
    text: str


@dataclass(frozen=True)
class SessionEnvelope:
    node: str
    max_cpus: int
    max_gpus: int
    used_cpus: int = 0
    used_gpus: int = 0


def _parse_known_option(
    tokens: list[str], line_no: int, errors: list[str]
) -> tuple[str, str | None] | None:
    first = tokens[0]

    if not first.startswith("--"):
        for prefix, canonical in ATTACHED_SHORT_ALIASES.items():
            if first.startswith(prefix) and first != prefix:
                if len(tokens) != 1:
                    errors.append(f"line {line_no}: use one Slurm directive per line")
                return canonical, first[len(prefix) :]

    if first in FLAG_ALIASES:
        if len(tokens) != 1:
            errors.append(f"line {line_no}: flag {first} must not have a value")
        return FLAG_ALIASES[first], None

    option = first
    inline_value: str | None = None
    if first.startswith("--") and "=" in first:
        option, inline_value = first.split("=", 1)

    canonical = OPTION_ALIASES.get(option)
    if canonical is None:
        return None

    if inline_value is not None:
        if len(tokens) != 1:
            errors.append(f"line {line_no}: use one Slurm directive per line")
        return canonical, inline_value

    if len(tokens) != 2:
        errors.append(f"line {line_no}: {option} requires exactly one value on its own line")
        return canonical, tokens[1] if len(tokens) > 1 else None

    return canonical, tokens[1]


def parse_script(text: str) -> tuple[dict[str, list[Directive]], list[BodyLine], list[str]]:
    directives: dict[str, list[Directive]] = defaultdict(list)
    body_lines: list[BodyLine] = []
    errors: list[str] = []
    body_started = False

    for line_no, raw in enumerate(text.splitlines(), start=1):
        stripped = raw.strip()
        if stripped.startswith("#SBATCH"):
            if body_started:
                errors.append(
                    f"line {line_no}: #SBATCH appears after the script body began and Slurm may ignore it"
                )
            payload = stripped[len("#SBATCH") :].strip()
            try:
                tokens = shlex.split(payload, comments=True, posix=True)
            except ValueError as exc:
                errors.append(f"line {line_no}: cannot parse directive: {exc}")
                continue
            if not tokens:
                errors.append(f"line {line_no}: empty #SBATCH directive")
                continue
            parsed = _parse_known_option(tokens, line_no, errors)
            if parsed is None:
                errors.append(
                    f"line {line_no}: unknown or disallowed #SBATCH directive {tokens[0]!r}"
                )
                continue
            name, value = parsed
            directives[name].append(Directive(value=value, line=line_no, raw=raw))
            continue

        if not stripped or stripped.startswith("#"):
            continue
        body_started = True
        body_lines.append(BodyLine(line=line_no, text=stripped))

    return directives, body_lines, errors


def _one(
    directives: dict[str, list[Directive]],
    name: str,
    errors: list[str],
    *,
    required: bool = True,
) -> str | None:
    found = directives.get(name, [])
    if not found:
        if required:
            errors.append(f"missing required #SBATCH --{name} directive")
        return None
    if len(found) > 1:
        lines = ", ".join(str(item.line) for item in found)
        errors.append(f"--{name} appears more than once (lines {lines})")
        return found[0].value
    return found[0].value


def _positive_int(value: str | None, label: str, errors: list[str]) -> int | None:
    if value is None or not re.fullmatch(r"[1-9][0-9]*", value):
        errors.append(f"{label} must be a positive integer, got {value!r}")
        return None
    return int(value)


def parse_array_spec(value: str) -> tuple[int, int] | None:
    """Return (task_count, concurrency) for a numeric Slurm array specification."""
    match = re.fullmatch(r"(.+)%([1-9][0-9]*)", value)
    concurrency = int(match.group(2)) if match else 1
    body = match.group(1) if match else value
    total = 0

    for part in body.split(","):
        part = part.strip()
        if not part:
            return None

        step = 1
        range_part = part
        if ":" in part:
            if part.count(":") != 1:
                return None
            range_part, step_text = part.split(":", 1)
            if not re.fullmatch(r"[1-9][0-9]*", step_text):
                return None
            step = int(step_text)
            if "-" not in range_part:
                return None

        if "-" in range_part:
            if range_part.count("-") != 1:
                return None
            start_text, end_text = range_part.split("-", 1)
            if not re.fullmatch(r"[0-9]+", start_text) or not re.fullmatch(r"[0-9]+", end_text):
                return None
            start, end = int(start_text), int(end_text)
            if start > end:
                return None
            total += ((end - start) // step) + 1
            continue

        if not re.fullmatch(r"[0-9]+", range_part):
            return None
        total += 1

    if total < 1:
        return None
    return total, concurrency


def _has_strict_shell(body_lines: list[BodyLine], errors: list[str]) -> None:
    for item in body_lines:
        try:
            tokens = shlex.split(item.text, comments=True, posix=True)
        except ValueError:
            continue
        if len(tokens) < 3 or tokens[0] != "set":
            continue
        flags = tokens[1]
        if not flags.startswith("-"):
            continue
        flag_set = set(flags[1:])
        if {"e", "u", "o"}.issubset(flag_set) and tokens[2] == "pipefail":
            return
    errors.append("missing required strict shell mode: set -euo pipefail")


def _has_submit_dir_cd(body_lines: list[BodyLine], errors: list[str]) -> None:
    for item in body_lines:
        if CD_SUBMIT_DIR.match(item.text):
            return
    errors.append('missing required cd "$SLURM_SUBMIT_DIR"')


def _check_nested_or_resource_changing(body_lines: list[BodyLine], errors: list[str]) -> None:
    for item in body_lines:
        try:
            tokens = shlex.split(item.text, comments=True, posix=True)
        except ValueError:
            continue
        if "sbatch" in tokens:
            errors.append(f"line {item.line}: nested sbatch is forbidden")
        if "salloc" in tokens:
            errors.append(f"line {item.line}: nested salloc is forbidden")
        if "srun" not in tokens:
            continue
        for token in tokens[1:]:
            if not token.startswith("-"):
                continue
            option = token.split("=", 1)[0]
            attached_short = any(
                token.startswith(prefix) and token != prefix
                for prefix in ("-A", "-N", "-n", "-c", "-w", "-p", "-G", "-t")
            )
            if option in SRUN_RESOURCE_FLAGS or attached_short:
                errors.append(
                    f"line {item.line}: srun must not change resources with {token!r}"
                )


def _check_log_templates(
    array: str | None, output: str | None, error_log: str | None, errors: list[str]
) -> None:
    if output is None or error_log is None:
        return
    if array is not None:
        for label, template in (("--output", output), ("--error", error_log)):
            if "%A_%a" not in template:
                errors.append(f"{label} must contain %A_%a for an array job")
            if "%j" in template:
                errors.append(f"{label} must use the %A_%a array task template, not %j")
    else:
        for label, template in (("--output", output), ("--error", error_log)):
            if "%j" not in template:
                errors.append(f"{label} must contain %j for a non-array job")
            if "%A" in template or "%a" in template:
                errors.append(f"{label} must use the %j job template, not %A/%a")
    if output == error_log:
        errors.append("--output and --error must resolve to different paths")


def _validate_dependency(
    value: str | None,
    session_job_ids: set[str],
    errors: list[str],
) -> None:
    if value is None:
        return
    if not session_job_ids:
        errors.append(
            "--dependency requires --session-job-id evidence for every referenced session job"
        )
        return

    allowed_types = {"after", "afterok", "afternotok", "afterany"}
    for clause in value.split(","):
        clause = clause.strip()
        if not clause:
            errors.append("--dependency contains an empty clause")
            continue
        if ":" not in clause:
            errors.append(f"--dependency clause {clause!r} must be type:job-id[:job-id...]")
            continue
        dep_type, ids_text = clause.split(":", 1)
        if dep_type not in allowed_types:
            errors.append(
                f"--dependency type {dep_type!r} is not allowed; use one of {sorted(allowed_types)}"
            )
            continue
        ids = ids_text.split(":")
        for job_id in ids:
            if not re.fullmatch(r"[0-9]+", job_id):
                errors.append(f"--dependency job id {job_id!r} must be numeric")
                continue
            if job_id not in session_job_ids:
                errors.append(
                    f"--dependency references job {job_id}, which is not in this session"
                )


def validate_text(
    text: str,
    *,
    envelope: SessionEnvelope | None = None,
    target: str = DEFAULT_TARGET,
    session_job_ids: set[str] | None = None,
    session_job_names: set[str] | None = None,
) -> tuple[list[str], dict[str, str]]:
    directives, body_lines, errors = parse_script(text)
    try:
        allowed_node_partition, node_caps = _policy_constants(target)
    except PolicyError as exc:
        return [str(exc)], {}
    session_job_ids = session_job_ids or set()
    session_job_names = session_job_names or set()

    if not text.startswith("#!/bin/bash\n") and not text.startswith("#!/usr/bin/env bash\n"):
        errors.append("script must start with #!/bin/bash or #!/usr/bin/env bash")

    unresolved = sorted(set(UNRESOLVED.findall(text)))
    if unresolved:
        errors.append("unresolved preparation markers remain: " + ", ".join(unresolved))

    for name, explanation in PROHIBITED.items():
        if directives.get(name):
            lines = ", ".join(str(item.line) for item in directives[name])
            errors.append(f"prohibited directive on line(s) {lines}: {explanation}")

    job_name = _one(directives, "job-name", errors)
    partition = _one(directives, "partition", errors)
    _one(directives, "account", errors, required=False)
    nodes_text = _one(directives, "nodes", errors)
    node = _one(directives, "nodelist", errors)
    cpus_text = _one(directives, "cpus-per-task", errors)
    output = _one(directives, "output", errors)
    error_log = _one(directives, "error", errors)

    ntasks_text = _one(directives, "ntasks", errors, required=False)
    ntasks_per_node_text = _one(directives, "ntasks-per-node", errors, required=False)
    if ntasks_text is None and ntasks_per_node_text is None:
        errors.append("specify --ntasks or --ntasks-per-node explicitly")
    if ntasks_text is not None and ntasks_per_node_text is not None:
        errors.append("use either --ntasks or --ntasks-per-node, not both")

    nodes = _positive_int(nodes_text, "--nodes", errors)
    cpus = _positive_int(cpus_text, "--cpus-per-task", errors)
    tasks = _positive_int(
        ntasks_text if ntasks_text is not None else ntasks_per_node_text,
        "--ntasks/--ntasks-per-node",
        errors,
    )

    if nodes is not None and nodes != 1:
        errors.append(f"--nodes must equal 1, got {nodes}")

    if node is not None:
        if "," in node or any(char in node for char in "[]"):
            errors.append(
                "--nodelist must contain exactly one literal node; comma/range lists can trigger the Prolog drain failure"
            )
        if node not in allowed_node_partition:
            errors.append(
                f"--nodelist must be exactly one of {', '.join(allowed_node_partition)}, got {node!r}"
            )

    if node in allowed_node_partition and partition is not None:
        expected_partition = allowed_node_partition[node]
        if partition != expected_partition:
            errors.append(
                f"node {node} requires partition {expected_partition}, got {partition!r}"
            )

    gres = _one(directives, "gres", errors, required=False)
    gpu_count: int | None = None
    if gres is not None:
        match = re.fullmatch(r"gpu:([1-9][0-9]*)", gres)
        if not match:
            errors.append(f"--gres must use the form gpu:N with positive N, got {gres!r}")
        else:
            gpu_count = int(match.group(1))
    if node == "cpu01" and gres is not None:
        errors.append("cpu01 is CPU-only; remove --gres")

    array = _one(directives, "array", errors, required=False)
    array_task_count: int | None = None
    array_concurrency = 1
    if array is not None:
        parsed_array = parse_array_spec(array)
        if parsed_array is None:
            errors.append(
                "--array must contain an explicit numeric task set and positive %CONCURRENCY cap"
            )
        else:
            array_task_count, array_concurrency = parsed_array
            array_concurrency = min(array_concurrency, array_task_count)

    dependency = _one(directives, "dependency", errors, required=False)
    _validate_dependency(dependency, session_job_ids, errors)

    if job_name is not None:
        if not JOB_NAME.fullmatch(job_name):
            errors.append(
                "--job-name must start with a letter or digit and contain only letters, digits, dots, underscores, and hyphens"
            )
        if job_name in session_job_names:
            errors.append(f"--job-name {job_name!r} is already used in this session")

    _check_log_templates(array, output, error_log, errors)
    _has_strict_shell(body_lines, errors)
    _has_submit_dir_cd(body_lines, errors)
    _check_nested_or_resource_changing(body_lines, errors)

    node_cap = node_caps.get(node or "", {})
    if gpu_count is not None and node_cap.get("max_concurrent_gpu_jobs") is not None and array_concurrency > node_cap["max_concurrent_gpu_jobs"]:
        errors.append(f"{target}/{node} permits at most {node_cap['max_concurrent_gpu_jobs']} concurrent GPU array jobs")

    aggregate_cpus: int | None = None
    if tasks is not None and cpus is not None:
        aggregate_cpus = tasks * cpus * array_concurrency
        max_aggregate_cpus = node_cap.get("max_aggregate_cpus")
        if max_aggregate_cpus is not None and aggregate_cpus > max_aggregate_cpus:
            errors.append(f"{target}/{node} concurrent aggregate CPU use exceeds {max_aggregate_cpus}: {tasks} tasks x {cpus} CPUs x {array_concurrency} concurrency = {aggregate_cpus}")

    aggregate_gpus = (gpu_count or 0) * array_concurrency
    session_post_cpus: int | None = None
    session_post_gpus: int | None = None
    if envelope is not None:
        if envelope.node not in allowed_node_partition:
            errors.append(
                "session node must be exactly one of "
                f"{', '.join(allowed_node_partition)}, got {envelope.node!r}"
            )
        if node is not None and node != envelope.node:
            errors.append(
                f"job node {node!r} does not match session node {envelope.node!r}"
            )
        if envelope.max_cpus < 1:
            errors.append("session maximum CPUs must be a positive integer")
        if envelope.max_gpus < 0:
            errors.append("session maximum GPUs must be zero or a positive integer")
        if envelope.used_cpus < 0 or envelope.used_gpus < 0:
            errors.append("session used CPUs/GPUs must be zero or positive integers")
        if envelope.used_cpus > envelope.max_cpus:
            errors.append(
                "session used CPUs already exceed the envelope; resolve overlapping nonterminal jobs before proposing more"
            )
        if envelope.used_gpus > envelope.max_gpus:
            errors.append(
                "session used GPUs already exceed the envelope; resolve overlapping nonterminal jobs before proposing more"
            )
        if envelope.node == "cpu01" and envelope.max_gpus != 0:
            errors.append("cpu01 session maximum GPUs must equal zero")
        max_aggregate_cpus = node_caps.get(envelope.node, {}).get("max_aggregate_cpus")
        if max_aggregate_cpus is not None and envelope.max_cpus > max_aggregate_cpus:
            errors.append(f"{target}/{envelope.node} session maximum CPUs must not exceed {max_aggregate_cpus}")

        if envelope.max_cpus >= 1 and envelope.used_cpus >= 0 and aggregate_cpus is not None:
            session_post_cpus = envelope.used_cpus + aggregate_cpus
            if session_post_cpus > envelope.max_cpus:
                errors.append(
                    "session concurrent CPU envelope exceeded: "
                    f"{envelope.used_cpus} used + {aggregate_cpus} proposed = "
                    f"{session_post_cpus}, maximum {envelope.max_cpus}"
                )
        if envelope.max_gpus >= 0 and envelope.used_gpus >= 0:
            session_post_gpus = envelope.used_gpus + aggregate_gpus
            if session_post_gpus > envelope.max_gpus:
                errors.append(
                    "session concurrent GPU envelope exceeded: "
                    f"{envelope.used_gpus} used + {aggregate_gpus} proposed = "
                    f"{session_post_gpus}, maximum {envelope.max_gpus}"
                )

    summary = {
        "job_name": job_name or "unknown",
        "node": node or "unknown",
        "partition": partition or "unknown",
        "account": "cluster default",
        "nodes": str(nodes) if nodes is not None else "unknown",
        "tasks": str(tasks) if tasks is not None else "unknown",
        "cpus_per_task": str(cpus) if cpus is not None else "unknown",
        "gpu_request": f"gpu:{gpu_count}" if gpu_count is not None else "none (CPU-only)",
        "array": array or "none",
        "array_task_count": str(array_task_count) if array_task_count is not None else "not applicable",
        "array_concurrency": str(array_concurrency),
        "aggregate_concurrent_cpus": (
            str(aggregate_cpus) if aggregate_cpus is not None else "unknown"
        ),
        "aggregate_concurrent_gpus": str(aggregate_gpus),
        "session_node": envelope.node if envelope is not None else "not checked",
        "session_cpu_limit": str(envelope.max_cpus) if envelope is not None else "not checked",
        "session_gpu_limit": str(envelope.max_gpus) if envelope is not None else "not checked",
        "session_post_submit_cpus": (
            str(session_post_cpus) if session_post_cpus is not None else "not checked"
        ),
        "session_post_submit_gpus": (
            str(session_post_gpus) if session_post_gpus is not None else "not checked"
        ),
        "output": output or "unknown",
        "error": error_log or "unknown",
        "walltime": "cluster default",
        "memory": "cluster default (not scheduled as a consumable resource)",
    }
    return errors, summary


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Validate a Genbio HPC sbatch script against a confirmed session "
            "resource envelope."
        )
    )
    parser.add_argument("script", type=Path, help="path to the .sbatch file")
    parser.add_argument("--target", choices=("HPC", "NHPC"), default="HPC", help="policy-managed Slurm target")
    parser.add_argument(
        "--session-node",
        required=True,
        help="node confirmed for the current session envelope",
    )
    parser.add_argument(
        "--session-max-cpus",
        required=True,
        type=int,
        help="maximum aggregate concurrent CPUs confirmed for the session",
    )
    parser.add_argument(
        "--session-max-gpus",
        required=True,
        type=int,
        help="maximum aggregate concurrent GPUs confirmed for the session",
    )
    parser.add_argument(
        "--session-used-cpus",
        type=int,
        default=0,
        help="CPUs committed to overlapping nonterminal jobs under the envelope",
    )
    parser.add_argument(
        "--session-used-gpus",
        type=int,
        default=0,
        help="GPUs committed to overlapping nonterminal jobs under the envelope",
    )
    parser.add_argument(
        "--session-job-id",
        action="append",
        default=[],
        help="numeric job ID launched under this session envelope; repeatable",
    )
    parser.add_argument(
        "--session-job-name",
        action="append",
        default=[],
        help="job name already used under this session envelope; repeatable",
    )
    args = parser.parse_args()

    try:
        text = args.script.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"error: cannot read {args.script}: {exc}", file=sys.stderr)
        return 2

    envelope = SessionEnvelope(
        node=args.session_node,
        max_cpus=args.session_max_cpus,
        max_gpus=args.session_max_gpus,
        used_cpus=args.session_used_cpus,
        used_gpus=args.session_used_gpus,
    )
    errors, summary = validate_text(
        text,
        envelope=envelope,
        session_job_ids=set(args.session_job_id),
        session_job_names=set(args.session_job_name),
        target=args.target,
    )

    syntax = subprocess.run(
        ["bash", "-n", str(args.script)],
        text=True,
        capture_output=True,
        check=False,
    )
    if syntax.returncode != 0:
        errors.append("bash -n failed: " + syntax.stderr.strip())

    if errors:
        print("INVALID Genbio HPC sbatch script", file=sys.stderr)
        for item in errors:
            print(f"- {item}", file=sys.stderr)
        return 2

    print("VALID Genbio HPC sbatch script")
    for key, value in summary.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
