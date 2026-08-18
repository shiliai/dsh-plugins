from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import types
import unittest


ROOT = Path(__file__).resolve().parents[2]
if "yaml" not in sys.modules:
    sys.modules["yaml"] = types.ModuleType("yaml")
SPEC = importlib.util.spec_from_file_location("remote_edge_nginx", ROOT / "scripts" / "remote-edge.py")
assert SPEC and SPEC.loader
remote_edge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote_edge)
HUB_SPEC = importlib.util.spec_from_file_location("remote_hub_nginx", ROOT / "scripts" / "remote-hub.py")
assert HUB_SPEC and HUB_SPEC.loader
remote_hub = importlib.util.module_from_spec(HUB_SPEC)
HUB_SPEC.loader.exec_module(remote_hub)


def nginx_image_available() -> bool:
    if not shutil.which("docker"):
        return False
    return subprocess.run(
        ["docker", "image", "inspect", "nginx:alpine"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


@unittest.skipUnless(nginx_image_available(), "A local nginx:alpine image is required for the syntax canary")
class NginxContainerTests(unittest.TestCase):
    def test_http_stage_is_accepted_by_production_nginx_image(self) -> None:
        args = types.SimpleNamespace(
            domain="zsh.onlyservice.io",
            socket_container_path="/run/dsh-remote/tunnel.sock",
        )
        template = (ROOT / "templates" / "nginx-site.conf").read_text(encoding="utf-8")
        rendered = remote_edge.render_site(template, args, https=False)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "default.conf"
            config.write_text(rendered, encoding="utf-8")
            result = subprocess.run([
                "docker", "run", "--rm",
                "-v", f"{config}:/etc/nginx/conf.d/default.conf:ro",
                "nginx:alpine", "nginx", "-t",
            ], text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_multi_instance_http_stage_is_accepted_by_production_nginx_image(self) -> None:
        rendered = remote_hub.render_routes(
            "dsh.onlyservice.io", [{"id": "build-01"}, {"id": "x570"}], https=False
        )
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "default.conf"
            config.write_text(rendered, encoding="utf-8")
            result = subprocess.run([
                "docker", "run", "--rm",
                "-v", f"{config}:/etc/nginx/conf.d/default.conf:ro",
                "nginx:alpine", "nginx", "-t",
            ], text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_hidden_admin_https_routes_are_accepted_by_production_nginx_image(self) -> None:
        path = "/" + "A" * 43
        rendered = remote_hub.render_routes("dsh.onlyservice.io", [], https=True, admin_path=path)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "default.conf"
            certificate = root / "live" / "dsh.onlyservice.io"
            certificate.mkdir(parents=True)
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-subj", "/CN=dsh.onlyservice.io", "-keyout", str(certificate / "privkey.pem"),
                "-out", str(certificate / "fullchain.pem"),
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            config.write_text(rendered, encoding="utf-8")
            result = subprocess.run([
                "docker", "run", "--rm",
                "-v", f"{config}:/etc/nginx/conf.d/default.conf:ro",
                "-v", f"{root}:/etc/letsencrypt:ro",
                "nginx:alpine", "nginx", "-t",
            ], text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_hidden_admin_isolated_from_wildcard_hosts(self) -> None:
        path = "/" + "A" * 43
        rendered = remote_hub.render_routes("dsh.onlyservice.io", [], https=True, admin_path=path)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "default.conf"
            certificate = root / "live" / "dsh.onlyservice.io"
            admin = root / "admin"
            certificate.mkdir(parents=True)
            admin.mkdir()
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-subj", "/CN=dsh.onlyservice.io", "-keyout", str(certificate / "privkey.pem"),
                "-out", str(certificate / "fullchain.pem"),
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            password = "correct-horse-battery"
            digest = subprocess.run(["openssl", "passwd", "-6", "-stdin"], input=password + "\n", text=True, capture_output=True, check=True).stdout.strip()
            (admin / "users.htpasswd").write_text(f"dsh-admin:{digest}\n", encoding="utf-8")
            (admin / "index.html").write_text("admin", encoding="utf-8")
            (admin / "status.json").write_text("{}", encoding="utf-8")
            config.write_text(rendered, encoding="utf-8")
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            container = subprocess.run([
                "docker", "run", "-d", "--rm", "-p", f"127.0.0.1:{port}:443",
                "-v", f"{config}:/etc/nginx/conf.d/default.conf:ro",
                "-v", f"{root}:/etc/letsencrypt:ro",
                "-v", f"{admin}:/etc/nginx/dsh-remote-hub/admin:ro",
                "nginx:alpine",
            ], text=True, capture_output=True, check=True).stdout.strip()
            try:
                def request(host: str, request_path: str, *, method: str = "GET", credentials: bool = False) -> tuple[str, str]:
                    command = ["curl", "--silent", "--show-error", "--insecure", "--dump-header", "-", "--output", "/dev/null",
                               "--write-out", "%{http_code}", "--request", method]
                    if credentials:
                        command.extend(["--user", f"dsh-admin:{password}"])
                    command.extend(["--resolve", f"{host}:{port}:127.0.0.1", f"https://{host}:{port}{request_path}"])
                    for _ in range(10):
                        result = subprocess.run(command, text=True, capture_output=True, check=False)
                        if result.returncode == 0:
                            break
                        time.sleep(0.1)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    return result.stdout[-3:], result.stdout[:-3].lower()
                base_status, base_headers = request("dsh.onlyservice.io", path)
                authenticated_status, authenticated_headers = request("dsh.onlyservice.io", path, credentials=True)
                status_status, status_headers = request("dsh.onlyservice.io", path + "/status", credentials=True)
                wildcard_status, wildcard_headers = request("unknown.dsh.onlyservice.io", path)
                common_status, common_headers = request("dsh.onlyservice.io", "/admin")
                unauthenticated_post, unauthenticated_post_headers = request("dsh.onlyservice.io", path, method="POST")
                authenticated_post, authenticated_post_headers = request("dsh.onlyservice.io", path, method="POST", credentials=True)
                self.assertEqual(base_status, "401")
                self.assertIn("www-authenticate", base_headers)
                self.assertEqual(authenticated_status, "200")
                self.assertNotIn("www-authenticate", authenticated_headers)
                self.assertEqual(status_status, "200")
                self.assertNotIn("www-authenticate", status_headers)
                self.assertEqual(wildcard_status, "404")
                self.assertNotIn("www-authenticate", wildcard_headers)
                self.assertEqual(common_status, "404")
                self.assertNotIn("www-authenticate", common_headers)
                self.assertEqual(unauthenticated_post, "401")
                self.assertIn("www-authenticate", unauthenticated_post_headers)
                self.assertEqual(authenticated_post, "405")
                self.assertNotIn("www-authenticate", authenticated_post_headers)
            finally:
                subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


if __name__ == "__main__":
    unittest.main()
