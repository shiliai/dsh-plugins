#!/usr/bin/env node
/**
 * dsh-web-fixed-launch-token.mjs — patch an installed dsh-cli release so the
 * dsh web launch token is read from `$DSH_HOME/fixed-launch-token` instead of
 * being randomly generated per process.
 *
 * Background: `@deepseek-ai/dsh-client-connection` generates the web launch
 * token with `randomBytes(32)` at first use and keeps it only in an in-memory
 * WeakMap; it rotates on every host restart and is printed only to the host
 * stdout log. Upstream offers no config to disable or pin it (verified against
 * 0.1.2-rc.1 and 0.1.3-alpha.1). This script rewrites the one physical
 * `dsh-client-connection/lib/index.js` inside a release's `.pnpm` tree so
 * `processLaunchToken` prefers a fixed token file and only falls back to the
 * random behavior when the file is absent or too short.
 *
 * The token file is read once per process (cached in the module's WeakMap as
 * before); editing or deleting it takes effect on the next external restart.
 * The signed-cookie HMAC secret in `$DSH_HOME/.credentials.yaml` is untouched,
 * so existing browser sessions stay logged in across the restart.
 *
 * Usage:
 *   node scripts/dsh-web-fixed-launch-token.mjs --check  [--release <dir>]
 *   node scripts/dsh-web-fixed-launch-token.mjs --apply  [--release <dir>]
 *   node scripts/dsh-web-fixed-launch-token.mjs --revert [--release <dir>]
 *
 * Exit codes: 0 = OK, 3 = --check found an unpatched target, 1 = error.
 * The pre-patch file is kept beside the target as `index.js.orig`; `--revert`
 * restores it. Re-apply after every dsh-cli release upgrade (a fresh release
 * tree ships unpatched vendor code again).
 */
import { existsSync, copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Marker comment identifying an already-patched file. */
const MARKER = "/* dsh-fixed-launch-token-patch v1 */";
/** Backup filename kept beside the target. */
const BACKUP_NAME = "index.js.orig";
/** The upstream import line the patched fs import is appended to. */
const IMPORT_ANCHOR =
	'import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";';
const IMPORT_ADDED = '\nimport { readFileSync } from "node:fs";';
/** The exact upstream `processLaunchToken` body this patch replaces (tab-indented). */
const ANCHOR = [
	"function processLaunchToken(owner) {",
	"\tconst existing = PROCESS_LAUNCH_TOKENS.get(owner);",
	"\tif (existing !== void 0) return existing;",
	"\tconst created = encodeBase64Url(randomBytes(SECRET_BYTES));",
	"\tPROCESS_LAUNCH_TOKENS.set(owner, created);",
	"\treturn created;",
	"}",
].join("\n");
/** The replacement body: prefer `$DSH_HOME/fixed-launch-token`, fall back to random. */
const REPLACEMENT = [
	"/* dsh-fixed-launch-token-patch v1: fixed token from $DSH_HOME/fixed-launch-token */",
	"function processLaunchToken(owner) {",
	"\tconst existing = PROCESS_LAUNCH_TOKENS.get(owner);",
	"\tif (existing !== void 0) return existing;",
	"\tlet created;",
	"\ttry {",
	'\t\tconst fixed = readFileSync(`${process.env.DSH_HOME ?? ""}/fixed-launch-token`, "utf8").trim();',
	'\t\tif (fixed.length >= 16) created = fixed;',
	"\t} catch {",
	"\t}",
	"\tif (created === void 0) created = encodeBase64Url(randomBytes(SECRET_BYTES));",
	"\tPROCESS_LAUNCH_TOKENS.set(owner, created);",
	"\treturn created;",
	"}",
].join("\n");

function parseArgs(argv) {
	const args = { release: undefined, action: undefined };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--release") args.release = argv[(i += 1)];
		else if (arg === "--check") args.action = "check";
		else if (arg === "--apply") args.action = "apply";
		else if (arg === "--revert") args.action = "revert";
		else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
	}
	if (args.action === undefined) {
		throw new Error("pass one action flag: --check, --apply, or --revert");
	}
	return args;
}

/** Locate the release root (a directory whose node_modules contains .pnpm). */
function findReleaseRoot(explicit) {
	if (explicit !== undefined) return resolve(explicit);
	const probe = spawnSync("which", ["dsh"], { encoding: "utf8" });
	if (probe.status === 0) {
		let dir = dirname(resolve(probe.stdout.trim()));
		while (dir !== dirname(dir)) {
			const candidate = join(dir, "node_modules", ".pnpm");
			if (existsSync(candidate)) return dir;
			dir = dirname(dir);
		}
	}
	throw new Error(
		"could not locate the dsh release root from `which dsh`; pass --release <dir> "
			+ "(the directory containing the release's node_modules, e.g. ~/.local/share/dsh-cli/releases/<version>)",
	);
}

/**
 * Find every physical `dsh-client-connection/lib/index.js` under the release's
 * `.pnpm` tree. Release trees ship exactly one physical copy; dependent
 * packages reach it through pnpm symlinks, so scanning the physical
 * `@deepseek-ai+dsh-client-connection@*` stores covers every importer.
 */
function findTargets(releaseRoot) {
	const pnpmRoot = join(releaseRoot, "node_modules", ".pnpm");
	if (!existsSync(pnpmRoot)) throw new Error(`${pnpmRoot} not found — is ${releaseRoot} a dsh-cli release root?`);
	const targets = [];
	for (const store of readdirSync(pnpmRoot)) {
		if (!store.startsWith("@deepseek-ai+dsh-client-connection@")) continue;
		const target = join(pnpmRoot, store, "node_modules", "@deepseek-ai", "dsh-client-connection", "lib", "index.js");
		if (existsSync(target)) targets.push(target);
	}
	if (targets.length === 0) {
		throw new Error("no physical @deepseek-ai/dsh-client-connection/lib/index.js found under .pnpm");
	}
	return targets;
}

function sha256(text) {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function applyTo(target, action) {
	const content = readFileSync(target, "utf8");
	// The patched file carries the marker inside a longer comment, so match the
	// bare identifier instead of a delimiter-terminated literal.
	const alreadyPatched = content.includes("dsh-fixed-launch-token-patch v1");
	const backupPath = join(dirname(target), BACKUP_NAME);

	if (action === "check") {
		return { target, status: alreadyPatched ? "patched" : "unpatched" };
	}
	if (action === "apply") {
		if (alreadyPatched) return { target, status: "already-patched (no-op)" };
		if (!content.includes(ANCHOR)) {
			throw new Error(
				`${target}: the upstream processLaunchToken body was not found — the vendor code shape changed; `
					+ "re-derive the patch from the new source before applying",
			);
		}
		if (content.split(ANCHOR).length !== 2) {
			throw new Error(`${target}: the anchor text appears more than once; refusing to patch`);
		}
		if (!existsSync(backupPath)) copyFileSync(target, backupPath);
		let patched = content.replace(ANCHOR, REPLACEMENT);
		if (!patched.includes('from "node:fs"')) {
			if (!patched.includes(IMPORT_ANCHOR)) {
				throw new Error(`${target}: the node:crypto import anchor was not found`);
			}
			patched = patched.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + IMPORT_ADDED);
		}
		// Syntax-check before writing anything; restore the backup on failure.
		const probe = join(dirname(target), ".fixed-token-syntax-check.mjs");
		try {
			writeFileSync(probe, patched);
			const check = spawnSync(process.execPath, ["--check", probe], { encoding: "utf8" });
			if (check.status !== 0) {
				throw new Error(`patched file failed node --check: ${check.stderr.trim()}`);
			}
		} finally {
			try {
				spawnSync("rm", ["-f", probe]);
			} catch {
				// best effort cleanup
			}
		}
		writeFileSync(target, patched);
		return { target, status: "patched", before: sha256(content), after: sha256(patched), backup: backupPath };
	}
	// action === "revert"
	if (!existsSync(backupPath)) throw new Error(`${backupPath} not found — nothing to revert`);
	if (alreadyPatched) {
		copyFileSync(backupPath, target);
		return { target, status: "reverted" };
	}
	return { target, status: "unpatched (revert skipped — file has no marker; not touching it)" };
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const releaseRoot = findReleaseRoot(args.release);
	const targets = findTargets(releaseRoot);
	const results = targets.map((target) => applyTo(target, args.action));
	for (const result of results) {
		const parts = [result.status, result.target];
		if (result.before !== undefined) parts.push(`sha256 ${result.before} -> ${result.after}`);
		if (result.backup !== undefined) parts.push(`backup ${result.backup}`);
		console.log(`[${result.status}] ${parts.slice(1).join("  ")}`);
	}
	if (args.action === "check") {
		const unpatched = results.some((result) => result.status === "unpatched");
		console.log(unpatched
			? "check: NOT patched — run with --apply to patch (restart the host externally afterwards)"
			: "check: patched");
		process.exitCode = unpatched ? 3 : 0;
		return;
	}
	console.log("note: the running dsh web host keeps executing the previously loaded module; "
		+ "the patch takes effect on the next external restart");
}

try {
	main();
} catch (error) {
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
