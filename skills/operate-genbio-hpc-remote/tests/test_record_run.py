#!/usr/bin/env python3

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import record_run  # noqa: E402


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact(path):
    return {"path": str(path), "sha256": sha256(path)}


def hpc_manifest(root, status="ok", *, scheduler=None, output="result.json"):
    script_path = root / "job.sbatch"
    log_path = root / "run.log"
    output_path = root / output
    script_path.write_text("#!/bin/bash\n", encoding="utf-8")
    log_path.write_text("done\n", encoding="utf-8")
    output_path.write_text("{}\n", encoding="utf-8")
    return {
        "target": "HPC",
        "remote_path": "/data01/genbiolab/mdanh/data/projects/example/runs/test",
        "command": "sbatch slurm/job.sbatch",
        "envelope": {
            "node": "gpu04",
            "max_cpus": 80,
            "max_gpus": 1,
            "used_cpus": 0,
            "used_gpus": 0,
        },
        "script": artifact(script_path),
        "logs": [artifact(log_path)],
        "expected_outputs": [{"path": str(output_path)}],
        "outputs": [artifact(output_path)],
        "terminal_evidence": {
            "scheduler": scheduler
            or {"job_id": "123", "state": "COMPLETED", "exit_code": "0:0"}
        },
        "status": status,
        "hardware": "gpu04, GPU node",
    }


def direct_manifest(root, status="ok", exit_code=0, target="genbio_mdanh"):
    script_path = root / "run.sh"
    log_path = root / "log"
    output_path = root / "env.txt"
    script_path.write_text("#!/bin/bash\n", encoding="utf-8")
    log_path.write_text("done\n", encoding="utf-8")
    output_path.write_text("Python 3.12.0\nPLATFORM=linux-x86_64\n", encoding="utf-8")
    return {
        "target": target,
        "remote_path": "/data01/genbiolab/mdanh/data/projects/example/runs/direct",
        "command": "bash run.sh",
        "envelope": {
            "node": target,
            "max_cpus": 16,
            "max_gpus": 1,
            "used_cpus": 0,
            "used_gpus": 0,
        },
        "script": artifact(script_path),
        "logs": [artifact(log_path)],
        "expected_outputs": [{"path": str(output_path)}],
        "outputs": [artifact(output_path)],
        "terminal_evidence": {"process": {"exit_code": exit_code}},
        "status": status,
        "env_file": str(output_path),
    }


class RecordRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.old_cwd = Path.cwd()
        os.chdir(self.root)

    def tearDown(self):
        os.chdir(self.old_cwd)
        self.tmp.cleanup()

    def test_hpc_ok_record_is_written(self):
        manifest = hpc_manifest(self.root)
        errors, record = record_run.validate_manifest(manifest)
        self.assertEqual(errors, [])
        self.assertIsNotNone(record)
        record_run.atomic_append(record)
        lines = (self.root / ".openscience" / "remote-runs.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), 1)
        saved = json.loads(lines[0])
        self.assertEqual(saved["status"], "ok")
        self.assertEqual(saved["target"], "HPC")
        self.assertEqual(saved["terminalEvidence"]["scheduler"]["exit_code"], "0:0")

    def test_nhpc_ok_record_requires_scheduler_evidence(self):
        manifest = hpc_manifest(self.root)
        manifest["target"] = "NHPC"
        manifest["remote_path"] = "/home/mdanh/.dsh/genbio-policy-smoke/runs/test"
        manifest["envelope"]["node"] = "gpu01"
        manifest["terminal_evidence"] = {"scheduler": {"job_id": "456", "state": "COMPLETED", "exit_code": "0:0"}}
        errors, record = record_run.validate_manifest(manifest)
        self.assertEqual(errors, [])
        self.assertIsNotNone(record)

    def test_hpc_ok_missing_output_fails_closed(self):
        manifest = hpc_manifest(self.root, output="missing.json")
        (self.root / "missing.json").unlink()
        errors, record = record_run.validate_manifest(manifest)
        self.assertTrue(any("expected output" in item for item in errors))
        self.assertIsNotNone(record)

    def test_hpc_checksum_mismatch_fails_closed(self):
        manifest = hpc_manifest(self.root)
        manifest["script"]["sha256"] = "0" * 64
        errors, _ = record_run.validate_manifest(manifest)
        self.assertTrue(any("checksum mismatch" in item for item in errors))

    def test_hpc_ok_requires_completed_zero_exit(self):
        manifest = hpc_manifest(
            self.root,
            scheduler={"job_id": "123", "state": "FAILED", "exit_code": "1:0"},
        )
        errors, _ = record_run.validate_manifest(manifest)
        self.assertTrue(any("COMPLETED" in item and "0:0" in item for item in errors))

    def test_genbioh100_ok_record_is_supported(self):
        manifest = direct_manifest(self.root, target="genbioh100")
        errors, record = record_run.validate_manifest(manifest)
        self.assertEqual(errors, [])
        self.assertIsNotNone(record)

    def test_direct_ok_requires_zero_exit(self):
        manifest = direct_manifest(self.root, status="ok", exit_code=0)
        errors, record = record_run.validate_manifest(manifest)
        self.assertEqual(errors, [])
        self.assertIsNotNone(record)

        manifest = direct_manifest(self.root, status="ok", exit_code=1)
        errors, _ = record_run.validate_manifest(manifest)
        self.assertTrue(any("process exit code 0" in item for item in errors))

    def test_secret_redaction(self):
        safe = record_run.redact_secrets(
            {"password": "do-not-store", "command": "ssh --api-key secret"}
        )
        self.assertEqual(safe["password"], "[REDACTED]")
        self.assertNotIn("secret", safe["command"])

    def test_duplicate_output_path_is_rejected_on_append(self):
        manifest = hpc_manifest(self.root)
        _, record = record_run.validate_manifest(manifest)
        record_run.atomic_append(record)
        with self.assertRaises(SystemExit) as context:
            record_run.atomic_append(record)
        self.assertEqual(context.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
