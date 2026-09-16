#!/usr/bin/env python3
"""Plan or execute a sequential dsh-remote node rollout.

The manifest is intentionally transport-neutral. Applying a plan delegates to
the existing backup-first instance installer over SSH and records each result.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
from typing import Any

import importlib.util

SPEC = importlib.util.spec_from_file_location("dsh_remote_edge", Path(__file__).with_name("remote-edge.py"))
assert SPEC and SPEC.loader
edge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(edge)


def load_manifest(path: Path) -> list[dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    nodes = value.get("nodes") if isinstance(value, dict) else value
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("manifest must contain a non-empty nodes list")
    result = []
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get("instance_id"), str):
            raise ValueError("each node requires instance_id")
        edge.node_manifest(node["instance_id"])
        if not isinstance(node.get("ssh_target"), str) or not node["ssh_target"]:
            raise ValueError(f"{node['instance_id']} requires ssh_target")
        result.append(node)
    return result


def plan(nodes: list[dict[str, Any]], package: str) -> dict[str, Any]:
    package_path = str(Path(package).resolve())
    return {
        "schema": 1,
        "package": package_path,
        "contract_schema": edge.NODE_CONTRACT_SCHEMA,
        "capabilities": list(edge.NODE_CAPABILITIES),
        "nodes": [{
            "instance_id": node["instance_id"],
            "ssh_target": node["ssh_target"],
            "command": ["dsh-remote-install-node", node["instance_id"]],
            "status": "planned",
        } for node in nodes],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("check", "upgrade"))
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--package")
    parser.add_argument("--receipt-dir", type=Path, default=Path(".dsh-remote-fleet"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        nodes = load_manifest(args.manifest)
        if args.action == "check":
            result = {"schema": 1, "contract_schema": edge.NODE_CONTRACT_SCHEMA, "nodes": []}
            for node in nodes:
                domain = node.get("domain")
                health = edge.node_health(domain) if isinstance(domain, str) else None
                result["nodes"].append({"instance_id": node["instance_id"], "health": health})
        else:
            if not args.package or not Path(args.package).is_file():
                raise ValueError("package does not exist")
            result = plan(nodes, args.package)
            if args.apply:
                digest = hashlib.sha256(Path(args.package).read_bytes()).hexdigest()
                for item, node in zip(result["nodes"], nodes):
                    remote_package = f"/tmp/dsh-remote-fleet-{digest}.tgz"
                    copied = subprocess.run(
                        ["scp", "-q", args.package, f"{node['ssh_target']}:{remote_package}"],
                        text=True, capture_output=True, check=False,
                    )
                    if copied.returncode != 0:
                        completed = copied
                    else:
                        command = [
                            "ssh", node["ssh_target"], *item["command"], remote_package,
                            node.get("base_domain", "dsh.onlyservice.io"), node["ssh_target"],
                        ]
                        completed = subprocess.run(command, text=True, capture_output=True, check=False)
                        subprocess.run(["ssh", node["ssh_target"], "rm", "-f", remote_package], check=False)
                    item["status"] = "committed" if completed.returncode == 0 else "failed"
                    item["returncode"] = completed.returncode
                    if completed.returncode != 0:
                        break
        args.receipt_dir.mkdir(parents=True, exist_ok=True)
        receipt = args.receipt_dir / f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-fleet.json"
        receipt.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps({"receipt": str(receipt), **result}, sort_keys=True))
        return 0 if all(node.get("status") != "failed" for node in result.get("nodes", [])) else 1
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "error", "message": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
