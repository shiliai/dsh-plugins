from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
if "yaml" not in sys.modules:
    sys.modules["yaml"] = types.ModuleType("yaml")
SPEC = importlib.util.spec_from_file_location("remote_edge", ROOT / "scripts" / "remote-edge.py")
assert SPEC and SPEC.loader
remote_edge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote_edge)


class RemoteEdgeTests(unittest.TestCase):
    def test_replace_managed_is_idempotent_and_preserves_unrelated_sites(self) -> None:
        original = "server { server_name existing.example; }\n"
        managed = f"{remote_edge.BEGIN}\nserver {{ server_name zsh.example; }}\n{remote_edge.END}\n"
        first = remote_edge.replace_managed(original, managed)
        second = remote_edge.replace_managed(first, managed)
        self.assertEqual(first, second)
        self.assertIn("existing.example", second)
        self.assertEqual(second.count(remote_edge.BEGIN), 1)

    def test_replace_managed_rejects_incomplete_markers(self) -> None:
        with self.assertRaises(remote_edge.EdgeError):
            remote_edge.replace_managed(f"x\n{remote_edge.BEGIN}\n", "managed")

    def test_compose_update_preserves_services_and_deduplicates_mounts(self) -> None:
        value = {
            "services": {
                "nginx": {"image": "nginx:alpine", "volumes": ["./nginx.conf:/etc/nginx/conf.d/default.conf:ro"]},
                "other": {"image": "example:latest"},
            }
        }
        updated = remote_edge.update_compose(
            value, "/srv/socket", 991, "/srv/offline.html", "/srv/nginx-socket-group.sh"
        )
        updated = remote_edge.update_compose(
            updated, "/srv/socket", 991, "/srv/offline.html", "/srv/nginx-socket-group.sh"
        )
        nginx = updated["services"]["nginx"]
        self.assertIn("other", updated["services"])
        self.assertEqual(nginx["volumes"].count("/srv/socket:/run/dsh-remote:ro"), 1)
        self.assertEqual(nginx["volumes"].count(
            "/srv/nginx-socket-group.sh:/docker-entrypoint.d/05-dsh-remote-socket-group.sh:ro"
        ), 1)
        self.assertEqual(nginx["group_add"], ["991"])

    def test_group_initializer_adds_nginx_to_the_mounted_socket_gid(self) -> None:
        script = (ROOT / "templates" / "nginx-socket-group.sh").read_text(encoding="utf-8")
        self.assertIn('group_id=$(stat -c %g "$socket_dir")', script)
        self.assertIn('addgroup nginx "$group_name"', script)
        self.assertNotIn("chmod", script)

    def test_rendered_https_site_has_socket_upgrade_offline_and_no_access_log(self) -> None:
        args = types.SimpleNamespace(
            domain="zsh.onlyservice.io",
            socket_container_path="/run/dsh-remote/tunnel.sock",
        )
        template = (ROOT / "templates" / "nginx-site.conf").read_text(encoding="utf-8")
        rendered = remote_edge.render_site(template, args, https=True)
        self.assertIn("server unix:/run/dsh-remote/tunnel.sock", rendered)
        self.assertIn("proxy_set_header Upgrade $http_upgrade", rendered)
        self.assertIn("access_log off", rendered)
        self.assertIn("proxy_request_buffering off", rendered)
        self.assertIn("server 127.0.0.1:18081 backup", rendered)
        self.assertIn("proxy_next_upstream error timeout invalid_header", rendered)
        self.assertIn("proxy_next_upstream_tries 2", rendered)
        self.assertIn("listen 127.0.0.1:18081", rendered)
        self.assertIn("error_page 503 =503 @dsh_remote_offline", rendered)
        self.assertNotIn("proxy_intercept_errors", rendered)
        self.assertNotIn("__DOMAIN__", rendered)

    def test_atomic_write_replaces_content_and_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "value"
            remote_edge.atomic_write(path, "first", 0o600)
            remote_edge.atomic_write(path, "second", 0o640)
            self.assertEqual(path.read_text(encoding="utf-8"), "second")
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)

    def test_restore_refuses_to_mutate_any_receipt_while_socket_directory_is_in_use(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            socket_dir = root / "socket"
            socket_dir.mkdir()
            (socket_dir / "tunnel.sock").write_text("fixture", encoding="utf-8")
            nginx = root / "nginx.conf"
            compose = root / "compose.yml"
            nginx.write_text("live-nginx", encoding="utf-8")
            compose.write_text("live-compose", encoding="utf-8")
            backup = root / "backup"
            backup.mkdir()
            (backup / "nginx.conf").write_text("old-nginx", encoding="utf-8")
            (backup / "docker-compose.yml").write_text("old-compose", encoding="utf-8")
            args = types.SimpleNamespace(socket_host_dir=str(socket_dir))
            for group_created in (True, False):
                before = (remote_edge.sha256(nginx), remote_edge.sha256(compose))
                with self.assertRaisesRegex(remote_edge.EdgeError, "Stop the DSH remote tunnel"):
                    remote_edge.restore_from(args, backup, {
                        "group_created": group_created,
                        "paths": {"nginx": str(nginx), "compose": str(compose)},
                    }, automatic=False)
                self.assertEqual((remote_edge.sha256(nginx), remote_edge.sha256(compose)), before)

    def test_renewal_render_and_managed_file_restore_are_exact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            site = root / "site"
            cron = root / "cron"
            template = ROOT / "templates" / "renew-certificate.sh"
            args = types.SimpleNamespace(
                domain="zsh.onlyservice.io",
                certbot_config="/srv/certbot/conf",
                certbot_webroot="/srv/certbot/www",
                nginx_container="nginx-fixture",
                nginx_site_dir=str(site),
                renewal_cron=str(cron),
                renewal_template=str(template),
                state_dir=str(root / "state"),
            )
            remote_edge.install_renewal(args)
            first = tuple(remote_edge.sha256(path) for path in remote_edge.renewal_paths(args).values())
            remote_edge.install_renewal(args)
            self.assertEqual(tuple(remote_edge.sha256(path) for path in remote_edge.renewal_paths(args).values()), first)
            self.assertTrue(remote_edge.renewal_configured(args))
            remote_edge.atomic_write(cron, "tampered", 0o644)
            self.assertFalse(remote_edge.renewal_configured(args))
            remote_edge.install_renewal(args)
            nginx = root / "nginx.conf"
            compose = root / "compose.yml"
            nginx.write_text("nginx-before", encoding="utf-8")
            compose.write_text("compose-before", encoding="utf-8")
            backup_dir, receipt = remote_edge.backup(args, nginx, compose)
            remote_edge.atomic_write(site / "renew-certificate.sh", "changed", 0o700)
            remote_edge.atomic_write(cron, "changed", 0o644)
            remote_edge.restore_managed_files(backup_dir, receipt)
            self.assertTrue(remote_edge.renewal_configured(args))

    def test_secure_path_requires_exact_owner_group_mode_and_socket_type(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "socket"
            root.mkdir()
            os.chmod(root, 0o2770)
            endpoint = root / "tunnel.sock"
            listener = socket.socket(socket.AF_UNIX)
            try:
                listener.bind(str(endpoint))
                os.chmod(endpoint, 0o660)
                self.assertTrue(remote_edge.secure_path(root, mode=0o2770, uid=os.getuid(), gid=os.getgid()))
                self.assertTrue(remote_edge.secure_path(endpoint, mode=0o660, uid=os.getuid(), gid=os.getgid(), socket_required=True))
                os.chmod(endpoint, 0o600)
                self.assertFalse(remote_edge.secure_path(endpoint, mode=0o660, uid=os.getuid(), gid=os.getgid(), socket_required=True))
            finally:
                listener.close()
            endpoint.unlink()
            endpoint.write_text("stale", encoding="utf-8")
            os.chmod(endpoint, 0o660)
            self.assertFalse(remote_edge.secure_path(
                endpoint, mode=0o660, uid=os.getuid(), gid=os.getgid(), socket_required=True
            ))

    def test_certificate_and_gateway_probes_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            certificate = Path(directory) / "live" / "zsh.onlyservice.io" / "fullchain.pem"
            certificate.parent.mkdir(parents=True)
            certificate.write_text("fixture", encoding="utf-8")
            args = types.SimpleNamespace(
                certbot_config=directory,
                domain="zsh.onlyservice.io",
            )
            with patch.object(remote_edge, "run", return_value=types.SimpleNamespace(returncode=0)):
                self.assertTrue(remote_edge.certificate_valid(args))
                self.assertTrue(remote_edge.gateway_probe(args))
            with patch.object(remote_edge, "run", return_value=types.SimpleNamespace(returncode=1)):
                self.assertFalse(remote_edge.certificate_valid(args))
                self.assertFalse(remote_edge.gateway_probe(args))

    def test_final_config_recreates_bind_mount_before_live_validation(self) -> None:
        calls: list[str] = []
        with patch.object(remote_edge, "compose_validate", side_effect=lambda _path: calls.append("compose")), \
             patch.object(remote_edge, "compose_recreate", side_effect=lambda _path: calls.append("recreate")), \
             patch.object(remote_edge, "nginx_validate", side_effect=lambda _container: calls.append("nginx")), \
             patch.object(remote_edge, "nginx_worker_group_validate", side_effect=lambda _container, _gid: calls.append("group")):
            remote_edge.activate_bound_config(Path("/fixture/compose.yml"), "nginx-fixture", 991)
        self.assertEqual(calls, ["compose", "recreate", "nginx", "group"])


if __name__ == "__main__":
    unittest.main()
