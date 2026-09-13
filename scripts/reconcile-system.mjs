#!/usr/bin/env node
// Reconcile the system files installed under /etc against the copies shipped in
// this repository.
//
// Nothing under /etc is touched by a deploy or a self-update. The systemd units,
// the nginx site and the polkit rule are copied into place once, by the
// installer, and then drift: a change reaches the repository and stops there,
// and the operator has no way to know. This is the reverse of the usual
// problem, and it has the usual shape: an operation appears to have succeeded
// because the thing that would report otherwise is not the thing anybody is
// looking at.
//
//   node scripts/reconcile-system.mjs            # dry run, the default
//   node scripts/reconcile-system.mjs --apply    # write, after confirming
//   node scripts/reconcile-system.mjs --diff     # full unified diff per file
//
// Dry run is the default and --apply still asks before writing, because these
// are the files that decide whether the machine boots into a working service.
//
// The operator's own settings are not drift. Every value the renderers
// substitute is recovered from the installed file itself (see
// recoverUnitValues) and rendered back into the current template, so a diff
// shows what the repository changed and not what the operator configured. That
// also means this works on an instance that predates the installer and recorded
// nothing, which is the case on the live VPS.
//
// --root exists for the tests, which cannot write to /etc. It is not a
// deployment feature and nothing in the installer uses it.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  renderServerUnit, renderUpdateUnit, renderNginx, renderPolkitRule,
  recoverUnitValues, planSystemFile, SERVICE_USER, POLKIT_RULE_PATH,
} from "./installer-lib.mjs";

const execFileP = promisify(execFile);
const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const SHOW_DIFF = argv.includes("--diff");
const YES = argv.includes("--yes");
const ROOT_PREFIX = (() => {
  const i = argv.indexOf("--root");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "";
})();
const at = (p) => (ROOT_PREFIX ? path.join(ROOT_PREFIX, p) : p);

// The five files the installer puts under /etc, each with the template it came
// from and how to render it. Adding a file here is the whole of adding it to
// the reconciler; scripts/selftest.mjs checks this list against what the
// installer actually writes, so the two cannot drift apart silently.
const FILES = [
  {
    name: "backend unit",
    template: "scripts/dojobay-server.service",
    installed: "/etc/systemd/system/dojobay-server.service",
    render: (tpl, v) => renderServerUnit(tpl, v),
    after: "systemd",
  },
  {
    name: "updater unit",
    template: "scripts/dojobay-update.service",
    installed: "/etc/systemd/system/dojobay-update.service",
    render: (tpl, v) => renderUpdateUnit(tpl, v),
    after: "systemd",
  },
  {
    name: "updater timer",
    template: "scripts/dojobay-update.timer",
    installed: "/etc/systemd/system/dojobay-update.timer",
    // Copied verbatim by the installer, so there is nothing to substitute.
    render: (tpl) => tpl,
    after: "systemd",
  },
  {
    name: "nginx site",
    template: "deploy/nginx-onion.conf.example",
    installed: "/etc/nginx/sites-available/dojobay",
    render: (tpl, v) => renderNginx(tpl, v),
    after: "nginx",
  },
  {
    name: "restart permission",
    template: "deploy/polkit-restart.rules.example",
    installed: POLKIT_RULE_PATH,
    render: (tpl, v) => renderPolkitRule(tpl, { user: v.user || SERVICE_USER }),
    after: "polkit",
    // Legitimately absent: the installer asks, and declining is a supported
    // answer. Absence is reported as a note, never as something to fix.
    optional: true,
  },
];

const read = async (p) => { try { return await readFile(p, "utf8"); } catch { return null; } };

// A unified diff, without a dependency and without shelling out to diff(1),
// which may not be installed. Line-level and deliberately simple: this is for a
// human to read before deciding, not for a machine to apply.
function unified(a, b, label) {
  const A = a.split("\n"), B = b.split("\n");
  const out = [`--- installed  ${label}`, `+++ shipped    ${label}`];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { i++; j++; continue; }
    // Find the next line that resynchronises the two sides. Bounded, so a file
    // that has been rewritten wholesale prints a bounded block rather than
    // hunting to the end of both.
    // Three ways the sides can line up again: lines added, lines removed, or
    // the same count changed in place. Without the third, a one-line edit like
    // RestartSec=3 becoming RestartSec=9 matches nothing ahead and the whole
    // remainder of both files prints as one hunk.
    let k = 1, sync = null;
    for (; k < 40 && !sync; k++) {
      if (j + k < B.length && A[i] === B[j + k]) sync = { di: 0, dj: k };
      else if (i + k < A.length && A[i + k] === B[j]) sync = { di: k, dj: 0 };
      else if (i + k < A.length && j + k < B.length && A[i + k] === B[j + k]) sync = { di: k, dj: k };
    }
    const di = sync ? sync.di : A.length - i, dj = sync ? sync.dj : B.length - j;
    for (let n = 0; n < di; n++) out.push("- " + A[i + n]);
    for (let n = 0; n < dj; n++) out.push("+ " + B[j + n]);
    i += di || 1; j += dj || 1;
    if (!sync) break;
  }
  return out;
}

async function confirm(question) {
  if (YES) return true;
  if (!process.stdin.isTTY) {
    console.log("  (not a terminal, and --yes was not given: nothing written)");
    return false;
  }
  // Discard anything already queued on stdin before asking.
  //
  // An operator pasting a block of commands leaves the later lines buffered,
  // and a plain read would take the next one as the answer. A queued line
  // beginning with y would then approve an overwrite of the files under /etc
  // that nobody meant as an answer. Observed on the live VPS, where the queued
  // line happened to start with s and read as no.
  //
  // A settle window, not a single read. Draining once discards nothing,
  // because the bytes are still in the terminal's buffer and have not reached
  // this process yet: an early read returns null and the paste is then handed
  // to readline as the answer. Verified on a pty, where a queued line reading
  // "yes" approved an overwrite through a drain written that way.
  //
  // So: let stdin flow, throw away everything that arrives for a moment, and
  // only then ask. Pasted lines are already queued and arrive in milliseconds;
  // a person answering a question they have just read takes far longer. This
  // is a large margin rather than a guarantee, which is why the window is
  // generous and why the prompt still defaults to no.
  process.stdin.resume();
  const swallow = () => {};
  process.stdin.on("data", swallow);
  await new Promise((r) => setTimeout(r, 300));
  process.stdin.off("data", swallow);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`${question} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  // The backend unit is where the operator's values live, so it is read first
  // and its values are used for every file. Reading each file's own values
  // would let a half-edited machine render each file consistently with itself
  // and inconsistently with the others.
  const backend = await read(at(FILES[0].installed));
  if (!backend) {
    console.log("No backend unit at " + FILES[0].installed + ".");
    console.log("Nothing to reconcile: this machine has not been installed, or the unit lives elsewhere.");
    console.log("  systemctl show dojobay-server.service -p FragmentPath --value");
    process.exit(0);
  }
  const values = recoverUnitValues(backend);
  if (!values.webRoot || !values.user) {
    console.log("The installed backend unit does not name a web root and an account in the form this expects.");
    console.log("Refusing to guess: rendering a template with the wrong paths would produce a unit that does not start.");
    process.exit(2);
  }
  console.log(`Reconciling against ${ROOT}`);
  console.log(`  web root ${values.webRoot}   account ${values.user}\n`);

  const results = [];
  for (const f of FILES) {
    const tpl = await read(path.join(ROOT, f.template));
    if (tpl === null) {
      results.push({ f, state: "no-template", changed: false, shipped: null, installed: null });
      continue;
    }
    const shipped = f.render(tpl, values);
    const installed = await read(at(f.installed));
    const plan = planSystemFile({ installed, shipped });
    results.push({ f, ...plan, shipped, installed });
  }

  for (const r of results) {
    if (r.state === "no-template") { console.log(`? ${r.f.name}: ${r.f.template} is missing from this checkout`); continue; }
    if (r.state === "absent") {
      console.log(`- ${r.f.name}: not installed at ${r.f.installed}`
        + (r.f.optional ? " (optional; declining it is a supported answer)" : ""));
      continue;
    }
    if (r.state === "same") { console.log(`= ${r.f.name}: matches`); continue; }
    console.log(`≠ ${r.f.name}: ${r.f.installed} differs from ${r.f.template}`);
    const diff = unified(r.installed, r.shipped, r.f.name);
    for (const line of (SHOW_DIFF ? diff : diff.slice(0, 14))) console.log("    " + line);
    if (!SHOW_DIFF && diff.length > 14) console.log(`    … ${diff.length - 14} more lines (--diff for all)`);
  }

  const changed = results.filter((r) => r.changed);
  if (!changed.length) {
    console.log("\nNothing to do: every installed file matches what this checkout ships.");
    process.exit(0);
  }
  console.log(`\n${changed.length} file${changed.length === 1 ? "" : "s"} differ.`);
  console.log("Read the diffs above before applying. A difference is not automatically drift:");
  console.log("anything you changed by hand that the renderers do not own will show here too,");
  console.log("and applying would discard it.");
  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write these, after which it will ask again.");
    process.exit(1);
  }
  if (!(await confirm("\nOverwrite the installed files with the rendered templates?"))) {
    console.log("Nothing written.");
    process.exit(1);
  }

  // Back the current file up before overwriting. The installed unit is the only
  // copy of the operator's configuration on the machine, and this tool exists
  // partly because that configuration was never recorded anywhere else.
  //
  // Not beside the original. systemd ignores a file that does not end in a unit
  // suffix, so a .bak in /etc/systemd/system is inert, but they accumulate one
  // set per run in a directory an operator reads when something is wrong, and a
  // directory full of near-identical units is a poor place to be reading under
  // pressure. /var/backups is where a Debian or Ubuntu system already keeps
  // this kind of thing.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = at(`/var/backups/dojobay/system-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  const kinds = new Set();
  const units = new Set();
  for (const r of changed) {
    const dest = at(r.f.installed);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(dest, path.join(backupDir, path.basename(dest)));
    await writeFile(dest, r.shipped);
    kinds.add(r.f.after);
    if (/\.(service|timer)$/.test(r.f.installed)) units.add(path.basename(r.f.installed));
    console.log(`wrote ${r.f.installed}`);
  }
  console.log(`previous copies kept in ${backupDir}`);

  // With --root the files just written are not the ones the machine is running
  // from, so reloading the real systemd or nginx would act on state this run
  // never touched. Refuse rather than do something almost right.
  if (ROOT_PREFIX) {
    console.log(`\n--root given, so nothing was reloaded: these files are under ${ROOT_PREFIX}, not /etc.`);
    process.exit(0);
  }

  // Each post-step is reported on its own. A failed daemon-reload must not
  // stop nginx being validated: the files are already written, and the state
  // that needs reporting is the one on disk, not the one this run intended.
  if (kinds.has("systemd")) {
    try {
      await execFileP("systemctl", ["daemon-reload"]);
      console.log("systemctl daemon-reload");
    } catch (e) {
      console.log("✗ systemctl daemon-reload failed: " + String(e.stderr || e.message).trim());
      console.log("  the unit files are written; systemd has not read them yet");
    }

    // A timer whose file changed keeps its old schedule until it is restarted,
    // and daemon-reload does not do that. Nothing about the machine would look
    // wrong: the timer is enabled, the unit on disk is correct, and the
    // schedule being enforced is the previous one. So it is restarted here
    // rather than added to a list of things for somebody to remember.
    //
    // The cost is one immediate run, because OnBootSec is in the past on a
    // machine that has been up a while, so the timer fires as soon as it is
    // restarted. That is a probe cycle happening a few minutes early, which is
    // cheaper than a schedule that silently did not take.
    const timers = [...units].filter((u) => u.endsWith(".timer"));
    for (const t of timers) {
      try {
        await execFileP("systemctl", ["restart", t]);
        console.log(`systemctl restart ${t}  (its schedule would otherwise still be the old one)`);
        // And prove the schedule took. A timer with no next elapse is the
        // failure this project has already paid for: it looks enabled and
        // never fires again.
        const { stdout } = await execFileP("systemctl", ["show", t, "-p", "NextElapseUSecRealtime",
          "-p", "NextElapseUSecMonotonic", "--value"]);
        const elapse = stdout.split("\n").map((l) => l.trim()).filter(Boolean)
          .filter((v) => v && v !== "0" && v !== "n/a");
        if (elapse.length) console.log(`  next elapse ${elapse[0]}`);
        else {
          console.log(`  ✗ ${t} has NO next elapse. It is loaded and will never fire.`);
          console.log(`    systemctl list-timers ${t}   and check the schedule directives`);
        }
      } catch (e) {
        console.log(`✗ could not restart ${t}: ` + String(e.stderr || e.message).trim());
      }
    }

    // Everything else that changed and is still running the old file. Named
    // individually, because "restart the service" was only ever right when the
    // backend was the only unit this tool touched.
    const services = [...units].filter((u) => u.endsWith(".service") && !u.includes("update"));
    if (services.length) {
      console.log(`! still running the old unit: ${services.join(", ")}`);
      console.log(`  restart when it suits you:  systemctl restart ${services.join(" ")}`);
    }
    // The updater's own service unit needs no restart: it is oneshot and the
    // timer starts a fresh one each cycle, which will pick up the new file.
    if ([...units].some((u) => u === "dojobay-update.service")) {
      console.log("  (dojobay-update.service is oneshot; its next run uses the new file)");
    }
  }
  if (kinds.has("nginx")) {
    // Validate before reloading, always. A bad site file that is only found at
    // reload takes the directory offline, and the whole point of this tool is
    // to stop system files failing quietly.
    try {
      await execFileP("nginx", ["-t"]);
    } catch (e) {
      console.log("✗ nginx -t rejected the new site file. NOT reloading.");
      console.log(String(e.stderr || e.message).trim());
      console.log(`  the previous file is beside it as .${stamp}.bak; restore it and re-run nginx -t`);
      process.exit(2);
    }
    await execFileP("systemctl", ["reload", "nginx"]);
    console.log("nginx -t passed, nginx reloaded");
  }
  if (kinds.has("polkit")) {
    console.log("polkit reloads rules by itself; check journalctl -u polkit if a restart is still refused");
  }
  process.exit(0);
}

main().catch((e) => { console.error(e.message); process.exit(2); });
