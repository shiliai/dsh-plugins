from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "scripts" / "install-dsh-node.sh"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class NodeInstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.repo = self.root / "source"
        self.bin = self.root / "bin"
        self.home.mkdir()
        self.repo.mkdir()
        self.bin.mkdir()
        (self.repo / "apps/cli/lib").mkdir(parents=True)
        (self.repo / "apps/cli/lib/bin.js").write_text(
            "if (process.argv.includes('--version')) console.log('0.1.0-rc.6')\n",
            encoding="utf-8",
        )
        (self.repo / "package.json").write_text('{"scripts":{"build":"true"}}\n', encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(
            ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture", "commit", "-qm", "fixture"],
            cwd=self.repo,
            check=True,
        )
        self.commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True).strip()
        corepack = self.bin / "corepack"
        corepack.write_text(
            "#!/bin/sh\nset -eu\nwhile [ $# -gt 0 ]; do if [ \"$1\" = --install-directory ]; then dir=$2; break; fi; shift; done\n"
            "printf '#!/bin/sh\\nexit 0\\n' > \"$dir/pnpm\"\nchmod 755 \"$dir/pnpm\"\n",
            encoding="utf-8",
        )
        corepack.chmod(0o755)
        self.settings = self.root / "settings.yaml"
        self.credentials = self.root / "credentials.yaml"
        self.settings.write_text("models: first\n", encoding="utf-8")
        self.credentials.write_text("provider: first\n", encoding="utf-8")
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "DSH_SOURCE_REPO": str(self.repo),
            "DSH_SOURCE_COMMIT": self.commit,
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_installer(self, *args: str, fail_at: str | None = None) -> subprocess.CompletedProcess[str]:
        env = dict(self.env)
        if fail_at is not None:
            env["DSH_INSTALL_FAIL_AT"] = fail_at
        return subprocess.run(["sh", str(INSTALLER), *args], env=env, text=True, capture_output=True, check=False)

    def install(self) -> subprocess.CompletedProcess[str]:
        return self.run_installer(str(self.settings), str(self.credentials))

    def snapshot(self) -> tuple[str, str, str, str]:
        install = self.home / ".local/share/dsh-cli"
        dsh_home = self.home / ".local/dsh_home"
        return (
            os.readlink(install / "current"),
            os.readlink(install / "configs/current"),
            digest(dsh_home / "settings.yaml"),
            digest(dsh_home / ".credentials.yaml"),
        )

    def assert_private_regular_configuration(self) -> None:
        dsh_home = self.home / ".local/dsh_home"
        for name in ("settings.yaml", ".credentials.yaml"):
            path = dsh_home / name
            self.assertTrue(path.is_file())
            self.assertFalse(path.is_symlink())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_failures_after_each_activation_phase_restore_the_exact_prior_state(self) -> None:
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assert_private_regular_configuration()
        baseline = self.snapshot()
        sessions = self.home / ".local/dsh_home/storages/session.fixture"
        sessions.parent.mkdir(parents=True)
        sessions.write_text("preserve-me\n", encoding="utf-8")
        for phase in ("after-config-stage", "after-pointer-switch", "after-validation"):
            self.settings.write_text(f"models: {phase}\n", encoding="utf-8")
            result = self.install() if phase == "never" else self.run_installer(str(self.settings), str(self.credentials), fail_at=phase)
            self.assertNotEqual(result.returncode, 0, phase)
            self.assertEqual(self.snapshot(), baseline, phase)
            self.assert_private_regular_configuration()
            self.assertEqual(sessions.read_text(encoding="utf-8"), "preserve-me\n")

    def test_successful_upgrade_has_chain_guarded_explicit_rollback(self) -> None:
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        baseline = self.snapshot()
        self.settings.write_text("models: second\n", encoding="utf-8")
        second = self.install()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assert_private_regular_configuration()
        self.assertNotEqual(self.snapshot()[1:], baseline[1:])
        receipt = second.stdout.strip().split("receipt=", 1)[1]
        rollback = self.run_installer("--rollback", receipt)
        self.assertEqual(rollback.returncode, 0, rollback.stderr)
        self.assertEqual(self.snapshot(), baseline)
        self.assert_private_regular_configuration()
        repeated = self.run_installer("--rollback", receipt)
        self.assertEqual(repeated.returncode, 0, repeated.stderr)


if __name__ == "__main__":
    unittest.main()
