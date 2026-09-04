#!/usr/bin/env python3

import tempfile
import unittest
from pathlib import Path

import yaml

import sys

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from load_policy import PolicyError, load_policy  # noqa: E402


class PolicyTests(unittest.TestCase):
    def test_default_policy_has_all_targets_and_hash(self):
        policy, digest = load_policy()
        self.assertEqual(set(policy["targets"]), {"HPC", "NHPC", "genbio_mdanh", "genbioh100"})
        self.assertEqual(len(digest), 64)
        self.assertEqual(policy["targets"]["HPC"]["test_gate"]["real_submission"], "gpu04")
        self.assertEqual(policy["targets"]["NHPC"]["test_gate"]["real_submission"], "gpu01")
        self.assertEqual(policy["targets"]["NHPC"]["allowlist"]["gpu01"]["partition"], "gpu")
        self.assertEqual(policy["targets"]["genbioh100"]["limits"]["gpus_allowed"], [0])
        self.assertEqual(policy["targets"]["genbioh100"]["limits"]["cpu_threads_per_job"], 16)

    def test_missing_target_fails_closed(self):
        policy, _ = load_policy()
        del policy["targets"]["genbioh100"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.yaml"
            path.write_text(yaml.safe_dump(policy), encoding="utf-8")
            with self.assertRaises(PolicyError):
                load_policy(path)

    def test_hpc_submission_gate_cannot_move_from_gpu04(self):
        policy, _ = load_policy()
        policy["targets"]["HPC"]["test_gate"]["real_submission"] = "gpu01"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.yaml"
            path.write_text(yaml.safe_dump(policy), encoding="utf-8")
            with self.assertRaises(PolicyError):
                load_policy(path)

    def test_nhpc_submission_gate_cannot_move_from_gpu01(self):
        policy, _ = load_policy()
        policy["targets"]["NHPC"]["test_gate"]["real_submission"] = "gpu04"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.yaml"
            path.write_text(yaml.safe_dump(policy), encoding="utf-8")
            with self.assertRaises(PolicyError):
                load_policy(path)

    def test_genbioh100_gpu_one_protection_is_required(self):
        policy, _ = load_policy()
        policy["targets"]["genbioh100"]["hardware"]["reserved_gpu"] = 0
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.yaml"
            path.write_text(yaml.safe_dump(policy), encoding="utf-8")
            with self.assertRaises(PolicyError):
                load_policy(path)


if __name__ == "__main__":
    unittest.main()
