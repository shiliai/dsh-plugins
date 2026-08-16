from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest


ROOT = Path(__file__).resolve().parents[2]
if "yaml" not in sys.modules:
    sys.modules["yaml"] = types.ModuleType("yaml")
SPEC = importlib.util.spec_from_file_location("remote_edge_nginx", ROOT / "scripts" / "remote-edge.py")
assert SPEC and SPEC.loader
remote_edge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote_edge)


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


if __name__ == "__main__":
    unittest.main()
