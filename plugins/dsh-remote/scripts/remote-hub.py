#!/usr/bin/env python3
"""Registry-driven multi-instance edge management for DSH Remote."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import getpass
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any

import yaml


EDGE_SPEC = importlib.util.spec_from_file_location("dsh_remote_edge_shared", Path(__file__).with_name("remote-edge.py"))
if EDGE_SPEC is None or EDGE_SPEC.loader is None:
    raise RuntimeError("Unable to load dsh-remote edge helpers")
edge = importlib.util.module_from_spec(EDGE_SPEC)
EDGE_SPEC.loader.exec_module(edge)

HubError = edge.EdgeError
HUB_BEGIN = "# BEGIN DSH-REMOTE-HUB MANAGED"
HUB_END = "# END DSH-REMOTE-HUB MANAGED"
INSTANCE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
DOMAIN_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$")
REGISTRY_SCHEMA = 1
ADMIN_SCHEMA = 1
CERTBOT_IMAGE = "certbot/dns-cloudflare@sha256:3bd60102cdef55294a44ffbff10bb54dd086803aa57d3f854933b756d305fbb8"
TRANSACTION_SCHEMA = "dsh-remote-hub-transaction-v2"
RECEIPT_SCHEMA = "dsh-remote-hub-receipt-v2"


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def generation_for(instances: list[dict[str, Any]]) -> str:
    stable = [{"id": item["id"], **({"created_at": item["created_at"]} if item.get("created_at") else {})} for item in sorted(instances, key=lambda item: item["id"])]
    return hashlib.sha256(canonical_json(stable).encode()).hexdigest()


@contextmanager
def hub_lock(args: argparse.Namespace):
    state = Path(args.state_dir)
    state.mkdir(parents=True, exist_ok=True)
    os.chmod(state, 0o700)
    lock_path = state / "hub.lock"
    with lock_path.open("a+", encoding="utf-8") as handle:
        os.chmod(lock_path, 0o600)
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield


def failpoint(name: str) -> None:
    if os.environ.get("DSH_REMOTE_HUB_FAIL_AT") == name:
        raise HubError(f"Injected failure at {name}")


def validate_instance_id(value: str) -> str:
    if not INSTANCE_RE.fullmatch(value) or "--" in value:
        raise HubError("Invalid instance id")
    return value


def validate_inputs(args: argparse.Namespace) -> None:
    if not DOMAIN_RE.fullmatch(args.base_domain) or ".." in args.base_domain:
        raise HubError("Invalid base domain")
    for name in (
        "nginx_config", "compose_file", "hub_site_dir", "certbot_config",
        "socket_host_dir", "state_dir", "renewal_cron", "cloudflare_credentials",
        "health_service", "health_timer", "alert_service", "logrotate_config",
    ):
        value = getattr(args, name)
        if not edge.ABS_PATH_RE.fullmatch(value) or ".." in Path(value).parts:
            raise HubError(f"Invalid absolute path for {name}")
    if args.instance_id:
        validate_instance_id(args.instance_id)
    if not edge.SAFE_NAME_RE.fullmatch(args.nginx_container):
        raise HubError("Invalid Nginx container name")


def registry_path(args: argparse.Namespace) -> Path:
    return Path(args.state_dir) / "instances.json"


def routes_path(args: argparse.Namespace) -> Path:
    return Path(args.hub_site_dir) / "routes" / "routes.conf"


def admin_dir(args: argparse.Namespace) -> Path:
    return Path(args.hub_site_dir) / "admin"


def admin_config_path(args: argparse.Namespace) -> Path:
    return Path(args.state_dir) / "admin.json"


def admin_auth_path(args: argparse.Namespace) -> Path:
    return admin_dir(args) / "users.htpasswd"


def admin_status_path(args: argparse.Namespace) -> Path:
    return admin_dir(args) / "status.json"


def admin_page_path(args: argparse.Namespace) -> Path:
    return admin_dir(args) / "index.html"


def load_admin_config(args: argparse.Namespace) -> dict[str, str] | None:
    path = admin_config_path(args)
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise HubError("Hub admin configuration is unreadable") from error
    route = value.get("path") if isinstance(value, dict) else None
    if value.get("schema") != ADMIN_SCHEMA or not isinstance(route, str) or not re.fullmatch(r"/[A-Za-z0-9_-]{43}", route):
        raise HubError("Hub admin configuration is invalid")
    if (path.stat().st_mode & 0o777) != 0o600:
        raise HubError("Hub admin configuration must be mode 0600")
    return {"path": route}


def admin_route(args: argparse.Namespace) -> str | None:
    if not hasattr(args, "state_dir"):
        return None
    config = load_admin_config(args)
    return config["path"] if config else None


def render_admin_page() -> str:
    return """<!doctype html>
<meta charset=\"utf-8\">
<title>Hub status</title>
<pre id=\"status\"></pre>
<script>fetch(`${location.pathname.replace(/\/$/,'')}/status`,{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject()).then(v=>document.querySelector('#status').textContent=JSON.stringify(v,null,2)).catch(()=>document.querySelector('#status').textContent='Unavailable')</script>
"""


def render_admin_status(args: argparse.Namespace, instances: list[dict[str, Any]]) -> str:
    return json.dumps({"instances": [{"id": item["id"], "state": item["state"]} for item in instances]}, separators=(",", ":")) + "\n"


def read_admin_password(args: argparse.Namespace, *, confirm: bool) -> str:
    password = sys.stdin.readline().rstrip("\n") if args.password_stdin else getpass.getpass("Hub admin password: ")
    if confirm:
        repeated = getpass.getpass("Repeat Hub admin password: ") if not args.password_stdin else password
        if password != repeated:
            raise HubError("Hub admin passwords do not match")
    if len(password) < 12 or "\x00" in password or "\n" in password or "\r" in password:
        raise HubError("Hub admin password must be at least 12 characters and contain no line breaks")
    return password


def password_hash(password: str) -> str:
    result = subprocess.run(["openssl", "passwd", "-6", "-stdin"], input=password + "\n", text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise HubError("Unable to create a SHA-512 crypt password hash")
    hashed = result.stdout.strip()
    if not re.fullmatch(r"\$6\$[^:$\n]+\$[./0-9A-Za-z]+", hashed):
        raise HubError("Unable to create a SHA-512 crypt password hash")
    return hashed


def write_admin_auth(args: argparse.Namespace, password: str) -> None:
    admin_dir(args).mkdir(parents=True, exist_ok=True)
    edge.atomic_write(admin_auth_path(args), f"dsh-admin:{password_hash(password)}\n", 0o640)
    set_admin_permissions(args)


def set_admin_permissions(args: argparse.Namespace) -> None:
    group = edge.run(["getent", "group", args.socket_group], check=False)
    fields = group.stdout.strip().split(":") if group.returncode == 0 else []
    if len(fields) < 3 or not fields[2].isdigit():
        raise HubError("Hub socket group is required for private admin files")
    group_id = int(fields[2])
    for path in (admin_dir(args),):
        os.chown(path, 0, group_id)
        os.chmod(path, 0o750)
    for path in (admin_auth_path(args), admin_status_path(args), admin_page_path(args)):
        if path.is_file():
            os.chown(path, 0, group_id)
            os.chmod(path, 0o640)


def install_admin_files(args: argparse.Namespace) -> None:
    config = load_admin_config(args)
    if config is None:
        return
    admin_dir(args).mkdir(parents=True, exist_ok=True)
    edge.atomic_write(admin_page_path(args), render_admin_page(), 0o640)
    if not admin_auth_path(args).is_file() or (admin_auth_path(args).stat().st_mode & 0o777) != 0o640:
        raise HubError("Hub admin authentication file is missing or has unsafe permissions")
    set_admin_permissions(args)


def refresh_admin_status(args: argparse.Namespace, instances: list[dict[str, Any]] | None = None) -> None:
    if load_admin_config(args) is None:
        return
    if instances is None:
        group = edge.run(["getent", "group", args.socket_group], check=False)
        fields = group.stdout.strip().split(":") if group.returncode == 0 else []
        group_id = int(fields[2]) if len(fields) >= 3 else None
        instances = [socket_status(args, item["id"], group_id) for item in load_registry(args)["instances"]]
    edge.atomic_write(admin_status_path(args), render_admin_status(args, instances), 0o640)
    set_admin_permissions(args)


def admin_configured(args: argparse.Namespace, group_id: int | None) -> bool:
    config = load_admin_config(args)
    if config is None:
        return True
    if group_id is None:
        return False
    expected = (admin_auth_path(args), admin_status_path(args), admin_page_path(args))
    return (
        admin_dir(args).is_dir()
        and (admin_dir(args).stat().st_mode & 0o777) == 0o750
        and admin_dir(args).stat().st_uid == 0
        and admin_dir(args).stat().st_gid == group_id
        and all(path.is_file() and (path.stat().st_mode & 0o777) == 0o640 and path.stat().st_uid == 0 and path.stat().st_gid == group_id for path in expected)
    )


def renewal_script_path(args: argparse.Namespace) -> Path:
    return Path(args.hub_site_dir) / "renew-wildcard-certificate.sh"


def health_script_path(args: argparse.Namespace) -> Path:
    return Path(args.hub_site_dir) / "health-check.sh"


def alert_script_path(args: argparse.Namespace) -> Path:
    return Path(args.hub_site_dir) / "health-alert.sh"


def render_logrotate(args: argparse.Namespace) -> str:
    renewal_log = Path(args.state_dir) / "certificate-renewal.log"
    health_log = Path(args.state_dir) / "health.log"
    return f"""{renewal_log} {health_log} {{
    daily
    rotate 14
    size 1M
    compress
    missingok
    notifempty
    copytruncate
    create 0600 root root
}}
"""


def empty_registry(base_domain: str) -> dict[str, Any]:
    return {"schema": REGISTRY_SCHEMA, "base_domain": base_domain, "generation": generation_for([]), "instances": []}


def load_registry(args: argparse.Namespace) -> dict[str, Any]:
    path = registry_path(args)
    if not path.is_file():
        return empty_registry(args.base_domain)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as error:
        raise HubError("Hub registry is unreadable") from error
    if not isinstance(value, dict) or value.get("schema") != REGISTRY_SCHEMA or value.get("base_domain") != args.base_domain:
        raise HubError("Hub registry schema or base domain does not match")
    instances = value.get("instances")
    if not isinstance(instances, list) or not all(isinstance(item, dict) and isinstance(item.get("id"), str) for item in instances):
        raise HubError("Hub registry instances are invalid")
    ids = [validate_instance_id(item["id"]) for item in instances]
    if len(ids) != len(set(ids)):
        raise HubError("Hub registry contains duplicate instance ids")
    normalized = sorted(instances, key=lambda item: item["id"])
    generation = value.get("generation") or generation_for(normalized)
    if not isinstance(generation, str) or not re.fullmatch(r"[0-9a-f]{64}", generation):
        raise HubError("Hub registry generation is invalid")
    if generation != generation_for(normalized):
        raise HubError("Hub registry generation does not match its instances")
    return {"schema": REGISTRY_SCHEMA, "base_domain": args.base_domain, "generation": generation, "instances": normalized}


def render_routes(base_domain: str, instances: list[dict[str, Any]], *, https: bool, generation: str | None = None, admin_path: str | None = None) -> str:
    generation = generation or generation_for(instances)
    lines = [
        "# Generated by dsh-remote-edge. Do not edit.",
        f"# generation: {generation}",
        "map $http_upgrade $dsh_hub_connection {",
        "    default upgrade;",
        "    '' '';",
        "}",
        "limit_req_zone $binary_remote_addr zone=dsh_hub_admin:10m rate=5r/m;",
        "",
    ]
    for item in sorted(instances, key=lambda value: value["id"]):
        instance_id = validate_instance_id(item["id"])
        upstream = instance_id.replace("-", "_")
        domain = f"{instance_id}.{base_domain}"
        lines.extend([
            f"upstream dsh_hub_{upstream} {{",
            f"    server unix:/run/dsh-remote/instances/{instance_id}.sock;",
            "    server 127.0.0.1:18082 backup;",
            "    keepalive 8;",
            "}",
            "",
            "server {",
            "    listen 80;",
            f"    server_name {domain};",
            f"    return 301 https://{domain}$request_uri;" if https else "    return 503;",
            "}",
            "",
        ])
        if https:
            lines.extend([
                "server {",
                "    listen 443 ssl;",
                "    http2 on;",
                f"    server_name {domain};",
                f"    ssl_certificate /etc/letsencrypt/live/{base_domain}/fullchain.pem;",
                f"    ssl_certificate_key /etc/letsencrypt/live/{base_domain}/privkey.pem;",
                "    ssl_protocols TLSv1.2 TLSv1.3;",
                "    access_log off;",
                "    server_tokens off;",
                "    client_max_body_size 100m;",
                "    location / {",
                f"        proxy_pass http://dsh_hub_{upstream};",
                "        proxy_http_version 1.1;",
                "        proxy_set_header Host $host;",
                "        proxy_set_header X-Forwarded-Host $host;",
                "        proxy_set_header X-Forwarded-Proto $scheme;",
                "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
                "        proxy_set_header Upgrade $http_upgrade;",
                "        proxy_set_header Connection $dsh_hub_connection;",
                "        proxy_buffering off;",
                "        proxy_request_buffering off;",
                "        proxy_connect_timeout 10s;",
                "        proxy_send_timeout 3600s;",
                "        proxy_read_timeout 3600s;",
                "        proxy_next_upstream error timeout invalid_header;",
                "        proxy_next_upstream_tries 2;",
                "    }",
                "}",
                "",
            ])
    lines.extend([
        "server {",
        "    listen 80;",
        f"    server_name {base_domain} *.{base_domain};",
        "    return 404;",
        "}",
        "",
    ])
    if https:
        lines.extend([
            "server {",
            "    listen 443 ssl;",
            "    http2 on;",
            f"    server_name {base_domain};",
            f"    ssl_certificate /etc/letsencrypt/live/{base_domain}/fullchain.pem;",
            f"    ssl_certificate_key /etc/letsencrypt/live/{base_domain}/privkey.pem;",
            "    access_log off;",
            "    server_tokens off;",
        ])
        if admin_path:
            lines.extend([
                f"    location = {admin_path} {{",
                "        auth_basic \"restricted\";",
                "        auth_basic_user_file /etc/nginx/dsh-remote-hub/admin/users.htpasswd;",
                "        limit_req zone=dsh_hub_admin burst=5 nodelay;",
                "        limit_req_status 429;",
                "        add_header Cache-Control \"no-store\" always;",
                "        alias /etc/nginx/dsh-remote-hub/admin/index.html;",
                "    }",
                f"    location = {admin_path}/status {{",
                "        auth_basic \"restricted\";",
                "        auth_basic_user_file /etc/nginx/dsh-remote-hub/admin/users.htpasswd;",
                "        limit_req zone=dsh_hub_admin burst=5 nodelay;",
                "        limit_req_status 429;",
                "        default_type application/json;",
                "        add_header Cache-Control \"no-store\" always;",
                "        alias /etc/nginx/dsh-remote-hub/admin/status.json;",
                "    }",
            ])
        lines.extend([
            "    return 404;",
            "}",
            "",
            "server {",
            "    listen 443 ssl;",
            "    http2 on;",
            f"    server_name *.{base_domain};",
            f"    ssl_certificate /etc/letsencrypt/live/{base_domain}/fullchain.pem;",
            f"    ssl_certificate_key /etc/letsencrypt/live/{base_domain}/privkey.pem;",
            "    access_log off;",
            "    server_tokens off;",
            "    return 404;",
            "}",
            "",
        ])
    lines.extend([
        "server {",
        "    listen 127.0.0.1:18082;",
        "    server_name _;",
        "    access_log off;",
        "    server_tokens off;",
        "    location / { return 503; }",
        "    error_page 503 =503 @dsh_hub_offline;",
        "    location @dsh_hub_offline {",
        "        internal;",
        "        root /usr/share/nginx/html;",
        "        try_files /dsh-remote-hub-offline.html =503;",
        "    }",
        "}",
        "",
    ])
    return "\n".join(lines)


def replace_hub_include(original: str, include: str | None) -> str:
    start = original.find(HUB_BEGIN)
    end = original.find(HUB_END)
    if (start == -1) != (end == -1):
        raise HubError("Nginx config contains an incomplete dsh-remote-hub marker block")
    if start != -1:
        if end < start or original.find(HUB_BEGIN, start + len(HUB_BEGIN)) != -1 or original.find(HUB_END, end + len(HUB_END)) != -1:
            raise HubError("Nginx config contains ambiguous dsh-remote-hub marker blocks")
        end += len(HUB_END)
        original = (original[:start].rstrip() + "\n" + original[end:].lstrip()).rstrip() + "\n"
    if include is None:
        return original
    managed = f"{HUB_BEGIN}\ninclude {include};\n{HUB_END}"
    return original.rstrip() + "\n\n" + managed + "\n"


def mount_destination(value: str) -> str:
    parts = value.split(":")
    return parts[1] if len(parts) >= 2 else ""


def update_compose(value: dict[str, Any], args: argparse.Namespace, group_id: int) -> dict[str, Any]:
    service = value["services"]["nginx"]
    volumes = service.setdefault("volumes", [])
    if not isinstance(volumes, list):
        raise HubError("nginx volumes must be a list")
    routes_host = str(routes_path(args).parent)
    offline_host = str(Path(args.hub_site_dir) / "offline.html")
    group_host = str(Path(args.hub_site_dir) / "nginx-socket-group.sh")
    desired = {
        "/run/dsh-remote": f"{args.socket_host_dir}:/run/dsh-remote:ro",
        "/etc/nginx/dsh-remote-hub": f"{routes_host}:/etc/nginx/dsh-remote-hub:ro",
        "/etc/nginx/dsh-remote-hub/admin": f"{admin_dir(args)}:/etc/nginx/dsh-remote-hub/admin:ro",
        "/usr/share/nginx/html/dsh-remote-hub-offline.html": f"{offline_host}:/usr/share/nginx/html/dsh-remote-hub-offline.html:ro",
        "/docker-entrypoint.d/06-dsh-remote-hub-socket-group.sh": f"{group_host}:/docker-entrypoint.d/06-dsh-remote-hub-socket-group.sh:ro",
    }
    retained = [entry for entry in volumes if not isinstance(entry, str) or mount_destination(entry) not in desired]
    existing_destinations = {mount_destination(entry) for entry in retained if isinstance(entry, str)}
    for destination, entry in sorted(desired.items()):
        if destination not in existing_destinations:
            retained.append(entry)
    service["volumes"] = retained
    groups = service.setdefault("group_add", [])
    if not isinstance(groups, list):
        raise HubError("nginx group_add must be a list")
    service["group_add"] = [item for index, item in enumerate([*groups, str(group_id)]) if str(item) not in {str(value) for value in [*groups, str(group_id)][:index]}]
    return value


def wildcard_certificate_valid(args: argparse.Namespace, minimum_seconds: int = 30 * 24 * 60 * 60) -> bool:
    certificate = Path(args.certbot_config) / "live" / args.base_domain / "fullchain.pem"
    if not certificate.is_file():
        return False
    return all([
        edge.run(["openssl", "x509", "-checkhost", args.base_domain, "-noout", "-in", str(certificate)], check=False).returncode == 0,
        edge.run(["openssl", "x509", "-checkhost", f"probe.{args.base_domain}", "-noout", "-in", str(certificate)], check=False).returncode == 0,
        edge.run(["openssl", "x509", "-checkend", str(minimum_seconds), "-noout", "-in", str(certificate)], check=False).returncode == 0,
    ])


def certbot_command(args: argparse.Namespace, extra: list[str]) -> list[str]:
    if not re.fullmatch(r"certbot/dns-cloudflare@sha256:[0-9a-f]{64}", CERTBOT_IMAGE):
        raise HubError("Certificate automation image must be pinned by digest")
    return [
        "docker", "run", "--rm",
        "-v", f"{args.certbot_config}:/etc/letsencrypt",
        "-v", f"{args.cloudflare_credentials}:/run/secrets/cloudflare.ini:ro",
        CERTBOT_IMAGE, "certonly", "--dns-cloudflare",
        "--dns-cloudflare-credentials", "/run/secrets/cloudflare.ini",
        "--dns-cloudflare-propagation-seconds", "30",
        "--cert-name", args.base_domain,
        "-d", args.base_domain, "-d", f"*.{args.base_domain}",
        "--non-interactive", "--agree-tos", "--register-unsafely-without-email", "--keep-until-expiring",
        *extra,
    ]


def issue_wildcard_certificate(args: argparse.Namespace) -> None:
    if wildcard_certificate_valid(args):
        return
    credentials = Path(args.cloudflare_credentials)
    if not credentials.is_file() or (credentials.stat().st_mode & 0o777) != 0o600:
        raise HubError("Cloudflare credentials must be a mode-0600 regular file")
    edge.run(certbot_command(args, []), capture=False)
    if not wildcard_certificate_valid(args):
        raise HubError("Wildcard certificate issuance did not produce the required SANs")


def render_renewal_script(args: argparse.Namespace) -> str:
    command = " \\\n  ".join(shlex.quote(value) for value in certbot_command(args, ["--quiet"]))
    return f"""#!/bin/sh
set -eu

extra=
case "${{1:-}}" in
  '') ;;
  --dry-run) extra=--dry-run ;;
  *) echo "dsh-remote-hub: expected no argument or --dry-run" >&2; exit 2 ;;
esac

{command} $extra
docker exec {args.nginx_container} nginx -t
docker exec {args.nginx_container} nginx -s reload
"""


def install_renewal(args: argparse.Namespace) -> None:
    script = renewal_script_path(args)
    cron = Path(args.renewal_cron)
    edge.atomic_write(script, render_renewal_script(args), 0o700)
    log = str(Path(args.state_dir) / "certificate-renewal.log")
    edge.atomic_write(cron, f"23 3 * * * root {script} >> {log} 2>&1\n", 0o644)


def render_health_script(args: argparse.Namespace) -> str:
    registry = shlex.quote(str(registry_path(args)))
    certificate = shlex.quote(str(Path(args.certbot_config) / "live" / args.base_domain / "fullchain.pem"))
    status_command = " ".join(shlex.quote(value) for value in [
        "python3", str(Path(args.hub_site_dir) / "bin" / "remote-hub.py"), "hub-status",
        "--base-domain", args.base_domain, "--offline-template", str(Path(args.hub_site_dir) / "offline.html"),
        "--group-init-template", str(Path(args.hub_site_dir) / "nginx-socket-group.sh"),
    ])
    return f"""#!/bin/sh
set -eu

{status_command} >/dev/null 2>&1 || true
docker exec {shlex.quote(args.nginx_container)} nginx -t >/dev/null
openssl x509 -checkend 2592000 -noout -in {certificate} >/dev/null
python3 - {registry} <<'PY'
import json, subprocess, sys
registry = json.load(open(sys.argv[1], encoding="utf-8"))
for item in registry["instances"]:
    domain = f'{{item["id"]}}.{args.base_domain}'
    result = subprocess.run([
        "curl", "--silent", "--show-error", "--output", "/dev/null",
        "--write-out", "%{{http_code}}", "--max-time", "10",
        "--resolve", f"{{domain}}:443:127.0.0.1",
        f"https://{{domain}}/api/events.mux",
    ], text=True, capture_output=True, check=False)
    if result.returncode or result.stdout != "401":
        raise SystemExit(f"{{item['id']}} protected route unhealthy: {{result.stdout or 'transport-error'}}")
PY
"""


def render_alert_script(args: argparse.Namespace) -> str:
    alarm = shlex.quote(str(Path(args.state_dir) / "health-alarm"))
    return f"""#!/bin/sh
set -eu
message="dsh-remote-hub health check failed; run dsh-remote-edge hub status"
umask 077
printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$message" > {alarm}
logger -p daemon.err -t dsh-remote-hub -- "$message"
printf '%s\n' "$message" | wall -n 2>/dev/null || true
"""


def render_health_units(args: argparse.Namespace) -> dict[Path, tuple[str, int]]:
    service = f"""[Unit]
Description=DSH Remote Hub health check
OnFailure=dsh-remote-hub-alert.service

[Service]
Type=oneshot
ExecStart={health_script_path(args)}
StandardOutput=append:{Path(args.state_dir) / 'health.log'}
StandardError=append:{Path(args.state_dir) / 'health.log'}
"""
    timer = """[Unit]
Description=Run DSH Remote Hub health checks

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
"""
    alert = f"""[Unit]
Description=Deliver DSH Remote Hub health alert

[Service]
Type=oneshot
ExecStart={alert_script_path(args)}
"""
    return {
        Path(args.health_service): (service, 0o644),
        Path(args.health_timer): (timer, 0o644),
        Path(args.alert_service): (alert, 0o644),
    }


def install_monitoring(args: argparse.Namespace) -> None:
    edge.atomic_write(health_script_path(args), render_health_script(args), 0o700)
    edge.atomic_write(alert_script_path(args), render_alert_script(args), 0o700)
    for path, (value, mode) in render_health_units(args).items():
        edge.atomic_write(path, value, mode)
    edge.atomic_write(Path(args.logrotate_config), render_logrotate(args), 0o644)
    edge.run(["systemctl", "daemon-reload"])
    edge.run(["systemctl", "enable", "--now", Path(args.health_timer).name])


def monitoring_configured(args: argparse.Namespace) -> bool:
    expected = {
        health_script_path(args): (render_health_script(args), 0o700),
        alert_script_path(args): (render_alert_script(args), 0o700),
        **render_health_units(args),
        Path(args.logrotate_config): (render_logrotate(args), 0o644),
    }
    files_ok = all(path.is_file() and path.read_text(encoding="utf-8") == value and (path.stat().st_mode & 0o777) == mode for path, (value, mode) in expected.items())
    timer_ok = edge.run(["systemctl", "is-enabled", "--quiet", Path(args.health_timer).name], check=False).returncode == 0
    return files_ok and timer_ok


def renewal_configured(args: argparse.Namespace) -> bool:
    script = renewal_script_path(args)
    cron = Path(args.renewal_cron)
    if not script.is_file() or not cron.is_file():
        return False
    expected_cron = f"23 3 * * * root {script} >> {Path(args.state_dir) / 'certificate-renewal.log'} 2>&1\n"
    return (
        script.read_text(encoding="utf-8") == render_renewal_script(args)
        and (script.stat().st_mode & 0o777) == 0o700
        and cron.read_text(encoding="utf-8") == expected_cron
        and (cron.stat().st_mode & 0o777) == 0o644
    )


def nginx_syntax_canary(args: argparse.Namespace, registry: dict[str, Any]) -> None:
    compose = edge.load_compose(Path(args.compose_file))
    image = compose.get("services", {}).get("nginx", {}).get("image")
    if not isinstance(image, str) or not image.strip():
        raise HubError("Nginx Compose service must declare an image for the syntax canary")
    with tempfile.TemporaryDirectory(prefix="dsh-remote-hub-canary-") as directory:
        root = Path(directory)
        routes = root / "routes"
        routes.mkdir()
        edge.atomic_write(routes / "routes.conf", render_routes(args.base_domain, registry["instances"], https=False, admin_path=admin_route(args)), 0o644)
        current = Path(args.nginx_config).read_text(encoding="utf-8")
        edge.atomic_write(root / "nginx.conf", replace_hub_include(current, "/etc/nginx/dsh-remote-hub/routes.conf"), 0o644)
        edge.run([
            "docker", "run", "--rm",
            "--network", f"container:{args.nginx_container}",
            "-v", f"{root / 'nginx.conf'}:/etc/nginx/conf.d/default.conf:ro",
            "-v", f"{routes}:/etc/nginx/dsh-remote-hub:ro",
            "-v", f"{args.certbot_config}:/etc/letsencrypt:ro",
            image, "nginx", "-t",
        ], capture=False)


def preflight(args: argparse.Namespace) -> dict[str, Any]:
    for path in (Path(args.nginx_config), Path(args.compose_file), Path(args.offline_template), Path(args.group_init_template)):
        if not path.is_file():
            raise HubError(f"Required file is missing: {path}")
    for executable in ("openssl", "docker", "curl", "systemctl", "wall"):
        if shutil.which(executable) is None:
            raise HubError(f"Required executable is missing: {executable}")
    observed = edge.resolve_ipv4(f"probe.{args.base_domain}")
    if args.expected_ipv4 not in observed:
        raise HubError(f"Wildcard DNS is not ready; observed {observed or ['no A record']}")
    edge.compose_validate(Path(args.compose_file))
    edge.nginx_validate(args.nginx_container)
    nginx_syntax_canary(args, load_registry(args))
    return {
        "base_domain": args.base_domain,
        "wildcard_dns_ipv4": observed,
        "nginx_sha256": edge.sha256(Path(args.nginx_config)),
        "compose_sha256": edge.sha256(Path(args.compose_file)),
        "nginx_syntax_canary": "passed",
    }


def managed_paths(args: argparse.Namespace) -> dict[str, Path]:
    return {
        "registry": registry_path(args),
        "admin_config": admin_config_path(args),
        "routes": routes_path(args),
        "offline": Path(args.hub_site_dir) / "offline.html",
        "group_init": Path(args.hub_site_dir) / "nginx-socket-group.sh",
        "renewal_script": renewal_script_path(args),
        "renewal_cron": Path(args.renewal_cron),
        "health_script": health_script_path(args),
        "alert_script": alert_script_path(args),
        "health_service": Path(args.health_service),
        "health_timer": Path(args.health_timer),
        "alert_service": Path(args.alert_service),
        "logrotate_config": Path(args.logrotate_config),
    }


def admin_configure(args: argparse.Namespace, *, rotate: bool) -> dict[str, Any]:
    with hub_lock(args):
        existing = load_admin_config(args)
        if not rotate and existing is not None:
            raise HubError("Hub admin is already initialized; use hub admin-rotate")
        if rotate and existing is None:
            raise HubError("Hub admin is not initialized")
        password = read_admin_password(args, confirm=not rotate)
        config = existing or {"path": "/" + secrets.token_urlsafe(32)}
        state = Path(args.state_dir)
        state.mkdir(parents=True, exist_ok=True)
        os.chmod(state, 0o700)
        snapshot = admin_snapshot(args)
        try:
            if existing is None:
                edge.atomic_write(admin_config_path(args), json.dumps({"schema": ADMIN_SCHEMA, **config}, sort_keys=True) + "\n", 0o600)
            write_admin_auth(args, password)
            install_admin_files(args)
            if routes_path(args).is_file():
                registry = load_registry(args)
                edge.atomic_write(routes_path(args), render_routes(args.base_domain, registry["instances"], https=True, generation=registry["generation"], admin_path=config["path"]), 0o644)
                refresh_admin_status(args)
                edge.nginx_validate(args.nginx_container)
                edge.run(["docker", "exec", args.nginx_container, "nginx", "-s", "reload"])
        except Exception:
            restore_admin_snapshot(args, snapshot)
            raise
        return {"status": "rotated" if rotate else "initialized", "admin_path": config["path"]}


def managed_objects(args: argparse.Namespace) -> dict[str, tuple[Path, bool]]:
    objects = {label: (path, True) for label, path in managed_paths(args).items()}
    objects.update({
        "certificate_live": (Path(args.certbot_config) / "live" / args.base_domain, True),
        "certificate_archive": (Path(args.certbot_config) / "archive" / args.base_domain, True),
        "certificate_renewal": (Path(args.certbot_config) / "renewal" / f"{args.base_domain}.conf", True),
        "socket_root": (Path(args.socket_host_dir), False),
        "socket_instances": (Path(args.socket_host_dir) / "instances", False),
        "hub_site_dir": (Path(args.hub_site_dir), False),
        "routes_dir": (routes_path(args).parent, False),
        "hub_helpers": (Path(args.hub_site_dir) / "bin", True),
        "admin_dir": (admin_dir(args), True),
    })
    return objects


def admin_snapshot(args: argparse.Namespace) -> tuple[Path, dict[str, Any]]:
    root = Path(args.state_dir) / "admin-transactions"
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    directory = root / time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    suffix = 0
    while directory.exists():
        suffix += 1
        directory = root / f"{directory.name}-{suffix}"
    directory.mkdir(mode=0o700)
    objects = {
        "admin_config": capture_object(directory, "admin_config", admin_config_path(args), True),
        "admin_dir": capture_object(directory, "admin_dir", admin_dir(args), True),
        "routes": capture_object(directory, "routes", routes_path(args), True),
    }
    receipt = {"schema": "dsh-remote-hub-admin-transaction-v1", "objects": objects}
    edge.atomic_write(directory / "receipt.json", json.dumps(receipt, sort_keys=True) + "\n", 0o600)
    return directory, receipt


def restore_admin_snapshot(args: argparse.Namespace, snapshot: tuple[Path, dict[str, Any]]) -> None:
    directory, receipt = snapshot
    for label in ("routes", "admin_dir", "admin_config"):
        restore_object(directory, label, receipt["objects"][label])
    if routes_path(args).is_file():
        edge.nginx_validate(args.nginx_container)
        edge.run(["docker", "exec", args.nginx_container, "nginx", "-s", "reload"])


def capture_object(destination: Path, label: str, path: Path, include_contents: bool) -> dict[str, Any]:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {"path": str(path), "type": "absent", "include_contents": include_contents}
    kind = "symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "other"
    if kind == "other":
        raise HubError(f"Unsupported managed object type: {path}")
    details: dict[str, Any] = {
        "path": str(path), "type": kind, "mode": stat.S_IMODE(info.st_mode),
        "uid": info.st_uid, "gid": info.st_gid, "include_contents": include_contents,
    }
    backup_path = destination / "objects" / label
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    if kind == "symlink":
        details["target"] = os.readlink(path)
    elif kind == "file":
        shutil.copy2(path, backup_path, follow_symlinks=False)
        details["sha256"] = edge.sha256(path)
    elif include_contents:
        shutil.copytree(path, backup_path, symlinks=True, copy_function=shutil.copy2)
    return details


def remove_object(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)


def restore_object(directory: Path, label: str, details: dict[str, Any]) -> None:
    path = Path(details["path"])
    kind = details["type"]
    include_contents = bool(details.get("include_contents"))
    if kind == "absent":
        if include_contents:
            remove_object(path)
        elif path.is_dir():
            try:
                path.rmdir()
            except OSError as error:
                raise HubError(f"Cannot remove nonempty directory created by Hub: {path}") from error
        return
    if kind in {"file", "symlink"} or include_contents:
        remove_object(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    backup_path = directory / "objects" / label
    if kind == "file":
        shutil.copy2(backup_path, path, follow_symlinks=False)
    elif kind == "symlink":
        path.symlink_to(details["target"])
    elif include_contents:
        shutil.copytree(backup_path, path, symlinks=True, copy_function=shutil.copy2)
    else:
        path.mkdir(parents=True, exist_ok=True)
    if kind != "symlink":
        os.chown(path, int(details["uid"]), int(details["gid"]))
        os.chmod(path, int(details["mode"]))


def backup(args: argparse.Namespace) -> tuple[Path, dict[str, Any]]:
    state = Path(args.state_dir)
    state.mkdir(parents=True, exist_ok=True)
    os.chmod(state, 0o700)
    receipt_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    destination = state / "backups" / receipt_id
    suffix = 0
    while destination.exists():
        suffix += 1
        destination = state / "backups" / f"{receipt_id}-{suffix}"
    destination.mkdir(parents=True, mode=0o700)
    nginx = Path(args.nginx_config)
    compose = Path(args.compose_file)
    shutil.copy2(nginx, destination / "nginx.conf")
    shutil.copy2(compose, destination / "docker-compose.yml")
    group = edge.run(["getent", "group", args.socket_group], check=False)
    receipt: dict[str, Any] = {
        "schema": RECEIPT_SCHEMA, "id": destination.name,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "base_domain": args.base_domain, "applied": False, "rolled_back": False,
        "pre": {"nginx_sha256": edge.sha256(nginx), "compose_sha256": edge.sha256(compose)},
        "paths": {"nginx": str(nginx), "compose": str(compose)},
        "group": {"name": args.socket_group, "existed": group.returncode == 0, "record": group.stdout.strip() if group.returncode == 0 else None},
        "objects": {}, "certbot_image": CERTBOT_IMAGE,
    }
    for label, (path, include_contents) in managed_objects(args).items():
        receipt["objects"][label] = capture_object(destination, label, path, include_contents)
    edge.atomic_write(destination / "receipt.json", json.dumps(receipt, indent=2, sort_keys=True) + "\n", 0o600)
    return destination, receipt


def restore(args: argparse.Namespace, directory: Path, receipt: dict[str, Any], *, automatic: bool) -> None:
    shutil.copy2(directory / "nginx.conf", receipt["paths"]["nginx"])
    shutil.copy2(directory / "docker-compose.yml", receipt["paths"]["compose"])
    for label in [key for key in receipt["objects"] if key not in {"socket_root", "socket_instances", "hub_site_dir", "routes_dir"}]:
        restore_object(directory, label, receipt["objects"][label])
    for label in ("routes_dir", "hub_site_dir", "socket_instances", "socket_root"):
        restore_object(directory, label, receipt["objects"][label])
    edge.compose_validate(Path(args.compose_file))
    edge.compose_recreate(Path(args.compose_file))
    edge.nginx_validate(args.nginx_container)
    if not receipt["group"]["existed"]:
        edge.run(["groupdel", args.socket_group], check=False)
    edge.run(["systemctl", "daemon-reload"])
    receipt.update({"rolled_back": True, "automatic_rollback": automatic, "rollback_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    receipt["rollback_result"] = {"nginx_sha256": edge.sha256(Path(receipt["paths"]["nginx"])), "compose_sha256": edge.sha256(Path(receipt["paths"]["compose"])), "verified": True}
    edge.atomic_write(directory / "receipt.json", json.dumps(receipt, indent=2, sort_keys=True) + "\n", 0o600)


def hub_apply(args: argparse.Namespace) -> dict[str, Any]:
    with hub_lock(args):
        recover_pending_transactions(args)
        return _hub_apply_locked(args)


def _hub_apply_locked(args: argparse.Namespace) -> dict[str, Any]:
    facts = preflight(args)
    directory, receipt = backup(args)
    try:
        group_id, group_created = edge.ensure_group(args.socket_group)
        receipt["group"].update({"id": group_id, "created": group_created})
        socket_root = Path(args.socket_host_dir)
        instances_dir = socket_root / "instances"
        for path in (socket_root, instances_dir):
            path.mkdir(parents=True, exist_ok=True)
            os.chown(path, args.ssh_uid, group_id)
            os.chmod(path, 0o2770)
        site = Path(args.hub_site_dir)
        site.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.offline_template, site / "offline.html")
        os.chmod(site / "offline.html", 0o644)
        shutil.copy2(args.group_init_template, site / "nginx-socket-group.sh")
        os.chmod(site / "nginx-socket-group.sh", 0o755)
        helper_dir = site / "bin"
        helper_dir.mkdir(exist_ok=True)
        for helper in ("remote-hub.py", "remote-edge.py"):
            shutil.copy2(Path(__file__).with_name(helper), helper_dir / helper)
            os.chmod(helper_dir / helper, 0o700)
        registry = load_registry(args)
        edge.atomic_write(registry_path(args), json.dumps(registry, indent=2, sort_keys=True) + "\n", 0o600)
        install_admin_files(args)
        edge.atomic_write(routes_path(args), render_routes(args.base_domain, registry["instances"], https=False, generation=registry["generation"], admin_path=admin_route(args)), 0o644)
        compose = Path(args.compose_file)
        edge.atomic_write(compose, yaml.safe_dump(update_compose(edge.load_compose(compose), args, group_id), sort_keys=False), 0o644)
        nginx = Path(args.nginx_config)
        include = "/etc/nginx/dsh-remote-hub/routes.conf"
        edge.atomic_write(nginx, replace_hub_include(nginx.read_text(encoding="utf-8"), include), 0o644)
        edge.activate_bound_config(compose, args.nginx_container, group_id)
        issue_wildcard_certificate(args)
        install_renewal(args)
        install_monitoring(args)
        edge.atomic_write(routes_path(args), render_routes(args.base_domain, registry["instances"], https=True, generation=registry["generation"], admin_path=admin_route(args)), 0o644)
        refresh_admin_status(args)
        edge.nginx_validate(args.nginx_container)
        edge.run(["docker", "exec", args.nginx_container, "nginx", "-s", "reload"])
        receipt["applied"] = True
        receipt["facts"] = facts
        receipt["post"] = {"nginx_sha256": edge.sha256(nginx), "compose_sha256": edge.sha256(compose), "routes_sha256": edge.sha256(routes_path(args)), "registry_sha256": edge.sha256(registry_path(args)), "generation": registry["generation"], "certbot_image": CERTBOT_IMAGE}
        edge.atomic_write(directory / "receipt.json", json.dumps(receipt, indent=2, sort_keys=True) + "\n", 0o600)
        return {"status": "applied", "receipt": str(directory / "receipt.json"), "receipt_sha256": edge.sha256(directory / "receipt.json"), "group_id": group_id, **receipt["post"]}
    except Exception:
        edge.run(["systemctl", "disable", "--now", Path(args.health_timer).name], check=False)
        restore(args, directory, receipt, automatic=True)
        raise


def write_transaction_receipt(path: Path, receipt: dict[str, Any]) -> None:
    edge.atomic_write(path, json.dumps(receipt, indent=2, sort_keys=True) + "\n", 0o600)


def restore_transaction(args: argparse.Namespace, directory: Path, receipt: dict[str, Any], *, recovered: bool) -> None:
    registry_file = registry_path(args)
    routes_file = routes_path(args)
    edge.atomic_write(registry_file, (directory / "registry.pre").read_text(encoding="utf-8"), int(receipt["pre"]["registry_mode"]))
    edge.atomic_write(routes_file, (directory / "routes.pre").read_text(encoding="utf-8"), int(receipt["pre"]["routes_mode"]))
    socket_info = receipt.get("socket")
    if socket_info and Path(socket_info["quarantine"]).exists():
        original = Path(socket_info["path"])
        if original.exists():
            raise HubError(f"Cannot restore quarantined socket over existing path: {original}")
        os.replace(socket_info["quarantine"], original)
    edge.nginx_validate(args.nginx_container)
    edge.run(["docker", "exec", args.nginx_container, "nginx", "-s", "reload"])
    receipt["status"] = "recovered" if recovered else "rolled-back"
    receipt["restored_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_transaction_receipt(directory / "receipt.json", receipt)


def recover_pending_transactions(args: argparse.Namespace) -> None:
    root = Path(args.state_dir) / "transactions"
    if not root.is_dir():
        return
    for receipt_path in sorted(root.glob("*/receipt.json")):
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if receipt.get("schema") == TRANSACTION_SCHEMA and receipt.get("status") == "prepared":
            restore_transaction(args, receipt_path.parent, receipt, recovered=True)


def transaction(args: argparse.Namespace, registry: dict[str, Any], action: str, socket_path: Path | None = None) -> dict[str, Any]:
    state = Path(args.state_dir)
    state.mkdir(parents=True, exist_ok=True)
    os.chmod(state, 0o700)
    transaction_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{action}-{args.instance_id}"
    directory = state / "transactions" / transaction_id
    suffix = 0
    while directory.exists():
        suffix += 1
        directory = state / "transactions" / f"{transaction_id}-{suffix}"
    directory.mkdir(parents=True, mode=0o700)
    registry_file = registry_path(args)
    routes_file = routes_path(args)
    previous_registry = registry_file.read_text(encoding="utf-8")
    previous_routes = routes_file.read_text(encoding="utf-8")
    (directory / "registry.pre").write_text(previous_registry, encoding="utf-8")
    (directory / "routes.pre").write_text(previous_routes, encoding="utf-8")
    os.chmod(directory / "registry.pre", 0o600)
    os.chmod(directory / "routes.pre", 0o600)
    registry["generation"] = generation_for(registry["instances"])
    next_registry = json.dumps(registry, indent=2, sort_keys=True) + "\n"
    next_routes = render_routes(args.base_domain, registry["instances"], https=True, generation=registry["generation"], admin_path=admin_route(args))
    (directory / "registry.post").write_text(next_registry, encoding="utf-8")
    (directory / "routes.post").write_text(next_routes, encoding="utf-8")
    os.chmod(directory / "registry.post", 0o600)
    os.chmod(directory / "routes.post", 0o600)
    receipt: dict[str, Any] = {
        "schema": TRANSACTION_SCHEMA, "id": directory.name, "action": action,
        "instance_id": args.instance_id, "status": "prepared",
        "pre": {"registry_sha256": hashlib.sha256(previous_registry.encode()).hexdigest(), "routes_sha256": hashlib.sha256(previous_routes.encode()).hexdigest(), "registry_mode": registry_file.stat().st_mode & 0o777, "routes_mode": routes_file.stat().st_mode & 0o777},
        "post": {"registry_sha256": hashlib.sha256(next_registry.encode()).hexdigest(), "routes_sha256": hashlib.sha256(next_routes.encode()).hexdigest(), "generation": registry["generation"]},
        "socket": None,
    }
    if socket_path is not None and socket_path.exists():
        quarantine = directory / "socket.quarantine"
        info = socket_path.lstat()
        os.replace(socket_path, quarantine)
        receipt["socket"] = {"path": str(socket_path), "quarantine": str(quarantine), "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid, "type": "socket" if stat.S_ISSOCK(info.st_mode) else "file"}
    write_transaction_receipt(directory / "receipt.json", receipt)
    try:
        failpoint("transaction-prepared")
        edge.atomic_write(registry_file, next_registry, 0o600)
        failpoint("transaction-registry")
        edge.atomic_write(routes_file, next_routes, 0o644)
        failpoint("transaction-routes")
        edge.nginx_validate(args.nginx_container)
        edge.run(["docker", "exec", args.nginx_container, "nginx", "-s", "reload"])
        failpoint("transaction-reload")
    except Exception:
        restore_transaction(args, directory, receipt, recovered=False)
        raise
    receipt["status"] = "committed"
    receipt["committed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_transaction_receipt(directory / "receipt.json", receipt)
    return receipt


def instance_add(args: argparse.Namespace) -> dict[str, Any]:
    with hub_lock(args):
        recover_pending_transactions(args)
        registry = load_registry(args)
        ids = {item["id"] for item in registry["instances"]}
        if args.instance_id in ids:
            return {"status": "already-registered", "instance_id": args.instance_id}
        registry["instances"].append({"id": args.instance_id, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        registry["instances"].sort(key=lambda item: item["id"])
        receipt = transaction(args, registry, "add")
        return {"status": "registered", "instance_id": args.instance_id, "origin": f"https://{args.instance_id}.{args.base_domain}", "socket": f"{args.socket_host_dir}/instances/{args.instance_id}.sock", "transaction": receipt["id"], "generation": receipt["post"]["generation"]}


def instance_remove(args: argparse.Namespace) -> dict[str, Any]:
    with hub_lock(args):
        recover_pending_transactions(args)
        registry = load_registry(args)
        ids = {item["id"] for item in registry["instances"]}
        if args.instance_id not in ids:
            return {"status": "not-registered", "instance_id": args.instance_id}
        socket_path = Path(args.socket_host_dir) / "instances" / f"{args.instance_id}.sock"
        if socket_path.exists() and not args.force and (not socket_path.is_socket() or unix_socket_live(socket_path)):
            raise HubError("Instance socket is still live; stop the tunnel or pass --force")
        registry["instances"] = [item for item in registry["instances"] if item["id"] != args.instance_id]
        receipt = transaction(args, registry, "remove", socket_path if socket_path.exists() else None)
        return {"status": "removed", "instance_id": args.instance_id, "transaction": receipt["id"], "generation": receipt["post"]["generation"]}


def transaction_rollback(args: argparse.Namespace) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9TZ-]+", args.receipt):
        raise HubError("Invalid transaction receipt id")
    with hub_lock(args):
        recover_pending_transactions(args)
        directory = Path(args.state_dir) / "transactions" / args.receipt
        receipt_path = directory / "receipt.json"
        if not receipt_path.is_file():
            raise HubError("Transaction receipt not found")
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if receipt.get("status") in {"reversed", "rolled-back", "recovered"}:
            return {"status": "already-reversed", "transaction": args.receipt}
        if receipt.get("status") != "committed":
            raise HubError("Transaction is not committed")
        if edge.sha256(registry_path(args)) != receipt["post"]["registry_sha256"] or edge.sha256(routes_path(args)) != receipt["post"]["routes_sha256"]:
            raise HubError("Transaction rollback chain mismatch; reverse newest transaction first")
        restore_transaction(args, directory, receipt, recovered=False)
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["status"] = "reversed"
        write_transaction_receipt(receipt_path, receipt)
        return {"status": "reversed", "transaction": args.receipt, "registry_sha256": edge.sha256(registry_path(args)), "routes_sha256": edge.sha256(routes_path(args))}


def unix_socket_live(path: Path) -> bool:
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(1)
    try:
        connection.connect(str(path))
        return True
    except OSError:
        return False
    finally:
        connection.close()


def socket_status(args: argparse.Namespace, instance_id: str, group_id: int | None) -> dict[str, Any]:
    path = Path(args.socket_host_dir) / "instances" / f"{instance_id}.sock"
    secure = group_id is not None and edge.secure_path(path, mode=0o660, uid=args.ssh_uid, gid=group_id, socket_required=True)
    present = path.exists()
    listening = bool(present and path.is_socket() and unix_socket_live(path))
    domain = f"{instance_id}.{args.base_domain}"
    route = edge.run([
        "curl", "--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}",
        "--max-time", "10", "--resolve", f"{domain}:443:127.0.0.1", f"https://{domain}/api/events.mux",
    ], check=False) if secure and listening else None
    functional = route is not None and route.returncode == 0 and route.stdout == "401"
    state = "missing" if not present else "insecure" if not secure else "online" if functional else "offline"
    return {"id": instance_id, "origin": f"https://{domain}", "state": state, "ready": state == "online", "socket_present": path.is_socket(), "socket_secure": secure, "socket_listening": listening, "protected_route_status": route.stdout if route is not None and route.returncode == 0 else None}


def hub_status(args: argparse.Namespace) -> dict[str, Any]:
    with hub_lock(args):
        recover_pending_transactions(args)
        return _hub_status_locked(args)


def _hub_status_locked(args: argparse.Namespace) -> dict[str, Any]:
    registry = load_registry(args)
    group = edge.run(["getent", "group", args.socket_group], check=False)
    fields = group.stdout.strip().split(":") if group.returncode == 0 else []
    group_id = int(fields[2]) if len(fields) >= 3 else None
    routes = routes_path(args)
    nginx = Path(args.nginx_config)
    compose = edge.load_compose(Path(args.compose_file))["services"]["nginx"]
    destinations = {mount_destination(item) for item in compose.get("volumes", []) if isinstance(item, str)}
    expected_destinations = {"/run/dsh-remote", "/etc/nginx/dsh-remote-hub", "/etc/nginx/dsh-remote-hub/admin", "/usr/share/nginx/html/dsh-remote-hub-offline.html", "/docker-entrypoint.d/06-dsh-remote-hub-socket-group.sh"}
    registry_file = registry_path(args)
    routes_expected = render_routes(args.base_domain, registry["instances"], https=True, generation=registry["generation"], admin_path=admin_route(args))
    registry_secure = registry_file.is_file() and (registry_file.stat().st_mode & 0o777) == 0o600 and registry_file.stat().st_uid == 0
    routes_current = routes.read_text(encoding="utf-8") if routes.is_file() else ""
    instances_dir = Path(args.socket_host_dir) / "instances"
    directories_secure = group_id is not None and all(edge.secure_path(path, mode=0o2770, uid=args.ssh_uid, gid=group_id) for path in (Path(args.socket_host_dir), instances_dir))
    worker_group = group_id is not None and edge.run(["docker", "exec", args.nginx_container, "sh", "-c", f"id -G nginx | tr ' ' '\\n' | grep -Fxq {group_id}"], check=False).returncode == 0
    group_add = group_id is not None and str(group_id) in {str(item) for item in compose.get("group_add", [])}
    configured = all([
        HUB_BEGIN in nginx.read_text(encoding="utf-8"), routes_current == routes_expected, registry_secure,
        wildcard_certificate_valid(args), renewal_configured(args),
        CERTBOT_IMAGE in renewal_script_path(args).read_text(encoding="utf-8") if renewal_script_path(args).is_file() else False,
        expected_destinations.issubset(destinations), directories_secure, worker_group, group_add, monitoring_configured(args),
        admin_configured(args, group_id),
        edge.run(["docker", "exec", args.nginx_container, "nginx", "-t"], check=False).returncode == 0,
    ])
    instances = [socket_status(args, item["id"], group_id) for item in registry["instances"]]
    refresh_admin_status(args, instances)
    alarm_active = (Path(args.state_dir) / "health-alarm").is_file()
    ready = configured and bool(instances) and all(item["ready"] for item in instances) and not alarm_active
    return {"status": "ready" if ready else "configured" if configured else "incomplete", "configured": configured, "ready": ready, "alarm_active": alarm_active, "base_domain": args.base_domain, "generation": registry["generation"], "certbot_image": CERTBOT_IMAGE, "registry_sha256": edge.sha256(registry_file) if registry_file.is_file() else None, "routes_sha256": edge.sha256(routes) if routes.is_file() else None, "instances": instances}


def acknowledge_alert(args: argparse.Namespace) -> dict[str, Any]:
    with hub_lock(args):
        recover_pending_transactions(args)
        status = _hub_status_locked(args)
        if not status["configured"] or not status["instances"] or not all(item["state"] == "online" for item in status["instances"]):
            raise HubError("Cannot acknowledge an alert until the Hub and every registered instance are healthy")
        (Path(args.state_dir) / "health-alarm").unlink(missing_ok=True)
        edge.run(["systemctl", "reset-failed", Path(args.health_service).name], check=False)
        return {"status": "acknowledged", "alarm_active": False}


def renewal_check(args: argparse.Namespace) -> dict[str, Any]:
    script = renewal_script_path(args)
    if not renewal_configured(args):
        raise HubError("Hub wildcard renewal is not configured")
    edge.run([str(script), "--dry-run"], capture=False)
    if not wildcard_certificate_valid(args):
        raise HubError("Wildcard certificate failed SAN or validity verification")
    return {"status": "passed", "base_domain": args.base_domain, "certificate_valid": True}


def rollback(args: argparse.Namespace) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9TZ-]+", args.receipt):
        raise HubError("Invalid receipt id")
    with hub_lock(args):
        recover_pending_transactions(args)
        directory = Path(args.state_dir) / "backups" / args.receipt
        receipt_path = directory / "receipt.json"
        if not receipt_path.is_file():
            raise HubError("Hub rollback receipt not found")
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if receipt.get("schema") != RECEIPT_SCHEMA:
            raise HubError("Hub rollback requires a v2 exact-state receipt")
        if receipt.get("rolled_back"):
            return {"status": "already-rolled-back", "receipt": str(receipt_path), "receipt_sha256": edge.sha256(receipt_path)}
        if any((Path(args.socket_host_dir) / "instances").glob("*.sock")):
            raise HubError("Stop all registered Hub tunnels before rollback")
        post = receipt.get("post") or {}
        if post and (edge.sha256(Path(args.nginx_config)) != post.get("nginx_sha256") or edge.sha256(Path(args.compose_file)) != post.get("compose_sha256")):
            raise HubError("Hub rollback chain mismatch; roll back newest receipt first")
        edge.run(["systemctl", "disable", "--now", Path(args.health_timer).name], check=False)
        restore(args, directory, receipt, automatic=False)
        return {"status": "rolled-back", "receipt": str(receipt_path), "receipt_sha256": edge.sha256(receipt_path), "rollback_result": receipt.get("rollback_result")}


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("action", choices=("hub-preflight", "hub-apply", "hub-status", "hub-renewal-check", "hub-rollback", "hub-acknowledge-alert", "hub-admin-init", "hub-admin-rotate", "instance-add", "instance-remove", "instance-status", "instance-rollback"))
    value.add_argument("--instance-id", default="")
    value.add_argument("--base-domain", default="dsh.onlyservice.io")
    value.add_argument("--expected-ipv4", default="43.167.173.46")
    value.add_argument("--nginx-config", default="/home/chriswang/docker/nginx/nginx.conf")
    value.add_argument("--compose-file", default="/home/chriswang/docker/nginx/docker-compose.yml")
    value.add_argument("--nginx-container", default="nginx-sub2api")
    value.add_argument("--hub-site-dir", default="/home/chriswang/docker/nginx/sites/dsh-remote-hub")
    value.add_argument("--certbot-config", default="/home/chriswang/docker/certbot/conf")
    value.add_argument("--socket-host-dir", default="/home/chriswang/.local/share/dsh-remote")
    value.add_argument("--socket-group", default="dsh-remote")
    value.add_argument("--state-dir", default="/home/chriswang/.local/state/dsh-remote-hub")
    value.add_argument("--renewal-cron", default="/etc/cron.d/dsh-remote-hub-cert-renew")
    value.add_argument("--health-service", default="/etc/systemd/system/dsh-remote-hub-health.service")
    value.add_argument("--health-timer", default="/etc/systemd/system/dsh-remote-hub-health.timer")
    value.add_argument("--alert-service", default="/etc/systemd/system/dsh-remote-hub-alert.service")
    value.add_argument("--logrotate-config", default="/etc/logrotate.d/dsh-remote-hub")
    value.add_argument("--cloudflare-credentials", default="/root/.secrets/dsh-remote-hub-cloudflare.ini")
    value.add_argument("--ssh-uid", type=int, default=1002)
    value.add_argument("--offline-template", required=True)
    value.add_argument("--group-init-template", required=True)
    value.add_argument("--receipt", default="")
    value.add_argument("--force", action="store_true")
    value.add_argument("--password-stdin", action="store_true")
    return value


def main() -> int:
    args = parser().parse_args()
    try:
        validate_inputs(args)
        if args.action.startswith("instance-") and args.action != "instance-rollback" and not args.instance_id:
            raise HubError("Instance action requires --instance-id")
        if args.action == "hub-preflight":
            result = preflight(args)
        elif args.action == "hub-apply":
            result = hub_apply(args)
        elif args.action == "hub-status":
            result = hub_status(args)
        elif args.action == "hub-renewal-check":
            result = renewal_check(args)
        elif args.action == "hub-rollback":
            result = rollback(args)
        elif args.action == "hub-acknowledge-alert":
            result = acknowledge_alert(args)
        elif args.action == "hub-admin-init":
            result = admin_configure(args, rotate=False)
        elif args.action == "hub-admin-rotate":
            result = admin_configure(args, rotate=True)
        elif args.action == "instance-add":
            result = instance_add(args)
        elif args.action == "instance-remove":
            result = instance_remove(args)
        elif args.action == "instance-rollback":
            result = transaction_rollback(args)
        else:
            result = hub_status(args) if not args.instance_id else next((item for item in hub_status(args)["instances"] if item["id"] == args.instance_id), {"id": args.instance_id, "status": "not-registered"})
        print(json.dumps(result, sort_keys=True))
        return 0
    except (HubError, OSError, ValueError) as error:
        print(json.dumps({"status": "error", "message": str(error)}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
