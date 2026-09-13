#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — uninstaller.
//
// Reverses what scripts/install.mjs created, and nothing else. Ordered by how
// recoverable each step is, and it stops well short of the two that are not.
//
//   1. stop and disable the service and the updater timer      reversible
//   2. remove the three systemd units                          reversible
//   3. remove the nginx site and reload nginx                  reversible
//   4. take our block out of torrc and restart tor             reversible
//   5. remove the web root, which holds the store              --purge-data
//   6. remove the hidden service directory                     --purge-onion
//
// Steps 5 and 6 are opt-in because they destroy things the operator cannot get
// back. The store holds other operators' submissions and their signed blocks.
// The hidden service directory holds the private key that IS the onion address:
// delete it and that address is gone permanently, and nobody who bookmarked it
// can ever reach this instance again. Both are archived before removal unless
// --no-backup is given.
//
// Packages are never removed. tor and nginx were very likely installed before
// this and are very likely serving something else.
//
// Usage:
//     sudo ./uninstall.sh                  # dry run: says what it would do
//     sudo ./uninstall.sh --apply          # stop serving, keep data and onion
//     sudo ./uninstall.sh --apply --purge-data
//     sudo ./uninstall.sh --apply --purge-data --purge-onion
// =============================================================================
import { readFile, writeFile, rm, mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createInterface } from "node:readline";
import { stripTorrc } from "./installer-lib.mjs";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const PURGE_DATA = argv.includes("--purge-data");
const PURGE_ONION = argv.includes("--purge-onion");
const NO_BACKUP = argv.includes("--no-backup");
const ASSUME_YES = argv.includes("--yes");

const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const WEB_ROOT = flag("--web-root", "/var/www/dojobay");
const HS_DIR = flag("--onion-dir", "/var/lib/tor/dojobay");
const TORRC = flag("--torrc", "/etc/tor/torrc");

const UNITS = ["dojobay-server.service", "dojobay-update.service", "dojobay-update.timer"]
  .map((u) => `/etc/systemd/system/${u}`);
const NGINX_AVAILABLE = "/etc/nginx/sites-available/dojobay";
const NGINX_ENABLED = "/etc/nginx/sites-enabled/dojobay";

if (process.getuid && process.getuid() !== 0) {
  console.error("This must run as root: sudo ./uninstall.sh");
  process.exit(2);
}

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
/**
 * Run a command, but only when applying. Failures are returned rather than
 * thrown: an uninstall that stops halfway leaves a half-removed system, which
 * is worse than one that reports what it could not do and carries on.
 * @param {string} cmd @param {string[]} args
 * @returns {Promise<{ skipped?: boolean, error?: Error, stdout?: string, stderr?: string }>}
 */
const run = async (cmd, args) => {
  if (!APPLY) return { skipped: true };
  try { return await exec(cmd, args); } catch (e) { return { error: /** @type {Error} */ (e) }; }
};
const say = (s = "") => console.log(s);
const step = (n, s) => say(`\n${n}. ${s}`);

// ---- survey -----------------------------------------------------------------
const found = {
  units: [], nginxAvailable: false, nginxEnabled: false,
  torrcBlock: false, webRoot: false, onionDir: false, onionAddress: null,
};
for (const u of UNITS) if (await exists(u)) found.units.push(u);
found.nginxAvailable = await exists(NGINX_AVAILABLE);
found.nginxEnabled = await exists(NGINX_ENABLED);
found.webRoot = await exists(WEB_ROOT);
found.onionDir = await exists(HS_DIR);
try { found.torrcBlock = stripTorrc(await readFile(TORRC, "utf8")).removed; } catch {}
try { found.onionAddress = (await readFile(path.join(HS_DIR, "hostname"), "utf8")).trim(); } catch {}

say("The Dojo Bay — uninstall\n");
say(`  systemd units        ${found.units.length ? found.units.length + " present" : "none"}`);
say(`  nginx site           ${found.nginxAvailable || found.nginxEnabled ? "present" : "none"}`);
say(`  torrc block          ${found.torrcBlock ? "present in " + TORRC : "not found"}`);
say(`  web root             ${found.webRoot ? WEB_ROOT : "not found"}`);
say(`  hidden service dir   ${found.onionDir ? HS_DIR : "not found"}`);
if (found.onionAddress) say(`  onion address        ${found.onionAddress}`);

if (!found.units.length && !found.nginxAvailable && !found.torrcBlock && !found.webRoot && !found.onionDir) {
  say("\nNothing of this installation was found. Nothing to do.");
  process.exit(0);
}

say("\nWill:");
say("  · stop and disable the backend and the updater timer");
say("  · remove the systemd units, the nginx site and the torrc block");
say(PURGE_DATA
  ? `  · DELETE ${WEB_ROOT}, including the store: every operator's submission and signed block`
  : `  · KEEP ${WEB_ROOT} and its store (pass --purge-data to remove it)`);
say(PURGE_ONION
  ? `  · DELETE ${HS_DIR}: the onion address ${found.onionAddress || ""} is gone permanently`
  : `  · KEEP ${HS_DIR}, so the onion address survives (pass --purge-onion to remove it)`);
say("  · leave the tor and nginx packages alone");

if (!APPLY) {
  say("\nDRY RUN — nothing has been changed. Re-run with --apply to proceed.");
  process.exit(0);
}

// ---- confirmation, proportionate to what is being destroyed ------------------
async function ask(question) {
  if (ASSUME_YES) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer.trim();
}

if (PURGE_ONION && found.onionDir && !ASSUME_YES) {
  say("\n" + "!".repeat(70));
  say("The hidden service key is about to be deleted. This cannot be undone.");
  say("The address below will never work again, for anyone who has it bookmarked,");
  say("and no backup of it exists anywhere else unless you have made one.");
  say("!".repeat(70));
  const typed = await ask(`\nType the onion address to confirm (${found.onionAddress || "unknown"}):\n> `);
  if (!found.onionAddress || typed !== found.onionAddress) {
    say("That did not match. Nothing has been deleted.");
    process.exit(1);
  }
} else if (PURGE_DATA && !ASSUME_YES) {
  const typed = await ask(`\nDelete ${WEB_ROOT} and its store? Type yes to confirm:\n> `);
  if (typed !== "yes") { say("Not confirmed. Nothing has been deleted."); process.exit(1); }
}

// ---- backup -----------------------------------------------------------------
let backupPath = null;
if ((PURGE_DATA || PURGE_ONION) && !NO_BACKUP) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  backupPath = `/root/dojobay-uninstall-${stamp}.tar.gz`;
  const targets = [];
  if (PURGE_DATA && found.webRoot) targets.push(WEB_ROOT);
  if (PURGE_ONION && found.onionDir) targets.push(HS_DIR);
  step("0", `Archiving ${targets.join(" and ")} to ${backupPath}`);
  const r = await run("tar", ["-czf", backupPath, "--absolute-names", ...targets]);
  if (r?.error) {
    say(`   FAILED: ${r.error.message}`);
    say("   Refusing to delete anything without a backup. Re-run with --no-backup to override.");
    process.exit(1);
  }
  say("   done. Keep this somewhere safe: it contains the onion key and the store.");
}

// ---- 1. stop the services ---------------------------------------------------
step(1, "Stopping and disabling services");
for (const unit of ["dojobay-update.timer", "dojobay-update.service", "dojobay-server.service"]) {
  await run("systemctl", ["disable", "--now", unit]);
  say(`   ${unit}`);
}

// ---- 2. systemd units -------------------------------------------------------
step(2, "Removing systemd units");
for (const u of found.units) { await run("rm", ["-f", u]); say(`   ${u}`); }
await run("systemctl", ["daemon-reload"]);
await run("systemctl", ["reset-failed"]);

// ---- 3. nginx ---------------------------------------------------------------
step(3, "Removing the nginx site");
if (found.nginxEnabled) { await run("rm", ["-f", NGINX_ENABLED]); say(`   ${NGINX_ENABLED}`); }
if (found.nginxAvailable) { await run("rm", ["-f", NGINX_AVAILABLE]); say(`   ${NGINX_AVAILABLE}`); }
const nginxTest = await run("nginx", ["-t"]);
if (nginxTest?.error) say("   nginx -t reports a problem; not reloading. Check your other sites.");
else { await run("systemctl", ["reload", "nginx"]); say("   nginx reloaded"); }

// ---- 4. torrc ---------------------------------------------------------------
step(4, "Removing the torrc block");
if (found.torrcBlock) {
  const original = await readFile(TORRC, "utf8");
  const { text } = stripTorrc(original);
  await writeFile(TORRC + ".dojobay-bak", original);
  await writeFile(TORRC, text);
  say(`   removed our block from ${TORRC} (original kept at ${TORRC}.dojobay-bak)`);
  const torTest = await run("tor", ["--verify-config"]);
  if (torTest?.error) say("   tor --verify-config reports a problem; NOT restarting tor. Check the file.");
  else { await run("systemctl", ["restart", "tor"]); say("   tor restarted"); }
} else {
  say("   no managed block found; leaving the file alone");
}

// ---- 5 and 6. the irreversible parts ----------------------------------------
if (PURGE_DATA && found.webRoot) {
  step(5, `Deleting ${WEB_ROOT}`);
  await run("rm", ["-rf", WEB_ROOT]);
  say("   done");
} else if (found.webRoot) {
  step(5, `Keeping ${WEB_ROOT}`);
  say("   the store, history and operator binding are untouched");
}

if (PURGE_ONION && found.onionDir) {
  step(6, `Deleting ${HS_DIR}`);
  await run("rm", ["-rf", HS_DIR]);
  say(`   done. ${found.onionAddress || "That address"} is now permanently unreachable.`);
} else if (found.onionDir) {
  step(6, `Keeping ${HS_DIR}`);
  say(`   ${found.onionAddress || "the onion address"} survives; reinstalling will reuse it`);
}

say("\nUninstalled.");
if (backupPath) say(`Backup: ${backupPath}`);
if (!PURGE_DATA && found.webRoot) say(`Data kept: ${WEB_ROOT}`);
if (!PURGE_ONION && found.onionDir) say(`Onion key kept: ${HS_DIR}`);
say("tor and nginx are still installed and running; remove them yourself if nothing else needs them.");
