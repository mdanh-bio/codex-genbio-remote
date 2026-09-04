#!/usr/bin/env python3
"""Load and validate the machine-readable Genbio compute policy."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import yaml


DEFAULT_POLICY_PATH = Path(__file__).resolve().parents[1] / "references" / "genbio-compute-policy.yaml"
REQUIRED_TARGETS = {"HPC", "NHPC", "genbio_mdanh", "genbioh100"}


class PolicyError(ValueError):
    """Raised when the compute policy is missing, malformed, or unsafe."""


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PolicyError(f"{label} must be a mapping")
    return value


def _positive_int(value: Any, label: str, *, allow_zero: bool = False) -> int:
    minimum = 0 if allow_zero else 1
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        comparator = "zero or positive" if allow_zero else "positive"
        raise PolicyError(f"{label} must be a {comparator} integer")
    return value


def load_policy(path: str | Path | None = None) -> tuple[dict[str, Any], str]:
    policy_path = Path(path) if path is not None else DEFAULT_POLICY_PATH
    try:
        raw = policy_path.read_bytes()
    except OSError as exc:
        raise PolicyError(f"cannot read compute policy {policy_path}: {exc}") from exc
    try:
        document = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        raise PolicyError(f"compute policy is not valid YAML: {exc}") from exc

    policy = _mapping(document, "policy document")
    if policy.get("schema_version") != 1:
        raise PolicyError("schema_version must be 1")
    if policy.get("policy") != "genbio-remote-compute":
        raise PolicyError("policy must be genbio-remote-compute")

    ssh = _mapping(policy.get("ssh"), "ssh")
    if ssh.get("client") != "openssh-native" or ssh.get("noninteractive") is not True:
        raise PolicyError("ssh must require noninteractive native OpenSSH")
    options = _mapping(ssh.get("options"), "ssh.options")
    required_options = {
        "tty": False,
        "batch_mode": True,
        "connect_timeout_s": 10,
        "strict_host_key_checking": "yes",
        "agent_forwarding": False,
        "x11_forwarding": False,
        "port_forwarding": False,
    }
    for key, expected in required_options.items():
        if options.get(key) != expected:
            raise PolicyError(f"ssh.options.{key} must be {expected!r}")

    targets = _mapping(policy.get("targets"), "targets")
    if set(targets) != REQUIRED_TARGETS:
        raise PolicyError(f"targets must be exactly {sorted(REQUIRED_TARGETS)}")

    hpc = _mapping(targets["HPC"], "targets.HPC")
    if hpc.get("ssh_target") != "HPC" or hpc.get("surface") != "slurm":
        raise PolicyError("HPC must use exact target HPC and Slurm surface")
    allowlist = _mapping(hpc.get("allowlist"), "targets.HPC.allowlist")
    expected_partitions = {"gpu04": "gpus", "cpu01": "cpus"}
    for node, partition in expected_partitions.items():
        entry = _mapping(allowlist.get(node), f"targets.HPC.allowlist.{node}")
        if entry.get("partition") != partition:
            raise PolicyError(f"HPC {node} must map to partition {partition}")
    test_gate = _mapping(hpc.get("test_gate"), "targets.HPC.test_gate")
    if test_gate.get("real_submission") != "gpu04":
        raise PolicyError("the real HPC submission test must be pinned to gpu04")

    nhpc = _mapping(targets["NHPC"], "targets.NHPC")
    if nhpc.get("ssh_target") != "NHPC" or nhpc.get("surface") != "slurm":
        raise PolicyError("NHPC must use exact target NHPC and Slurm surface")
    nhpc_allowlist = _mapping(nhpc.get("allowlist"), "targets.NHPC.allowlist")
    gpu01 = _mapping(nhpc_allowlist.get("gpu01"), "targets.NHPC.allowlist.gpu01")
    if gpu01.get("partition") != "gpu":
        raise PolicyError("NHPC gpu01 must map to partition gpu")
    caps = _mapping(gpu01.get("caps"), "targets.NHPC.allowlist.gpu01.caps")
    if _positive_int(caps.get("max_aggregate_cpus"), "NHPC gpu01 max_aggregate_cpus") != 80:
        raise PolicyError("NHPC gpu01 max_aggregate_cpus must be 80")
    nhpc_gate = _mapping(nhpc.get("test_gate"), "targets.NHPC.test_gate")
    if nhpc_gate.get("real_submission") != "gpu01":
        raise PolicyError("the real NHPC submission test must be pinned to gpu01")
    if nhpc_gate.get("smoke_root") != "/home/mdanh/.dsh/genbio-policy-smoke":
        raise PolicyError("NHPC smoke_root must be the fixed /home/mdanh/.dsh/genbio-policy-smoke path")

    mdanh = _mapping(targets["genbio_mdanh"], "targets.genbio_mdanh")
    if mdanh.get("ssh_target") != "genbio_mdanh" or mdanh.get("surface") != "direct":
        raise PolicyError("genbio_mdanh must use its exact direct SSH target")

    h100 = _mapping(targets["genbioh100"], "targets.genbioh100")
    if h100.get("ssh_target") != "genbioh100" or h100.get("surface") != "direct":
        raise PolicyError("genbioh100 must use its exact direct SSH target")
    if h100.get("login_shell") is not False:
        raise PolicyError("genbioh100 login_shell must be false")
    hardware = _mapping(h100.get("hardware"), "targets.genbioh100.hardware")
    if hardware.get("reserved_gpu") != 1 or hardware.get("protected_process") != "gpu_util":
        raise PolicyError("genbioh100 must reserve GPU 1 and protect gpu_util")
    limits = _mapping(h100.get("limits"), "targets.genbioh100.limits")
    if limits.get("gpus_allowed") != [0]:
        raise PolicyError("genbioh100 gpus_allowed must be [0]")
    _positive_int(limits.get("cpu_threads_per_job"), "genbioh100 cpu_threads_per_job")
    _positive_int(limits.get("mem_gb_per_job"), "genbioh100 mem_gb_per_job")
    if _positive_int(limits.get("concurrent_gpu_jobs"), "genbioh100 concurrent_gpu_jobs") != 1:
        raise PolicyError("genbioh100 concurrent_gpu_jobs must be 1")

    digest = hashlib.sha256(raw).hexdigest()
    return policy, digest


def target_policy(policy: dict[str, Any], target: str) -> dict[str, Any]:
    targets = _mapping(policy.get("targets"), "targets")
    try:
        result = targets[target]
    except KeyError as exc:
        raise PolicyError(f"unknown target {target!r}") from exc
    return _mapping(result, f"targets.{target}")
