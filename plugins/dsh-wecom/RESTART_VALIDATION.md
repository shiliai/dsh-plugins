# dsh-wecom restart and live validation runbook

This runbook is intentionally host-neutral. Replace `<profile>` and service
commands with values for the deployment being tested. Never put a real bot
secret in this repository, a shell history, or a test report.

## Before restart

1. Install or update the plugin through `dsh plugin`; do not edit a profile
   manifest or lockfile directly. See `README.md` for the supported GitHub
   source and updater commands.
2. Configure `WECOM_BOT_ID` and `WECOM_BOT_SECRET` in the environment used by
   the DSH process.
3. Configure explicit `allowChats`, `allowGroupSenders`,
   `outboundAllowChats`, and `allowedCwdRoots` values. Empty allowlists deny
   access.
4. Confirm that no other process is holding the same robot long connection.
5. Record the currently installed Git revision and preserve the previous
   service configuration for rollback.

## Plugin-only restart

1. Open the WeCom connection panel from the DSH sidebar. Confirm it shows a
   redacted identity and one of `unconfigured`, `connecting`, `online`,
   `reconnecting`, `offline`, or `error` without reloading DSH.
2. For `unconfigured`, correct the environment through the deployment's normal
   configuration process, then restart the DSH profile so its process receives
   that environment. A plugin-only restart cannot reload it. Do not edit a
   profile manifest or lockfile.
3. When the panel shows `online`, click Restart and accept the warning that
   process-local conversations reset. Do not restart the DSH service for this
   check.
4. Wait for the same panel to show `online`, or record its safe diagnostic and
   stop for credential/network investigation. Verify other DSH functions remain
   available throughout.

Conversation memory is process-local. A plugin-only restart starts a new bridge
epoch and does not resume prior WeCom sessions.

## Live validation

Use test identities that appear in the configured allowlists.

1. Send `/status` from an allowed direct chat. Verify the reported working
   directory and default preset. The live model appears after the first agent
   turn.
2. Send two related messages and verify that the second answer uses the first
   turn's context.
3. Send `/new`, then verify that the earlier conversational context is no
   longer used.
4. Exercise `/agent` and switch to a known healthy preset. Verify that the next
   message starts a new session with that preset.
5. Exercise `/cd` with an allowed descendant, then try an absolute path, `..`,
   and a symlink that escape the configured roots. Only the contained path
   should succeed.
6. From an unauthorized direct chat, verify that the bot sends no response.
7. In a permitted group, verify that an allowed sender succeeds and a sender
   absent from `allowGroupSenders` receives no response.
8. Invoke `wecom_send_message` for one allowed and one denied destination. Only
   the explicitly allowed destination should receive a message.
9. Use the panel Restart once more and verify that the plugin reconnects and
   old process-local memory is not restored. Do not record bot credentials,
   message bodies, tokens, or raw frames in the validation result.

The automated suite uses fakes and does not replace this credentialed network
test. Validate `@dsh-plugins/dsh-wecom@0.2.0`, then record the profile, plugin
Git revision, test identities, and pass/fail
result without recording message bodies or credentials.

## Rollback

1. Stop the affected profile.
2. Restore the previously validated plugin revision and configuration through
   `dsh plugin` operations.
3. Start the profile and repeat the direct-chat smoke test.
4. If the plugin must be disabled, remove its bundle through `dsh plugin` and
   restart the profile. Do not hand-edit the profile manifest or lockfile.
