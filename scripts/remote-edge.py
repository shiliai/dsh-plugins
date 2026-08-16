#!/usr/bin/env python3
"""Idempotent, backup-first management for the DSH remote Nginx edge."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from typing import Any

import yaml

BEGIN = "# BEGIN DSH-REMOTE MANAGED"
END = "# END DSH-REMOTE MANAGED"
DOMAIN_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$")
ABS_PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]+$")


class EdgeError(RuntimeError):
    pass


def run(args: list[str], *, check: bool = True, capture: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, check=False, text=True, capture_output=capture)
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "command failed").strip()
        raise EdgeError(f"{args[0]} failed: {detail}")
    return result


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path: Path, content: str, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is None and path.exists():
            mode = path.stat().st_mode & 0o777
        os.chmod(temporary, mode or 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def replace_managed(original: str, managed: str | None) -> str:
    start = original.find(BEGIN)
    end = original.find(END)
    if (start == -1) != (end == -1):
        raise EdgeError("Nginx config contains an incomplete dsh-remote marker block")
    if start != -1:
        if end < start or original.find(BEGIN, start + len(BEGIN)) != -1 or original.find(END, end + len(END)) != -1:
            raise EdgeError("Nginx config contains ambiguous dsh-remote marker blocks")
        end += len(END)
        original = (original[:start].rstrip() + "\n" + original[end:].lstrip()).rstrip() + "\n"
    if managed is None:
        return original
    return original.rstrip() + "\n\n" + managed.strip() + "\n"


def validate_inputs(args: argparse.Namespace) -> None:
    if not DOMAIN_RE.fullmatch(args.domain) or ".." in args.domain:
        raise EdgeError("Invalid domain")
    for name in ("nginx_config", "compose_file", "socket_host_dir", "state_dir"):
        value = getattr(args, name)
        if not ABS_PATH_RE.fullmatch(value) or ".." in Path(value).parts:
            raise EdgeError(f"Invalid absolute path for {name}")


def resolve_ipv4(domain: str) -> list[str]:
    try:
        return sorted({item[4][0] for item in socket.getaddrinfo(domain, 443, socket.AF_INET, socket.SOCK_STREAM)})
    except socket.gaierror:
        return []


def load_compose(path: Path) -> dict[str, Any]:
    value = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("services"), dict):
        raise EdgeError("Compose file has no services mapping")
    service = value["services"].get("nginx")
    if not isinstance(service, dict):
        raise EdgeError("Compose file has no nginx service")
    return value


def update_compose(value: dict[str, Any], host_dir: str, group_id: int, offline_host: str) -> dict[str, Any]:
    service = value["services"]["nginx"]
    volumes = service.setdefault("volumes", [])
    if not isinstance(volumes, list):
        raise EdgeError("nginx volumes must be a list")
    managed_mounts = {
        f"{host_dir}:/run/dsh-remote:ro",
        f"{offline_host}:/usr/share/nginx/html/dsh-remote-offline.html:ro",
    }
    volumes[:] = [entry for entry in volumes if not (
        isinstance(entry, str) and (entry.endswith(":/run/dsh-remote:ro") or entry.endswith(":/usr/share/nginx/html/dsh-remote-offline.html:ro"))
    )]
    volumes.extend(sorted(managed_mounts))
    groups = service.setdefault("group_add", [])
    if not isinstance(groups, list):
        raise EdgeError("nginx group_add must be a list")
    normalized = [str(item) for item in groups if str(item) != str(group_id)]
    normalized.append(str(group_id))
    service["group_add"] = normalized
    return value


def render_site(template: str, args: argparse.Namespace, *, https: bool) -> str:
    http_action = f"return 301 https://{args.domain}$request_uri;" if https else "return 503;"
    https_server = ""
    if https:
        https_server = f"""server {{
    listen 443 ssl;
    http2 on;
    server_name {args.domain};

    ssl_certificate /etc/letsencrypt/live/{args.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{args.domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    access_log off;
    server_tokens off;
    client_max_body_size 100m;

    location / {{
        proxy_pass http://dsh_remote_gateway;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $dsh_remote_connection;
        proxy_buffering off;
        proxy_connect_timeout 10s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;
        proxy_intercept_errors on;
        error_page 502 503 504 =503 @dsh_remote_offline;
    }}

    location @dsh_remote_offline {{
        internal;
        root /usr/share/nginx/html;
        try_files /dsh-remote-offline.html =503;
    }}
}}"""
    return (template.replace("__DOMAIN__", args.domain)
            .replace("__SOCKET_CONTAINER_PATH__", args.socket_container_path)
            .replace("__HTTP_ACTION__", http_action)
            .replace("__HTTPS_SERVER__", https_server))


def ensure_group(name: str) -> tuple[int, bool]:
    result = run(["getent", "group", name], check=False)
    created = result.returncode != 0
    if created:
        run(["groupadd", "--system", name])
        result = run(["getent", "group", name])
    fields = result.stdout.strip().split(":")
    if len(fields) < 3:
        raise EdgeError("Cannot resolve dsh-remote group")
    return int(fields[2]), created


def compose_validate(compose_file: Path) -> None:
    run(["docker", "compose", "-f", str(compose_file), "config", "--quiet"])


def nginx_validate(container: str) -> None:
    run(["docker", "exec", container, "nginx", "-t"])


def compose_recreate(compose_file: Path) -> None:
    run(["docker", "compose", "-f", str(compose_file), "up", "-d", "--force-recreate", "nginx"])


def nginx_reload(container: str) -> None:
    run(["docker", "exec", container, "nginx", "-s", "reload"])


def issue_certificate(args: argparse.Namespace) -> None:
    live = Path(args.certbot_config) / "live" / args.domain / "fullchain.pem"
    if live.exists():
        return
    run([
        "docker", "run", "--rm",
        "-v", f"{args.certbot_config}:/etc/letsencrypt",
        "-v", f"{args.certbot_webroot}:/var/www/certbot",
        "certbot/certbot", "certonly", "--webroot", "-w", "/var/www/certbot",
        "--non-interactive", "--agree-tos", "--no-eff-email", "--keep-until-expiring",
        "-d", args.domain,
    ], capture=False)
    if not live.exists():
        raise EdgeError("Certificate issuance completed without the expected certificate")


def backup(args: argparse.Namespace, nginx: Path, compose: Path) -> tuple[Path, dict[str, Any]]:
    state = Path(args.state_dir)
    receipt_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    destination = state / "backups" / receipt_id
    suffix = 0
    while destination.exists():
        suffix += 1
        destination = state / "backups" / f"{receipt_id}-{suffix}"
    destination.mkdir(parents=True, mode=0o700)
    shutil.copy2(nginx, destination / "nginx.conf")
    shutil.copy2(compose, destination / "docker-compose.yml")
    receipt = {
        "schema": "dsh-remote-edge-receipt-v1",
        "id": destination.name,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "domain": args.domain,
        "pre": {"nginx_sha256": sha256(nginx), "compose_sha256": sha256(compose)},
        "paths": {"nginx": str(nginx), "compose": str(compose)},
        "group_created": False,
        "applied": False,
        "rolled_back": False,
    }
    atomic_write(destination / "receipt.json", json.dumps(receipt, indent=2, sort_keys=True) + "\n", 0o600)
    return destination, receipt


def restore_from(args: argparse.Namespace, directory: Path, receipt: dict[str, Any], *, automatic: bool) -> None:
    nginx = Path(receipt["paths"]["nginx"])
    compose = Path(receipt["paths"]["compose"])
    shutil.copy2(directory / "nginx.conf", nginx)
    shutil.copy2(directory / "docker-compose.yml", compose)
    compose_validate(compose)
    compose_recreate(compose)
    nginx_validate(args.nginx_container)
    if receipt.get("group_created"):
        socket_dir = Path(args.socket_host_dir)
        if socket_dir.exists() and not any(socket_dir.iterdir()):
            socket_dir.rmdir()
        run(["groupdel", args.socket_group], check=False)
    receipt["rolled_back"] = True
    receipt["automatic_rollback"] = automatic
    receipt["rollback_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    atomic_write(directory / "receipt.json", json.dumps(receipt, indent=2, sort_keys=True) + "\n", 0o600)


def preflight(args: argparse.Namespace, *, require_dns: bool = True) -> dict[str, Any]:
    nginx = Path(args.nginx_config)
    compose = Path(args.compose_file)
    for path in (nginx, compose, Path(args.site_template), Path(args.offline_template)):
        if not path.is_file():
            raise EdgeError(f"Required file is missing: {path}")
    ips = resolve_ipv4(args.domain)
    if require_dns and args.expected_ipv4 not in ips:
        raise EdgeError(f"DNS is not ready for {args.domain}; observed {ips or ['no A record']}")
    compose_validate(compose)
    nginx_validate(args.nginx_container)
    run(["ssh", "-V"], check=False)
    return {
        "domain": args.domain,
        "dns_ipv4": ips,
        "expected_ipv4": args.expected_ipv4,
        "nginx_sha256": sha256(nginx),
        "compose_sha256": sha256(compose),
        "nginx_container": args.nginx_container,
    }


def apply(args: argparse.Namespace) -> dict[str, Any]:
    facts = preflight(args)
    nginx = Path(args.nginx_config)
    compose = Path(args.compose_file)
    directory, receipt = backup(args, nginx, compose)
    try:
        group_id, group_created = ensure_group(args.socket_group)
        receipt["group_created"] = group_created
        receipt["group_id"] = group_id
        socket_dir = Path(args.socket_host_dir)
        socket_dir.mkdir(parents=True, exist_ok=True)
        os.chown(socket_dir, args.ssh_uid, group_id)
        os.chmod(socket_dir, 0o2770)

        offline_host = str(Path(args.nginx_site_dir) / "dsh-remote-offline.html")
        Path(offline_host).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.offline_template, offline_host)
        os.chmod(offline_host, 0o644)

        compose_value = update_compose(load_compose(compose), args.socket_host_dir, group_id, offline_host)
        atomic_write(compose, yaml.safe_dump(compose_value, sort_keys=False), 0o644)
        template = Path(args.site_template).read_text(encoding="utf-8")
        original = nginx.read_text(encoding="utf-8")
        atomic_write(nginx, replace_managed(original, render_site(template, args, https=False)), 0o644)
        compose_validate(compose)
        compose_recreate(compose)
        nginx_validate(args.nginx_container)
        issue_certificate(args)
        current = nginx.read_text(encoding="utf-8")
        atomic_write(nginx, replace_managed(current, render_site(template, args, https=True)), 0o644)
        nginx_validate(args.nginx_container)
        nginx_reload(args.nginx_container)
        receipt["applied"] = True
        receipt["post"] = {"nginx_sha256": sha256(nginx), "compose_sha256": sha256(compose)}
        receipt["facts"] = facts
        atomic_write(directory / "receipt.json", json.dumps(receipt, indent=2, sort_keys=True) + "\n", 0o600)
        return {"status": "applied", "receipt": str(directory / "receipt.json"), "group_id": group_id, **receipt["post"]}
    except Exception:
        restore_from(args, directory, receipt, automatic=True)
        raise


def status(args: argparse.Namespace) -> dict[str, Any]:
    nginx = Path(args.nginx_config)
    compose = load_compose(Path(args.compose_file))
    service = compose["services"]["nginx"]
    text = nginx.read_text(encoding="utf-8")
    socket_dir = Path(args.socket_host_dir)
    cert = Path(args.certbot_config) / "live" / args.domain / "fullchain.pem"
    result = {
        "domain": args.domain,
        "dns_ipv4": resolve_ipv4(args.domain),
        "managed_config": BEGIN in text and END in text,
        "socket_mount": any(isinstance(item, str) and item.endswith(":/run/dsh-remote:ro") for item in service.get("volumes", [])),
        "socket_directory": socket_dir.is_dir(),
        "socket_present": (socket_dir / "tunnel.sock").is_socket() if socket_dir.exists() else False,
        "certificate_present": cert.is_file(),
        "nginx_config_valid": run(["docker", "exec", args.nginx_container, "nginx", "-t"], check=False).returncode == 0,
    }
    result["configured"] = all(result[key] for key in ("managed_config", "socket_mount", "socket_directory", "certificate_present", "nginx_config_valid"))
    result["ready"] = result["configured"] and result["socket_present"]
    return result


def rollback(args: argparse.Namespace) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9TZ-]+", args.receipt):
        raise EdgeError("Invalid receipt id")
    directory = Path(args.state_dir) / "backups" / args.receipt
    receipt_path = directory / "receipt.json"
    if not receipt_path.is_file():
        raise EdgeError("Rollback receipt not found")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt.get("rolled_back"):
        return {"status": "already-rolled-back", "receipt": str(receipt_path)}
    restore_from(args, directory, receipt, automatic=False)
    return {"status": "rolled-back", "receipt": str(receipt_path)}


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("action", choices=("preflight", "apply", "status", "rollback"))
    value.add_argument("--domain", default="zsh.onlyservice.io")
    value.add_argument("--expected-ipv4", default="43.167.173.46")
    value.add_argument("--nginx-config", default="/home/chriswang/docker/nginx/nginx.conf")
    value.add_argument("--compose-file", default="/home/chriswang/docker/nginx/docker-compose.yml")
    value.add_argument("--nginx-container", default="nginx-sub2api")
    value.add_argument("--nginx-site-dir", default="/home/chriswang/docker/nginx/sites/dsh-remote")
    value.add_argument("--certbot-config", default="/home/chriswang/docker/certbot/conf")
    value.add_argument("--certbot-webroot", default="/home/chriswang/docker/certbot/www")
    value.add_argument("--socket-host-dir", default="/home/chriswang/.local/share/dsh-remote")
    value.add_argument("--socket-container-path", default="/run/dsh-remote/tunnel.sock")
    value.add_argument("--socket-group", default="dsh-remote")
    value.add_argument("--state-dir", default="/home/chriswang/.local/state/dsh-remote")
    value.add_argument("--ssh-uid", type=int, default=1002)
    value.add_argument("--site-template", required=True)
    value.add_argument("--offline-template", required=True)
    value.add_argument("--receipt", default="")
    return value


def main() -> int:
    args = parser().parse_args()
    try:
        validate_inputs(args)
        if args.action == "preflight":
            result = preflight(args)
        elif args.action == "apply":
            result = apply(args)
        elif args.action == "status":
            result = status(args)
        else:
            result = rollback(args)
        print(json.dumps(result, sort_keys=True))
        return 0
    except EdgeError as error:
        print(json.dumps({"status": "error", "message": str(error)}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
