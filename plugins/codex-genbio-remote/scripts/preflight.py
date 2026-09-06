#!/usr/bin/env python3
"""Report local validation prerequisites; never install or contact a host."""
import importlib.util
import json
import shutil
import subprocess
import sys


def main():
    node = shutil.which("node")
    version = subprocess.run([node, "--version"], capture_output=True, text=True, check=True).stdout.strip() if node else None
    yaml = importlib.util.find_spec("yaml") is not None
    node_ok = version is not None and int(version.lstrip("v").split(".")[0]) >= 22
    print(json.dumps({
        "python": sys.version.split()[0], "python_executable": sys.executable,
        "node": version, "node_executable": node,
        "required_python_modules": {"yaml (PyYAML)": yaml, "unittest": True},
        "commands": ["npm run check (in server)", "python3 -m unittest discover -s skills/operate-genbio-hpc-remote/tests -p 'test_*.py' (in plugin)"],
        "ready": yaml and node_ok,
    }, indent=2))
    return 0 if yaml and node_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
