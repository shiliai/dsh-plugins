from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
if "yaml" not in sys.modules:
    yaml = types.ModuleType("yaml")
    yaml.safe_load = lambda _value: {}  # type: ignore[attr-defined]
    yaml.safe_dump = lambda _value, sort_keys=False: "fixture"  # type: ignore[attr-defined]
    sys.modules["yaml"] = yaml
SPEC = importlib.util.spec_from_file_location("remote_hub", ROOT / "scripts" / "remote-hub.py")
assert SPEC and SPEC.loader
remote_hub = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote_hub)


class RemoteHubTests(unittest.TestCase):
    def test_instance_ids_are_dns_labels_and_reject_ambiguous_names(self) -> None:
        for value in ("x570", "build-01", "a" * 63):
            self.assertEqual(remote_hub.validate_instance_id(value), value)
        for value in ("X570", "-x570", "x570-", "x--570", "x.570", "a" * 64):
            with self.assertRaises(remote_hub.HubError):
                remote_hub.validate_instance_id(value)

    def test_routes_are_deterministic_isolated_and_fail_closed(self) -> None:
        rendered = remote_hub.render_routes("dsh.onlyservice.io", [{"id": "x570"}, {"id": "build-01"}], https=True)
        self.assertLess(rendered.index("build-01.dsh.onlyservice.io"), rendered.index("x570.dsh.onlyservice.io"))
        self.assertIn("unix:/run/dsh-remote/instances/x570.sock", rendered)
        self.assertIn("unix:/run/dsh-remote/instances/build-01.sock", rendered)
        self.assertIn("server_name dsh.onlyservice.io *.dsh.onlyservice.io", rendered)
        self.assertIn("return 404", rendered)
        self.assertIn("server 127.0.0.1:18082 backup", rendered)
        self.assertIn("try_files /dsh-remote-hub-offline.html =503", rendered)
        self.assertIn("proxy_set_header Upgrade $http_upgrade", rendered)
        self.assertIn("'' ''", rendered)

    def test_hidden_admin_routes_are_exact_authenticated_and_rate_limited(self) -> None:
        path = "/" + "A" * 43
        rendered = remote_hub.render_routes("dsh.onlyservice.io", [{"id": "x570"}], https=True, admin_path=path)
        self.assertIn(f"location = {path} {{", rendered)
        self.assertIn(f"location = {path}/status {{", rendered)
        self.assertEqual(rendered.count("auth_basic_user_file /etc/nginx/dsh-remote-hub/admin/users.htpasswd;"), 2)
        self.assertEqual(rendered.count("limit_req zone=dsh_hub_admin burst=5 nodelay;"), 2)
        self.assertIn("limit_req_zone $binary_remote_addr zone=dsh_hub_admin:10m rate=5r/m;", rendered)
        self.assertIn("server_name dsh.onlyservice.io;", rendered)
        self.assertIn("server_name *.dsh.onlyservice.io;", rendered)
        self.assertIn("    return 404;", rendered)
        self.assertNotIn(f"location {path}/", rendered)
        self.assertIn('add_header Cache-Control "no-store" always;', rendered)
        self.assertNotIn("$request_method", rendered)
        self.assertIn("location.pathname.replace(/\\/$/,'')", remote_hub.render_admin_page())

    def test_admin_routes_are_not_present_on_wildcard_server(self) -> None:
        path = "/" + "A" * 43
        rendered = remote_hub.render_routes("dsh.onlyservice.io", [], https=True, admin_path=path)
        wildcard = rendered[rendered.index("server_name *.dsh.onlyservice.io;"):]
        self.assertNotIn(path, wildcard)
        self.assertNotIn("auth_basic", wildcard)

    def test_admin_files_are_private_and_status_projection_does_not_leak_topology(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = types.SimpleNamespace(state_dir=str(root / "state"), hub_site_dir=str(root / "site"), base_domain="dsh.onlyservice.io", socket_group="dsh-remote")
            Path(args.state_dir).mkdir()
            remote_hub.edge.atomic_write(remote_hub.admin_config_path(args), json.dumps({"schema": 1, "path": "/" + "A" * 43}) + "\n", 0o600)
            remote_hub.edge.atomic_write(remote_hub.admin_auth_path(args), "dsh-admin:$6$salt$hash\n", 0o640)
            with patch.object(remote_hub, "set_admin_permissions"):
                remote_hub.install_admin_files(args)
                remote_hub.refresh_admin_status(args, [{"id": "x570", "state": "online", "origin": "https://x570.dsh.onlyservice.io", "protected_route_status": "401"}])
            self.assertEqual(remote_hub.admin_config_path(args).stat().st_mode & 0o777, 0o600)
            self.assertEqual(remote_hub.admin_auth_path(args).stat().st_mode & 0o777, 0o640)
            self.assertEqual(remote_hub.admin_status_path(args).stat().st_mode & 0o777, 0o640)
            projection = remote_hub.admin_status_path(args).read_text(encoding="utf-8")
            self.assertEqual(json.loads(projection), {"instances": [{"id": "x570", "state": "online"}]})
            self.assertNotIn("origin", projection)
            self.assertNotIn("401", projection)

    def test_admin_initialization_uses_random_path_and_never_persists_the_password(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = types.SimpleNamespace(state_dir=str(root / "state"), hub_site_dir=str(root / "site"), base_domain="dsh.onlyservice.io", socket_group="dsh-remote", password_stdin=True)
            with patch.object(remote_hub, "read_admin_password", return_value="not-in-any-file"), \
                 patch.object(remote_hub, "password_hash", return_value="$6$salt$hash"), \
                 patch.object(remote_hub, "set_admin_permissions"):
                result = remote_hub.admin_configure(args, rotate=False)
            self.assertEqual(result["status"], "initialized")
            self.assertRegex(result["admin_path"], r"^/[A-Za-z0-9_-]{43}$")
            self.assertNotIn("not-in-any-file", remote_hub.admin_config_path(args).read_text(encoding="utf-8"))
            self.assertNotIn("not-in-any-file", remote_hub.admin_auth_path(args).read_text(encoding="utf-8"))
            self.assertIn("$6$salt$hash", remote_hub.admin_auth_path(args).read_text(encoding="utf-8"))

    def test_admin_initialization_refuses_to_replace_an_existing_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = types.SimpleNamespace(state_dir=str(root / "state"), hub_site_dir=str(root / "site"), base_domain="dsh.onlyservice.io", socket_group="dsh-remote", password_stdin=True)
            Path(args.state_dir).mkdir()
            remote_hub.edge.atomic_write(remote_hub.admin_config_path(args), json.dumps({"schema": 1, "path": "/" + "A" * 43}) + "\n", 0o600)
            with self.assertRaisesRegex(remote_hub.HubError, "admin-rotate"):
                remote_hub.admin_configure(args, rotate=False)

    def test_admin_rotation_restores_config_auth_route_and_status_after_validation_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = types.SimpleNamespace(state_dir=str(root / "state"), hub_site_dir=str(root / "site"), base_domain="dsh.onlyservice.io", socket_group="dsh-remote", nginx_container="nginx-fixture", ssh_uid=os.getuid(), password_stdin=True)
            Path(args.state_dir).mkdir()
            secret = "/" + "A" * 43
            remote_hub.edge.atomic_write(remote_hub.admin_config_path(args), json.dumps({"schema": 1, "path": secret}) + "\n", 0o600)
            remote_hub.edge.atomic_write(remote_hub.admin_auth_path(args), "dsh-admin:$6$old$hash\n", 0o640)
            remote_hub.edge.atomic_write(remote_hub.admin_status_path(args), '{"instances":[]}\n', 0o640)
            remote_hub.edge.atomic_write(remote_hub.admin_page_path(args), "old-page\n", 0o640)
            registry = remote_hub.empty_registry(args.base_domain)
            remote_hub.edge.atomic_write(remote_hub.registry_path(args), json.dumps(registry) + "\n", 0o600)
            remote_hub.edge.atomic_write(remote_hub.routes_path(args), "old-routes\n", 0o644)
            before = {path: path.read_text(encoding="utf-8") for path in (remote_hub.admin_config_path(args), remote_hub.admin_auth_path(args), remote_hub.admin_status_path(args), remote_hub.routes_path(args))}
            with patch.object(remote_hub, "read_admin_password", return_value="not-in-any-file"), \
                 patch.object(remote_hub, "password_hash", return_value="$6$new$hash"), \
                 patch.object(remote_hub, "set_admin_permissions"), \
                 patch.object(remote_hub.edge, "nginx_validate", side_effect=[remote_hub.HubError("invalid"), None]), \
                 patch.object(remote_hub.edge, "run"):
                with self.assertRaisesRegex(remote_hub.HubError, "invalid"):
                    remote_hub.admin_configure(args, rotate=True)
            for path, value in before.items():
                self.assertEqual(path.read_text(encoding="utf-8"), value)
            transaction = next((Path(args.state_dir) / "admin-transactions").glob("*/receipt.json"))
            self.assertNotIn("not-in-any-file", transaction.read_text(encoding="utf-8"))

    def test_fresh_hub_restore_removes_admin_helpers_and_the_site_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.deployment_fixture(root)
            site = Path(args.hub_site_dir)
            shutil.rmtree(site)
            result = types.SimpleNamespace(returncode=0, stdout="dsh-remote:x:123:fixture\n")
            with patch.object(remote_hub.edge, "run", return_value=result):
                receipt_dir, receipt = remote_hub.backup(args)
            (site / "bin").mkdir(parents=True)
            (site / "bin" / "remote-hub.py").write_text("helper", encoding="utf-8")
            (site / "admin").mkdir()
            (site / "admin" / "users.htpasswd").write_text("dsh-admin:$6$hash", encoding="utf-8")
            (site / "routes").mkdir()
            (site / "routes" / "routes.conf").write_text("routes", encoding="utf-8")
            with patch.object(remote_hub.edge, "compose_validate"), \
                 patch.object(remote_hub.edge, "compose_recreate"), \
                 patch.object(remote_hub.edge, "nginx_validate"), \
                 patch.object(remote_hub.edge, "run", return_value=result):
                remote_hub.restore(args, receipt_dir, receipt, automatic=False)
            self.assertFalse(site.exists())

    def test_http_stage_does_not_reference_an_unissued_certificate(self) -> None:
        rendered = remote_hub.render_routes("dsh.onlyservice.io", [{"id": "x570"}], https=False)
        self.assertNotIn("listen 443", rendered)
        self.assertNotIn("fullchain.pem", rendered)
        self.assertIn("server_name x570.dsh.onlyservice.io", rendered)
        self.assertIn("return 503", rendered)

    def test_hub_include_is_idempotent_and_preserves_legacy_managed_block(self) -> None:
        original = "# BEGIN DSH-REMOTE MANAGED\nlegacy\n# END DSH-REMOTE MANAGED\n"
        first = remote_hub.replace_hub_include(original, "/etc/nginx/dsh-remote-hub/routes.conf")
        second = remote_hub.replace_hub_include(first, "/etc/nginx/dsh-remote-hub/routes.conf")
        self.assertEqual(first, second)
        self.assertIn("# BEGIN DSH-REMOTE MANAGED", second)
        self.assertEqual(second.count(remote_hub.HUB_BEGIN), 1)

    def test_compose_adds_one_routes_mount_and_preserves_legacy_socket_mount(self) -> None:
        args = types.SimpleNamespace(socket_host_dir="/srv/dsh-remote", hub_site_dir="/srv/dsh-hub")
        value = {"services": {"nginx": {
            "volumes": [
                "/srv/dsh-remote:/run/dsh-remote:ro",
                "/srv/legacy.html:/usr/share/nginx/html/dsh-remote-offline.html:ro",
            ],
            "group_add": ["991"],
        }, "other": {"image": "fixture"}}}
        first = remote_hub.update_compose(value, args, 991)
        second = remote_hub.update_compose(first, args, 991)
        volumes = second["services"]["nginx"]["volumes"]
        self.assertIn("other", second["services"])
        self.assertEqual(sum(entry.endswith(":/run/dsh-remote:ro") for entry in volumes), 1)
        self.assertEqual(sum(entry.endswith(":/etc/nginx/dsh-remote-hub:ro") for entry in volumes), 1)
        self.assertEqual(second["services"]["nginx"]["group_add"], ["991"])

    def test_registry_rejects_duplicates_and_sorts_instances(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            args = types.SimpleNamespace(state_dir=directory, base_domain="dsh.onlyservice.io")
            path = remote_hub.registry_path(args)
            path.write_text(json.dumps({
                "schema": 1, "base_domain": "dsh.onlyservice.io",
                "instances": [{"id": "x570"}, {"id": "build-01"}],
            }), encoding="utf-8")
            self.assertEqual([item["id"] for item in remote_hub.load_registry(args)["instances"]], ["build-01", "x570"])
            path.write_text(json.dumps({
                "schema": 1, "base_domain": "dsh.onlyservice.io",
                "instances": [{"id": "x570"}, {"id": "x570"}],
            }), encoding="utf-8")
            with self.assertRaisesRegex(remote_hub.HubError, "duplicate"):
                remote_hub.load_registry(args)

    def test_remove_refuses_a_present_socket_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            sockets = root / "sockets"
            (sockets / "instances").mkdir(parents=True)
            state.mkdir()
            (state / "instances.json").write_text(json.dumps({
                "schema": 1, "base_domain": "dsh.onlyservice.io", "instances": [{"id": "x570"}],
            }), encoding="utf-8")
            (sockets / "instances" / "x570.sock").write_text("fixture", encoding="utf-8")
            args = types.SimpleNamespace(
                state_dir=str(state), base_domain="dsh.onlyservice.io", instance_id="x570",
                socket_host_dir=str(sockets), force=False,
            )
            with self.assertRaisesRegex(remote_hub.HubError, "still live"):
                remote_hub.instance_remove(args)

    def test_remove_cleans_a_stale_unix_socket_before_transaction(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            sockets = root / "sockets"
            path = sockets / "instances" / "x570.sock"
            path.parent.mkdir(parents=True)
            state.mkdir()
            (state / "instances.json").write_text(json.dumps({
                "schema": 1, "base_domain": "dsh.onlyservice.io", "instances": [{"id": "x570"}],
            }), encoding="utf-8")
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(path))
            listener.close()
            args = types.SimpleNamespace(
                state_dir=str(state), base_domain="dsh.onlyservice.io", instance_id="x570",
                socket_host_dir=str(sockets), force=False,
            )
            with patch.object(remote_hub, "transaction", return_value={"id": "remove-x570", "post": {"generation": "0" * 64}}) as execute:
                result = remote_hub.instance_remove(args)
            self.assertEqual(result["status"], "removed")
            self.assertTrue(path.exists())
            self.assertEqual(execute.call_args.args[3], path)

    def test_certificate_command_uses_dns01_and_both_wildcard_sans(self) -> None:
        args = types.SimpleNamespace(
            certbot_config="/srv/certbot", cloudflare_credentials="/root/.secrets/cloudflare.ini",
            base_domain="dsh.onlyservice.io",
        )
        command = remote_hub.certbot_command(args, [])
        image = next(value for value in command if value.startswith("certbot/dns-cloudflare@sha256:"))
        self.assertRegex(image, r"^certbot/dns-cloudflare@sha256:[0-9a-f]{64}$")
        self.assertIn("--dns-cloudflare-credentials", command)
        self.assertIn("dsh.onlyservice.io", command)
        self.assertIn("*.dsh.onlyservice.io", command)
        with patch.object(remote_hub, "CERTBOT_IMAGE", "certbot/dns-cloudflare:latest"):
            with self.assertRaisesRegex(remote_hub.HubError, "pinned by digest"):
                remote_hub.certbot_command(args, [])

    def test_monitoring_contract_has_functional_probe_alert_delivery_and_retention(self) -> None:
        args = types.SimpleNamespace(
            state_dir="/state", hub_site_dir="/site", certbot_config="/certbot",
            base_domain="dsh.onlyservice.io", nginx_container="nginx-fixture",
            health_service="/etc/systemd/system/dsh-remote-hub-health.service",
            health_timer="/etc/systemd/system/dsh-remote-hub-health.timer",
            alert_service="/etc/systemd/system/dsh-remote-hub-alert.service",
        )
        health = remote_hub.render_health_script(args)
        alert = remote_hub.render_alert_script(args)
        units = "\n".join(value for value, _mode in remote_hub.render_health_units(args).values())
        rotation = remote_hub.render_logrotate(args)
        self.assertIn("/api/events.mux", health)
        self.assertIn('result.stdout != "401"', health)
        self.assertIn("OnFailure=dsh-remote-hub-alert.service", units)
        self.assertIn("wall -n", alert)
        self.assertIn("rotate 14", rotation)
        self.assertIn("size 1M", rotation)

    def test_preflight_canary_uses_the_compose_image_and_http_only_routes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            nginx = root / "nginx.conf"
            compose = root / "docker-compose.yml"
            certs = root / "certs"
            nginx.write_text("server { listen 80; server_name legacy.example; }\n", encoding="utf-8")
            compose.write_text("fixture", encoding="utf-8")
            certs.mkdir()
            args = types.SimpleNamespace(
                compose_file=str(compose), nginx_config=str(nginx), certbot_config=str(certs),
                base_domain="dsh.onlyservice.io", nginx_container="nginx-fixture",
            )
            registry = {"schema": 1, "base_domain": "dsh.onlyservice.io", "instances": [{"id": "x570"}]}
            observed: dict[str, object] = {}

            def inspect_canary(command: list[str], *, capture: bool) -> None:
                observed["command"] = command
                routes_mount = next(value for value in command if value.endswith(":/etc/nginx/dsh-remote-hub:ro"))
                rendered = (Path(routes_mount.split(":", 1)[0]) / "routes.conf").read_text(encoding="utf-8")
                self.assertNotIn("listen 443", rendered)
                self.assertIn("server_name x570.dsh.onlyservice.io", rendered)

            with patch.object(remote_hub.edge, "load_compose", return_value={"services": {"nginx": {"image": "nginx:alpine"}}}), \
                 patch.object(remote_hub.edge, "run", side_effect=inspect_canary):
                remote_hub.nginx_syntax_canary(args, registry)
            command = observed["command"]
            assert isinstance(command, list)
            self.assertEqual(command[:3], ["docker", "run", "--rm"])
            self.assertIn("container:nginx-fixture", command)
            self.assertIn("nginx:alpine", command)

    def test_transaction_restores_both_files_when_nginx_validation_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            routes = root / "site" / "routes"
            state.mkdir(parents=True)
            routes.mkdir(parents=True)
            registry_file = state / "instances.json"
            routes_file = routes / "routes.conf"
            registry_file.write_text('{"old":true}\n', encoding="utf-8")
            routes_file.write_text("old-routes\n", encoding="utf-8")
            args = types.SimpleNamespace(
                state_dir=str(state), hub_site_dir=str(root / "site"), base_domain="dsh.onlyservice.io",
                instance_id="x570", nginx_container="nginx-fixture",
            )
            registry = {"schema": 1, "base_domain": "dsh.onlyservice.io", "instances": [{"id": "x570"}]}
            with patch.object(remote_hub.edge, "nginx_validate", side_effect=[remote_hub.HubError("invalid"), None]), \
                 patch.object(remote_hub.edge, "run"):
                with self.assertRaisesRegex(remote_hub.HubError, "invalid"):
                    remote_hub.transaction(args, registry, "add")
            self.assertEqual(registry_file.read_text(encoding="utf-8"), '{"old":true}\n')
            self.assertEqual(routes_file.read_text(encoding="utf-8"), "old-routes\n")

    def transaction_fixture(self, root: Path, instances: list[dict[str, str]] | None = None) -> types.SimpleNamespace:
        state = root / "state"
        routes = root / "site" / "routes"
        sockets = root / "sockets" / "instances"
        state.mkdir(parents=True)
        routes.mkdir(parents=True)
        sockets.mkdir(parents=True)
        registry = {
            "schema": 1,
            "base_domain": "dsh.onlyservice.io",
            "generation": remote_hub.generation_for(instances or []),
            "instances": instances or [],
        }
        (state / "instances.json").write_text(json.dumps(registry, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        (routes / "routes.conf").write_text(
            remote_hub.render_routes("dsh.onlyservice.io", registry["instances"], https=True, generation=registry["generation"]),
            encoding="utf-8",
        )
        return types.SimpleNamespace(
            state_dir=str(state), hub_site_dir=str(root / "site"), base_domain="dsh.onlyservice.io",
            socket_host_dir=str(root / "sockets"), nginx_container="nginx-fixture", force=False,
            instance_id="", ssh_uid=os.getuid(),
        )

    def test_concurrent_adds_are_serialized_without_lost_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            args = self.transaction_fixture(Path(directory))
            errors: list[BaseException] = []

            def add(instance_id: str) -> None:
                values = dict(vars(args))
                values["instance_id"] = instance_id
                local = types.SimpleNamespace(**values)
                try:
                    remote_hub.instance_add(local)
                except BaseException as error:  # pragma: no cover - assertion reports the captured error
                    errors.append(error)

            with patch.object(remote_hub.edge, "nginx_validate"), patch.object(remote_hub.edge, "run"):
                threads = [threading.Thread(target=add, args=(name,)) for name in ("build-01", "x570")]
                for thread in threads: thread.start()
                for thread in threads: thread.join()
            self.assertEqual(errors, [])
            self.assertEqual([item["id"] for item in remote_hub.load_registry(args)["instances"]], ["build-01", "x570"])
            routes = remote_hub.routes_path(args).read_text(encoding="utf-8")
            self.assertIn(f"# generation: {remote_hub.load_registry(args)['generation']}", routes)

    def test_transaction_failure_restores_quarantined_socket_and_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.transaction_fixture(root, [{"id": "x570"}])
            args.instance_id = "x570"
            path = Path(args.socket_host_dir) / "instances" / "x570.sock"
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(path))
            listener.close()
            original_registry = remote_hub.registry_path(args).read_bytes()
            original_routes = remote_hub.routes_path(args).read_bytes()
            with patch.dict(os.environ, {"DSH_REMOTE_HUB_FAIL_AT": "transaction-routes"}), \
                 patch.object(remote_hub.edge, "nginx_validate"), patch.object(remote_hub.edge, "run"):
                with self.assertRaisesRegex(remote_hub.HubError, "Injected failure"):
                    remote_hub.instance_remove(args)
            self.assertTrue(path.is_socket())
            self.assertEqual(remote_hub.registry_path(args).read_bytes(), original_registry)
            self.assertEqual(remote_hub.routes_path(args).read_bytes(), original_routes)

    def test_completed_remove_can_be_chain_guarded_and_reversed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.transaction_fixture(root, [{"id": "x570"}])
            args.instance_id = "x570"
            path = Path(args.socket_host_dir) / "instances" / "x570.sock"
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(path))
            listener.close()
            with patch.object(remote_hub.edge, "nginx_validate"), patch.object(remote_hub.edge, "run"):
                removed = remote_hub.instance_remove(args)
                self.assertFalse(path.exists())
                args.receipt = removed["transaction"]
                reversed_result = remote_hub.transaction_rollback(args)
            self.assertEqual(reversed_result["status"], "reversed")
            self.assertTrue(path.is_socket())
            self.assertEqual([item["id"] for item in remote_hub.load_registry(args)["instances"]], ["x570"])

    def test_pending_transaction_is_recovered_before_the_next_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.transaction_fixture(root)
            tx = Path(args.state_dir) / "transactions" / "pending"
            tx.mkdir(parents=True)
            old_registry = remote_hub.registry_path(args).read_text(encoding="utf-8")
            old_routes = remote_hub.routes_path(args).read_text(encoding="utf-8")
            (tx / "registry.pre").write_text(old_registry, encoding="utf-8")
            (tx / "routes.pre").write_text(old_routes, encoding="utf-8")
            remote_hub.registry_path(args).write_text('{"interrupted":true}\n', encoding="utf-8")
            remote_hub.routes_path(args).write_text("interrupted\n", encoding="utf-8")
            receipt = {
                "schema": remote_hub.TRANSACTION_SCHEMA, "status": "prepared",
                "pre": {"registry_mode": 0o600, "routes_mode": 0o644}, "socket": None,
            }
            remote_hub.write_transaction_receipt(tx / "receipt.json", receipt)
            with patch.object(remote_hub.edge, "nginx_validate"), patch.object(remote_hub.edge, "run"):
                remote_hub.recover_pending_transactions(args)
            self.assertEqual(remote_hub.registry_path(args).read_text(encoding="utf-8"), old_registry)
            self.assertEqual(remote_hub.routes_path(args).read_text(encoding="utf-8"), old_routes)
            self.assertEqual(json.loads((tx / "receipt.json").read_text(encoding="utf-8"))["status"], "recovered")

    def deployment_fixture(self, root: Path) -> types.SimpleNamespace:
        paths = {
            "nginx_config": root / "nginx.conf", "compose_file": root / "compose.yml",
            "hub_site_dir": root / "site", "certbot_config": root / "certbot",
            "socket_host_dir": root / "sockets", "state_dir": root / "state",
            "renewal_cron": root / "cron", "health_service": root / "health.service",
            "health_timer": root / "health.timer", "alert_service": root / "alert.service",
            "logrotate_config": root / "logrotate.conf",
        }
        paths["nginx_config"].write_text("nginx-pre\n", encoding="utf-8")
        paths["compose_file"].write_text("compose-pre\n", encoding="utf-8")
        (paths["socket_host_dir"] / "instances").mkdir(parents=True)
        paths["hub_site_dir"].mkdir()
        archive = paths["certbot_config"] / "archive" / "dsh.onlyservice.io"
        live = paths["certbot_config"] / "live" / "dsh.onlyservice.io"
        renewal = paths["certbot_config"] / "renewal"
        archive.mkdir(parents=True)
        live.mkdir(parents=True)
        renewal.mkdir(parents=True)
        (archive / "fullchain1.pem").write_text("certificate-pre\n", encoding="utf-8")
        (live / "fullchain.pem").symlink_to("../../archive/dsh.onlyservice.io/fullchain1.pem")
        (renewal / "dsh.onlyservice.io.conf").write_text("renewal-pre\n", encoding="utf-8")
        paths["renewal_cron"].write_text("cron-pre\n", encoding="utf-8")
        os.chmod(paths["renewal_cron"], 0o640)
        return types.SimpleNamespace(
            **{name: str(path) for name, path in paths.items()},
            base_domain="dsh.onlyservice.io", socket_group="dsh-remote", nginx_container="nginx-fixture",
        )

    def test_deployment_receipt_restores_certificate_cron_and_metadata_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.deployment_fixture(root)
            result = types.SimpleNamespace(returncode=0, stdout="dsh-remote:x:123:fixture\n")
            with patch.object(remote_hub.edge, "run", return_value=result):
                receipt_dir, receipt = remote_hub.backup(args)
            archive = Path(args.certbot_config) / "archive" / args.base_domain / "fullchain1.pem"
            live = Path(args.certbot_config) / "live" / args.base_domain / "fullchain.pem"
            archive.write_text("certificate-mutated\n", encoding="utf-8")
            live.unlink()
            live.symlink_to("wrong.pem")
            Path(args.renewal_cron).write_text("cron-mutated\n", encoding="utf-8")
            os.chmod(args.renewal_cron, 0o600)
            with patch.object(remote_hub.edge, "compose_validate"), \
                 patch.object(remote_hub.edge, "compose_recreate"), \
                 patch.object(remote_hub.edge, "nginx_validate"), \
                 patch.object(remote_hub.edge, "run", return_value=result):
                remote_hub.restore(args, receipt_dir, receipt, automatic=False)
            self.assertEqual(archive.read_text(encoding="utf-8"), "certificate-pre\n")
            self.assertEqual(os.readlink(live), "../../archive/dsh.onlyservice.io/fullchain1.pem")
            self.assertEqual(Path(args.renewal_cron).read_text(encoding="utf-8"), "cron-pre\n")
            self.assertEqual(Path(args.renewal_cron).stat().st_mode & 0o777, 0o640)
            final = json.loads((receipt_dir / "receipt.json").read_text(encoding="utf-8"))
            self.assertTrue(final["rollback_result"]["verified"])

    def test_socket_status_requires_secure_listening_and_functional_route(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            args = types.SimpleNamespace(socket_host_dir=directory, base_domain="dsh.onlyservice.io", ssh_uid=os.getuid())
            instances = Path(directory) / "instances"
            instances.mkdir()
            path = instances / "x570.sock"
            path.write_text("not-a-socket", encoding="utf-8")
            with patch.object(remote_hub.edge, "secure_path", return_value=False):
                self.assertEqual(remote_hub.socket_status(args, "x570", os.getgid())["state"], "insecure")
            path.unlink()
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(str(path))
            listener.listen()
            response = types.SimpleNamespace(returncode=0, stdout="401")
            try:
                with patch.object(remote_hub.edge, "secure_path", return_value=True), \
                     patch.object(remote_hub, "unix_socket_live", return_value=True), \
                     patch.object(remote_hub.edge, "run", return_value=response):
                    self.assertEqual(remote_hub.socket_status(args, "x570", os.getgid())["state"], "online")
                response.stdout = "000"
                with patch.object(remote_hub.edge, "secure_path", return_value=True), \
                     patch.object(remote_hub, "unix_socket_live", return_value=True), \
                     patch.object(remote_hub.edge, "run", return_value=response):
                    self.assertEqual(remote_hub.socket_status(args, "x570", os.getgid())["state"], "offline")
            finally:
                listener.close()

    def test_alert_acknowledgement_requires_current_health(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            alarm = Path(directory) / "health-alarm"
            alarm.write_text("failure\n", encoding="utf-8")
            args = types.SimpleNamespace(state_dir=directory, health_service="/etc/systemd/system/dsh-remote-hub-health.service")
            unhealthy = {"configured": True, "instances": [{"state": "offline"}]}
            with patch.object(remote_hub, "_hub_status_locked", return_value=unhealthy):
                with self.assertRaisesRegex(remote_hub.HubError, "every registered instance"):
                    remote_hub.acknowledge_alert(args)
            self.assertTrue(alarm.exists())
            healthy = {"configured": True, "instances": [{"state": "online"}]}
            with patch.object(remote_hub, "_hub_status_locked", return_value=healthy), patch.object(remote_hub.edge, "run"):
                result = remote_hub.acknowledge_alert(args)
            self.assertEqual(result, {"status": "acknowledged", "alarm_active": False})
            self.assertFalse(alarm.exists())


if __name__ == "__main__":
    unittest.main()
