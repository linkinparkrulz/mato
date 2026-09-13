#!/usr/bin/env node
// =============================================================================
// The Dojo Bay — resource diagnostic.
//
// READ-ONLY. Measures what this instance actually uses, rather than guessing,
// so an operator can size a VPS from evidence and this project can document a
// requirement it has tested.
//
// What it looks at, and why each matters for THIS workload:
//
//   memory     the backend is a small long-running Node process; the updater is
//              a second one every ten minutes; tor and nginx sit alongside.
//              Peak matters more than current, because `npm ci` during a deploy
//              and the unzip during a self-update are the two spikes.
//   disk       node_modules, the published data, and — the one that grows
//              without limit — data/backups, a full copy of the code kept by
//              every self-update.
//   cpu        idle almost always, with a burst each probe cycle: one Tor
//              circuit per listed node, plus secp256k1 verification.
//   strain     swap in use, OOM kills and load average are the evidence that a
//              box is actually too small, as opposed to merely modest.
//
// NO PATH FROM THE ENVIRONMENT REACHES A SUBPROCESS. WEB_ROOT and
// PUBLIC_DATA_DIR are operator-set, and this file used to hand them to `df` and
// `du`, which CodeQL flagged (js/shell-command-injection-from-environment) and
// which is a real if narrow bug: a value beginning with a hyphen is read by
// those tools as an option, not a path, so `WEB_ROOT=-x` silently measures
// something other than what was asked for. Both are now answered by Node
// itself, statfs() and a walk, which removes the class rather than escaping
// around it. The two subprocesses that remain (systemctl, journalctl) exist
// because nothing in Node can answer what they answer, and both take arguments
// written here. Keep it that way: see sh() below.
//
// Usage, on the box:
//     cd /var/www/dojobay/server && node check-resources.ts
// =============================================================================
import { readFile, stat, readdir, lstat, statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = process.env.WEB_ROOT || path.resolve(HERE, "..");
const PUBLIC_DIR = process.env.PUBLIC_DATA_DIR || path.join(WEB_ROOT, "data");

const MB = 1024 * 1024;
const mb = (bytes: number) => {
  if (bytes < 1024) return bytes + " B";
  if (bytes < MB) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0) + " MB";
};
const gb = (bytes: number) => (bytes / (1024 * MB)).toFixed(1) + " GB";
const read = async (p: string) => { try { return await readFile(p, "utf8"); } catch { return null; } };

// Every call site passes a command and an argument list written in this file,
// never a path, a name or anything else derived from the environment. The one
// exception is UNITS below, which the suite checks directly. A future edit that
// interpolates a variable in here fails the gate rather than shipping.
const sh = async (cmd: string, args: string[]) => {
  try { return (await exec(cmd, args)).stdout.trim(); } catch { return null; }
};

// The only values this file passes to a subprocess that are not written inline
// at the call site. They are exported so the suite can assert on the array
// itself rather than reading this source and guessing: an assertion about what
// a program does is worth more than one about how it is spelled.
export const UNITS = [
  "dojobay-server.service",
  "dojobay-update.service",
  "tor.service",
  "nginx.service",
];

// Replaces `df`. statfs reports the filesystem holding the path, and the
// arithmetic matches what df prints: used counts the blocks the filesystem
// considers occupied, while available excludes the root reserve, so used plus
// available is legitimately less than the total.
export const diskUsage = async (p: string) => {
  try {
    const fs = await statfs(p);
    const block = Number(fs.bsize);
    return {
      size: Number(fs.blocks) * block,
      used: (Number(fs.blocks) - Number(fs.bfree)) * block,
      avail: Number(fs.bavail) * block,
    };
  } catch { return null; }
};

// Replaces `du -sb`: apparent size of a tree, symlinks counted but never
// followed, unreadable entries skipped rather than fatal, and directory inodes
// excluded, which is what `du -sb` does and is why this agrees with it to the
// byte on a real node_modules. Counting the directories instead would add 4 KB
// per directory of filesystem bookkeeping to a figure meant to describe
// content. One difference remains: du counts a hard-linked file once, this
// counts it once per link, which node_modules does not contain and which would
// overstate rather than hide. It also walks in JavaScript, so a populated
// node_modules takes a second or so rather than being instant, which is nothing
// for a diagnostic run by hand a few times a year.
export const dirSize = async (p: string): Promise<number | null> => {
  const root = await lstat(p).catch(() => null);
  if (!root) return null;
  if (!root.isDirectory()) return root.size;
  let total = 0;
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const s = await lstat(full).catch(() => null);
      if (s) total += s.size;
    }
  };
  await walk(p);
  return total;
};

const report = async () => {
  console.log("The Dojo Bay — what this instance actually uses\n");

  // ---- the machine ----------------------------------------------------------
  const meminfo = (await read("/proc/meminfo")) || "";
  const kb = (key: string) => {
    const m = meminfo.match(new RegExp("^" + key + ":\\s+(\\d+) kB", "m"));
    return m ? Number(m[1]) * 1024 : null;
  };
  const memTotal = kb("MemTotal"), memAvail = kb("MemAvailable");
  const swapTotal = kb("SwapTotal"), swapFree = kb("SwapFree");
  const swapUsed = swapTotal != null && swapFree != null ? swapTotal - swapFree : null;
  const cpus = os.cpus();

  console.log("MACHINE");
  console.log(`  cpu            ${cpus.length} × ${cpus[0]?.model?.trim() || "unknown"}`);
  console.log(`  memory         ${memTotal ? gb(memTotal) : "?"} total, ${memAvail ? gb(memAvail) : "?"} available`);
  console.log(`  swap           ${swapTotal ? gb(swapTotal) + " total, " + mb(swapUsed || 0) + " in use" : "none configured"}`);
  const la = os.loadavg();
  console.log(`  load average   ${la.map((n) => n.toFixed(2)).join("  ")}   (1, 5, 15 min; ${cpus.length} core${cpus.length === 1 ? "" : "s"})`);

  const disk = await diskUsage(WEB_ROOT);
  const diskFree = disk ? disk.avail : null;
  if (disk) console.log(`  disk           ${gb(disk.size)} total, ${gb(disk.used)} used, ${gb(disk.avail)} free`);

  // ---- what our services use ------------------------------------------------
  console.log("\nSERVICES  (current / peak since boot)");
  let ourPeak = 0;
  for (const unit of UNITS) {
    const base = `/sys/fs/cgroup/system.slice/${unit}`;
    const cur = Number((await read(`${base}/memory.current`)) || 0);
    const peak = Number((await read(`${base}/memory.peak`)) || 0);
    const active = await sh("systemctl", ["is-active", unit]);
    if (!cur && active !== "active") { console.log(`  ${unit.padEnd(24)} not running`); continue; }
    if (unit.startsWith("dojobay")) ourPeak += peak || cur;
    console.log(`  ${unit.padEnd(24)} ${cur ? mb(cur) : "—"}${peak ? "  /  " + mb(peak) : ""}`);
  }

  // ---- disk, broken down ----------------------------------------------------
  console.log("\nDISK USED BY THIS INSTALLATION");
  const parts: [string, string][] = [
    ["everything", WEB_ROOT],
    ["  server/node_modules", path.join(WEB_ROOT, "server", "node_modules")],
    ["  data (published)", PUBLIC_DIR],
    ["  data/avatars", path.join(PUBLIC_DIR, "avatars")],
    ["  data/backups", path.join(PUBLIC_DIR, "backups")],
    ["  data/updates", path.join(PUBLIC_DIR, "updates")],
  ];
  let backupsBytes = 0, backupCount = 0;
  for (const [label, p] of parts) {
    const bytes = await dirSize(p);
    if (bytes == null) { console.log(`  ${label.padEnd(24)} —`); continue; }
    if (label.includes("backups")) {
      backupsBytes = bytes;
      try { backupCount = (await readdir(p)).length; } catch { /* none */ }
    }
    console.log(`  ${label.padEnd(24)} ${mb(bytes)}${label.includes("backups") && backupCount ? `  (${backupCount} kept)` : ""}`);
  }

  // ---- the workload ---------------------------------------------------------
  console.log("\nWORKLOAD");
  let nodeCount = 0, intervalMin = 10;
  try {
    const dojos = JSON.parse((await read(path.join(PUBLIC_DIR, "dojos.json"))) || "{}");
    nodeCount = (dojos.nodes || []).length;
    intervalMin = Number(dojos.interval_minutes) || 10;
  } catch { /* not built yet */ }
  const concurrency = Number(process.env.CONCURRENCY || 4);
  console.log(`  listed nodes   ${nodeCount}`);
  console.log(`  probe cycle    every ${intervalMin} min, up to ${concurrency} Tor circuits at once`);
  for (const f of ["dojos.json", "history.json", "history-daily.json"]) {
    const s = await stat(path.join(PUBLIC_DIR, f)).catch(() => null);
    if (s) console.log(`  ${f.padEnd(22)} ${mb(s.size)}`);
  }

  // ---- evidence of strain ---------------------------------------------------
  // journalctl does its own matching, so there is no pipeline and no shell: the
  // filter is an argument, the output is one line per matching entry, and a
  // journalctl that cannot answer leaves this null exactly as an absent one did.
  console.log("\nSIGNS OF STRAIN");
  const oom = await sh("journalctl", ["-k", "--no-pager", "--case-sensitive=false",
    "--grep=out of memory", "--output=cat"]);
  const oomCount = oom ? oom.split("\n").filter((l) => l.trim()).length : 0;
  const findings: string[] = [];
  if (oomCount > 0) findings.push(`${oomCount} out-of-memory event(s) in the kernel log — the box IS too small`);
  if (swapUsed && swapUsed > 64 * MB) findings.push(`${mb(swapUsed)} of swap in use — memory pressure, though not fatal`);
  if (memAvail && memTotal && memAvail < memTotal * 0.15) findings.push("under 15% of memory available right now");
  if (la[2] > cpus.length) findings.push(`15-minute load ${la[2].toFixed(2)} exceeds ${cpus.length} core(s)`);
  if (diskFree != null && diskFree < 2 * 1024 * MB) findings.push(`only ${gb(diskFree)} of disk free`);
  if (backupCount > 3) findings.push(`${backupCount} self-update backups kept (${mb(backupsBytes)}); nothing prunes these`);
  if (!findings.length) console.log("  none. Nothing here suggests this machine is short of anything.");
  else for (const f of findings) console.log(`  · ${f}`);

  // ---- what to tell other operators -----------------------------------------
  console.log("\nWHAT THIS SUGGESTS FOR A MINIMUM SPEC");
  const ourMb = ourPeak / MB;
  if (ourPeak > 0) {
    console.log(`  This instance's own services peaked at about ${mb(ourPeak)}, carrying ${nodeCount} node(s).`);
    console.log("  Add tor, nginx and the operating system, and headroom for `npm ci`");
    console.log("  during a deploy, which is the largest transient by some way.");
  } else {
    console.log("  The services are not running here, so nothing was measured. Run this ON");
    console.log("  the instance, with the backend up, for numbers that mean anything.");
  }
  console.log("");
  console.log(`  Suggested minimum: 1 vCPU, ${ourPeak > 0 && ourMb < 200 ? "1 GB" : "2 GB"} RAM, 20 GB disk, plus swap.`);
  console.log("  The work is almost entirely waiting on Tor, so cores buy little; memory");
  console.log("  and a little disk headroom are what matter. Run this again after a");
  console.log("  deploy and after a self-update to catch the peaks rather than the calm.");
};

// Run when invoked, importable when tested. The suite exercises dirSize and
// diskUsage directly; printing a report on import would make that impossible.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await report();
