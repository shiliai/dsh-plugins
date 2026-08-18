from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "scripts" / "install-dsh-remote-instance.sh"


class InstanceInstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.bin = self.root / "bin"
        self.home.mkdir()
        self.bin.mkdir()
        self.linger = self.root / "linger"
        self.linger.write_text("no\n", encoding="utf-8")
        install = self.home / ".local/share/dsh-cli"
        (install / "current/.corepack-bin").mkdir(parents=True)
        pnpm = install / "current/.corepack-bin/pnpm"
        pnpm.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        pnpm.chmod(0o755)
        dsh = self.home / ".local/bin/dsh"
        dsh.parent.mkdir(parents=True)
        dsh.write_text('#!/bin/sh\n[ "${FAIL_DSH_PLUGIN:-}" != 1 ]\n', encoding="utf-8")
        dsh.chmod(0o755)
        profile = self.home / ".local/dsh_home/profiles/web"
        profile.mkdir(parents=True)
        for name in ("package.json", "pnpm-lock.yaml", "cordis.patch.yml"):
            (profile / name).write_text(f"{name}-pre\n", encoding="utf-8")
        self.package = self.root / "package.tgz"
        self.package.write_bytes(b"package-fixture")
        self.write_command("systemctl", '#!/bin/sh\ncase "$*" in *is-active*|*is-enabled*) exit 1;; *) exit 0;; esac\n')
        self.write_command(
            "loginctl",
            '#!/bin/sh\ncase "$1" in show-user) cat "$LINGER_STATE";; enable-linger) printf "yes\\n" > "$LINGER_STATE";; disable-linger) printf "no\\n" > "$LINGER_STATE";; *) exit 1;; esac\n',
        )
        self.write_command("sudo", '#!/bin/sh\n[ "$1" != -n ] || shift\nexec "$@"\n')
        self.write_command("curl", '#!/bin/sh\nprintf 200\n')
        self.env = {**os.environ, "HOME": str(self.home), "USER": "fixture", "PATH": f"{self.bin}:{os.environ['PATH']}", "LINGER_STATE": str(self.linger)}

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_command(self, name: str, source: str) -> None:
        path = self.bin / name
        path.write_text(source, encoding="utf-8")
        path.chmod(0o755)

    def invoke(self, *extra: str, fail_plugin: bool = False) -> subprocess.CompletedProcess[str]:
        env = dict(self.env)
        if fail_plugin:
            env["FAIL_DSH_PLUGIN"] = "1"
        return subprocess.run(
            ["sh", str(INSTALLER), str(self.package), "x570", "dsh.onlyservice.io", "vps-tencent-tokyo", *extra],
            env=env, text=True, capture_output=True, check=False,
        )

    def test_missing_linger_fails_before_unit_activation(self) -> None:
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("lingering is required", result.stderr)
        self.assertFalse((self.home / ".config/systemd/user/dsh-remote-x570.service").exists())
        self.assertEqual(self.linger.read_text(encoding="utf-8"), "no\n")

    def test_authorized_linger_is_verified_and_recorded(self) -> None:
        result = self.invoke("--enable-linger")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.linger.read_text(encoding="utf-8"), "yes\n")
        receipts = list((self.home / ".local/state/dsh-remote/instance-installs").glob("*/receipt.env"))
        self.assertEqual(len(receipts), 1)
        self.assertIn("linger_enabled_by_installer=true", receipts[0].read_text(encoding="utf-8"))
        unit = (self.home / ".config/systemd/user/dsh-remote-x570.service").read_text(encoding="utf-8")
        self.assertIn(f"EnvironmentFile=-{self.home}/.config/dsh-remote/x570.env", unit)
        self.assertEqual((self.home / ".config/dsh-remote").stat().st_mode & 0o777, 0o700)
        self.assertFalse((self.home / ".config/dsh-remote/x570.env").exists())

    def test_failure_after_linger_enable_restores_disabled_prestate(self) -> None:
        result = self.invoke("--enable-linger", fail_plugin=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.linger.read_text(encoding="utf-8"), "no\n")
        self.assertFalse((self.home / ".config/systemd/user/dsh-remote-x570.service").exists())


if __name__ == "__main__":
    unittest.main()
