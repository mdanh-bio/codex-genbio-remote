#!/usr/bin/env python3
"""Record a finished Genbio remote run from a validated manifest.

This replaces the earlier flag-based recorder. The manifest pins the remote
target, path, command, resource envelope, scripts, logs, expected outputs,
checksums, and terminal scheduler/process evidence before a record is written.
Successful records fail closed: every declared artifact must exist and match
its SHA-256, and terminal evidence must be successful.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from copy import deepcopy
from pathlib import Path
from typing import Any


STORE = Path(".openscience") / "remote-runs.jsonl"
ENV_DIR = Path(".openscience") / "env"
FREEZE_MARKER = "--- pip freeze ---"

from load_policy import DEFAULT_POLICY_PATH, PolicyError, load_policy


_POLICY, _POLICY_DIGEST = load_policy(DEFAULT_POLICY_PATH)
ALLOWED_TARGETS = set(_POLICY["targets"])
HPC_NODES = {
    node
    for node in _POLICY["targets"]["HPC"]["allowlist"]
    if node != "forbidden_nodes"
}
SENSITIVE_KEY = re.compile(
    r"(password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization)",
    re.IGNORECASE,
)
BEARER = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/-]+=*")
KEY_VALUE_SECRET = re.compile(
    r"(?i)\b(password|passwd|secret|token|api[_-]?key|authorization)(\s*[:=]\s*)\S+"
)
OPTION_SECRET = re.compile(
    r"(?i)(--[^\s=:]*(?:password|passwd|secret|token|api[_-]?key|authorization)[^\s=:]*)(?:\s+|=|:)\S+"
)


def sha256_file(path: str) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            size += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), size


def normalize_path(path: str) -> str:
    return path.replace(os.sep, "/")


def redact_string(value: str) -> str:
    value = BEARER.sub(r"\1[REDACTED]", value)
    value = KEY_VALUE_SECRET.sub(r"\1\2[REDACTED]", value)
    value = OPTION_SECRET.sub(r"\1 [REDACTED]", value)
    return value


def redact_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if isinstance(key, str) and SENSITIVE_KEY.search(key):
                redacted[key] = "[REDACTED]"
            else:
                redacted[key] = redact_secrets(item)
        return redacted
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    if isinstance(value, str):
        return redact_string(value)
    return deepcopy(value)


def _require_string(manifest: dict[str, Any], key: str, errors: list[str]) -> str | None:
    value = manifest.get(key)
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{key} must be a non-empty string")
        return None
    return value.strip()


def validate_remote_path(path: str, errors: list[str]) -> None:
    if not path.startswith("/"):
        errors.append("remote_path must be an absolute remote path")
    if any(char in path for char in ("\n", "\r", ";", "|", "$", "`")):
        errors.append("remote_path contains forbidden shell characters")


def validate_envelope(
    manifest: dict[str, Any], target: str, errors: list[str]
) -> dict[str, Any] | None:
    envelope = manifest.get("envelope")
    if not isinstance(envelope, dict):
        errors.append("envelope must be an object")
        return None
    node = envelope.get("node")
    if not isinstance(node, str) or not node:
        errors.append("envelope.node must be a non-empty string")
    elif _POLICY["targets"].get(target, {}).get("surface") == "slurm":
        slurm_nodes = {name for name in _POLICY["targets"][target]["allowlist"] if name != "forbidden_nodes"}
        if node not in slurm_nodes:
            errors.append(f"envelope.node must be one of {sorted(slurm_nodes)} for target {target}")
    elif target in {"genbio_mdanh", "genbioh100"} and node != target:
        errors.append(f"envelope.node must be {target} for a direct workstation run")

    for key in ("max_cpus", "max_gpus", "used_cpus", "used_gpus"):
        value = envelope.get(key, 0)
        if not isinstance(value, int) or isinstance(value, bool):
            errors.append(f"envelope.{key} must be an integer")
            continue
        if key.startswith("max_") and value < 0:
            errors.append(f"envelope.{key} must be zero or positive")
        if key.startswith("used_") and value < 0:
            errors.append(f"envelope.{key} must be zero or positive")
        if key.startswith("used_") and value > envelope.get(key.replace("used_", "max_"), 0):
            errors.append(f"envelope.{key} must not exceed the session maximum")
    return envelope


def validate_artifact(
    entry: Any, label: str, errors: list[str], *, require_hash: bool = True
) -> dict[str, Any] | None:
    if not isinstance(entry, dict):
        errors.append(f"{label} entry must be an object")
        return None
    path = entry.get("path")
    if not isinstance(path, str) or not path:
        errors.append(f"{label}.path must be a non-empty string")
        return None
    expected_hash = entry.get("sha256")
    if require_hash and (not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash)):
        errors.append(f"{label}.sha256 must be a full 64-character SHA-256 hex digest")
        return None
    try:
        actual_hash, size = sha256_file(path)
    except OSError as exc:
        errors.append(f"{label} path {path!r} cannot be read: {exc}")
        return None
    if require_hash and expected_hash != actual_hash:
        errors.append(
            f"{label} path {path!r} checksum mismatch: manifest {expected_hash}, disk {actual_hash}"
        )
        return None
    artifact = {"path": normalize_path(path), "size": size, "sha256": actual_hash}
    if "expected" in entry:
        artifact["expected"] = entry["expected"]
    return artifact


def validate_terminal_evidence(
    manifest: dict[str, Any], target: str, status: str, errors: list[str]
) -> dict[str, Any] | None:
    evidence = manifest.get("terminal_evidence")
    if not isinstance(evidence, dict):
        errors.append("terminal_evidence must be an object")
        return None

    if _POLICY["targets"].get(target, {}).get("surface") == "slurm":
        scheduler = evidence.get("scheduler")
        if not isinstance(scheduler, dict):
            errors.append(f"terminal_evidence.scheduler is required for Slurm target {target}")
            return evidence
        job_id = scheduler.get("job_id")
        if not isinstance(job_id, str) or not job_id.strip():
            errors.append("terminal_evidence.scheduler.job_id must be a non-empty string")
        state = scheduler.get("state")
        exit_code = scheduler.get("exit_code")
        if not isinstance(state, str) or not state:
            errors.append("terminal_evidence.scheduler.state must be a non-empty string")
        if not isinstance(exit_code, str) or not exit_code:
            errors.append("terminal_evidence.scheduler.exit_code must be a non-empty string")
        if status == "ok" and (state != "COMPLETED" or exit_code != "0:0"):
            errors.append(
                f"{target} status ok requires scheduler state COMPLETED and exit code 0:0"
            )
    else:
        process = evidence.get("process")
        if not isinstance(process, dict):
            errors.append("terminal_evidence.process is required for a direct workstation run")
            return evidence
        exit_code = process.get("exit_code")
        if not isinstance(exit_code, int) or isinstance(exit_code, bool):
            errors.append("terminal_evidence.process.exit_code must be an integer")
        elif status == "ok" and exit_code != 0:
            errors.append("direct workstation status ok requires process exit code 0")
    return evidence


def read_env(path: str) -> dict[str, Any] | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return None

    python: str | None = None
    platform: str | None = None
    freeze: list[str] = []
    in_freeze = False
    for raw in lines:
        value = raw.strip()
        if value == FREEZE_MARKER:
            in_freeze = True
            continue
        if in_freeze:
            if value and "==" in value and not value.startswith("#"):
                freeze.append(value)
            continue
        if value.startswith("Python "):
            python = value.split(None, 1)[1].strip()
        elif value.upper().startswith("PLATFORM="):
            platform = value.split("=", 1)[1].strip().lower().replace("darwin", "macos")

    env: dict[str, Any] = {
        "platform": platform or "unknown",
        "app": os.environ.get("OPENSCIENCE_APP_VERSION", "unknown"),
    }
    if python:
        env["python"] = python
    if freeze:
        text = "\n".join(freeze) + "\n"
        digest = hashlib.sha256(text.encode()).hexdigest()
        os.makedirs(ENV_DIR, exist_ok=True)
        lock_path = ENV_DIR / f"{digest}.txt"
        if not lock_path.exists():
            lock_path.write_text(text, encoding="utf-8")
        env["packages"] = {"count": len(freeze), "hash": digest}
    return env


def validate_manifest(manifest: Any) -> tuple[list[str], dict[str, Any] | None]:
    errors: list[str] = []
    if not isinstance(manifest, dict):
        return ["manifest must be a JSON object"], None

    target = _require_string(manifest, "target", errors)
    if target is not None and target not in ALLOWED_TARGETS:
        errors.append(f"target must be one of {sorted(ALLOWED_TARGETS)}, got {target!r}")
    remote_path = _require_string(manifest, "remote_path", errors)
    if remote_path is not None:
        validate_remote_path(remote_path, errors)
    command = _require_string(manifest, "command", errors)
    status = _require_string(manifest, "status", errors)
    if status is not None and status not in {"ok", "failed"}:
        errors.append("status must be exactly ok or failed")

    if target is None or status is None:
        return errors, None

    envelope = validate_envelope(manifest, target, errors)
    script = validate_artifact(manifest.get("script"), "script", errors)
    helper_entries = manifest.get("helper_scripts", [])
    if not isinstance(helper_entries, list):
        errors.append("helper_scripts must be a list")
        helper_entries = []
    helpers = []
    for index, entry in enumerate(helper_entries):
        item = validate_artifact(entry, f"helper_scripts[{index}]", errors)
        if item is not None:
            helpers.append(item)

    log_entries = manifest.get("logs")
    if not isinstance(log_entries, list) or not log_entries:
        errors.append("logs must be a non-empty list")
        logs: list[dict[str, Any]] = []
    else:
        logs = []
        for index, entry in enumerate(log_entries):
            item = validate_artifact(entry, f"logs[{index}]", errors)
            if item is not None:
                logs.append(item)

    output_entries = manifest.get("outputs", [])
    if not isinstance(output_entries, list):
        errors.append("outputs must be a list")
        output_entries = []
    outputs: list[dict[str, Any]] = []
    for index, entry in enumerate(output_entries):
        item = validate_artifact(entry, f"outputs[{index}]", errors)
        if item is not None:
            outputs.append(item)

    expected_entries = manifest.get("expected_outputs", [])
    if not isinstance(expected_entries, list):
        errors.append("expected_outputs must be a list")
        expected_entries = []
    output_by_path = {item["path"]: item for item in outputs}
    expected_outputs: list[dict[str, Any]] = []
    for entry in expected_entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not entry["path"]:
            errors.append("expected_outputs entry must have a non-empty path")
            continue
        path = normalize_path(entry["path"])
        if path in output_by_path:
            expected_outputs.append(
                {
                    "path": path,
                    "present": True,
                    "sha256": output_by_path[path]["sha256"],
                    "size": output_by_path[path]["size"],
                }
            )
        else:
            expected_outputs.append({"path": path, "present": False})
            if status == "ok":
                errors.append(
                    f"status ok requires expected output {path!r} to be present and checksummed"
                )

    terminal_evidence = validate_terminal_evidence(manifest, target, status, errors)
    if script is None:
        return errors, None

    job_id = None
    if target == "HPC" and isinstance(terminal_evidence, dict):
        scheduler = terminal_evidence.get("scheduler")
        if isinstance(scheduler, dict):
            job_id = scheduler.get("job_id")
    host = manifest.get("host")
    if host is not None and not isinstance(host, str):
        errors.append("host must be a string when provided")
        host = None

    wall_ms = manifest.get("wall_ms")
    if wall_ms is not None and (not isinstance(wall_ms, int) or isinstance(wall_ms, bool) or wall_ms < 0):
        errors.append("wall_ms must be a non-negative integer when provided")
        wall_ms = None

    session_id = manifest.get("session_id")
    if session_id is not None and not isinstance(session_id, str):
        errors.append("session_id must be a string when provided")
        session_id = None

    env_record = None
    env_file = manifest.get("env_file")
    if env_file:
        if not isinstance(env_file, str):
            errors.append("env_file must be a string when provided")
        else:
            env_record = read_env(env_file)
            if env_record is None:
                errors.append(f"env_file {env_file!r} cannot be read")

    run_id = "run_" + hashlib.sha256(
        f"{time.time_ns()}:{command}:{remote_path}".encode()
    ).hexdigest()[:24]
    record: dict[str, Any] = {
        "runId": run_id,
        "ts": int(time.time()),
        "command": command,
        "surface": "hpc" if _POLICY["targets"].get(target, {}).get("surface") == "slurm" else "ssh",
        "status": status,
        "target": target,
        "policyHash": manifest.get("policy_hash", _POLICY_DIGEST),
        "remotePath": remote_path,
        "envelope": envelope,
        "code": [script, *helpers],
        "logs": logs,
        "outputs": outputs,
        "expectedOutputs": expected_outputs,
        "terminalEvidence": terminal_evidence,
    }
    if host:
        record["host"] = host
    if job_id:
        record["jobId"] = job_id
    if manifest.get("hardware"):
        if not isinstance(manifest["hardware"], str):
            errors.append("hardware must be a string when provided")
        else:
            record["remoteHardware"] = manifest["hardware"]
    if wall_ms is not None:
        record["wallMs"] = wall_ms
    if session_id:
        record["sessionId"] = session_id
    if env_record:
        record["env"] = env_record

    return errors, record


def load_existing_records() -> list[dict[str, Any]]:
    if not STORE.exists():
        return []
    records: list[dict[str, Any]] = []
    with STORE.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def find_output_conflicts(
    existing: list[dict[str, Any]], record: dict[str, Any]
) -> list[tuple[str, str]]:
    conflicts: list[tuple[str, str]] = []
    seen: dict[str, str] = {}
    for old in existing:
        for output in old.get("outputs") or []:
            path = output.get("path")
            if path:
                seen.setdefault(path, old.get("runId") or "unknown run")
    for output in record.get("outputs") or []:
        path = output.get("path")
        if path and path in seen:
            conflicts.append((path, seen[path]))
    return conflicts


def atomic_append(record: dict[str, Any]) -> None:
    os.makedirs(STORE.parent, exist_ok=True)
    lock_path = STORE.with_suffix(STORE.suffix + ".lock")
    with lock_path.open("a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        existing = load_existing_records()
        conflicts = find_output_conflicts(existing, record)
        if conflicts:
            print("error: output path already recorded; refusing to overwrite run provenance.", file=sys.stderr)
            for path, owner in conflicts:
                print(f"  {path} was already recorded by {owner}", file=sys.stderr)
            raise SystemExit(2)

        lines = [json.dumps(item, sort_keys=True) + "\n" for item in [*existing, record]]
        fd, temp_name = tempfile.mkstemp(
            dir=str(STORE.parent), prefix=".remote-runs-", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.writelines(lines)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, STORE)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Record a finished Genbio remote run from a validated manifest."
    )
    parser.add_argument(
        "--manifest", required=True, help="path to the validated run manifest JSON"
    )
    args = parser.parse_args()

    try:
        manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    except OSError as exc:
        print(f"error: cannot read manifest {args.manifest}: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"error: manifest is not valid JSON: {exc}", file=sys.stderr)
        return 2

    errors, record = validate_manifest(manifest)
    if errors:
        print("invalid run manifest", file=sys.stderr)
        for item in errors:
            print(f"- {item}", file=sys.stderr)
        return 2

    assert record is not None
    safe_record = redact_secrets(record)
    atomic_append(safe_record)
    print(
        f"Recorded {safe_record['surface']} run {safe_record['runId']} "
        f"({safe_record['status']}) -> {STORE}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
