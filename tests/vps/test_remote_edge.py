from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest


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
        updated = remote_edge.update_compose(value, "/srv/socket", 991, "/srv/offline.html")
        updated = remote_edge.update_compose(updated, "/srv/socket", 991, "/srv/offline.html")
        nginx = updated["services"]["nginx"]
        self.assertIn("other", updated["services"])
        self.assertEqual(nginx["volumes"].count("/srv/socket:/run/dsh-remote:ro"), 1)
        self.assertEqual(nginx["group_add"], ["991"])

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
        self.assertIn("error_page 502 503 504 =503 @dsh_remote_offline", rendered)
        self.assertNotIn("__DOMAIN__", rendered)

    def test_atomic_write_replaces_content_and_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "value"
            remote_edge.atomic_write(path, "first", 0o600)
            remote_edge.atomic_write(path, "second", 0o640)
            self.assertEqual(path.read_text(encoding="utf-8"), "second")
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)

    def test_restore_refuses_to_mutate_while_tunnel_socket_directory_is_in_use(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            socket_dir = Path(directory) / "socket"
            socket_dir.mkdir()
            (socket_dir / "tunnel.sock").write_text("fixture", encoding="utf-8")
            args = types.SimpleNamespace(socket_host_dir=str(socket_dir))
            with self.assertRaisesRegex(remote_edge.EdgeError, "Stop the DSH remote tunnel"):
                remote_edge.restore_from(args, Path(directory), {"group_created": True}, automatic=False)


if __name__ == "__main__":
    unittest.main()
