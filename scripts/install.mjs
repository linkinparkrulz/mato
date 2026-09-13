#!/usr/bin/env node
// The Dojo Bay guided installer.
//
//   sudo node scripts/install.mjs
//
// A guided sequential flow: one question at a time, scrolling, so the whole
// transcript survives in the scrollback when something goes wrong on a machine
// somebody is configuring once. Stage logic is UI-independent and talks to
// scripts/installer-ui.mjs.
//
// There was a full-screen TUI, chosen by default on any terminal that looked
// capable. It is parked rather than removed (scripts/tui.mjs, still self-tested)
// because the idea is worth returning to, but nothing routes to it: a
// full-screen program clears away the output that would explain a failure, and
// it is the path on which nobody has completed an install. --plain used to
// select this flow and is still accepted, so existing scripts do not break.
//
// The flow: prerequisites -> backend deps -> identity -> hidden service
// (fresh, or an imported vanity key) -> the REQUIRED operator signature ->
// the anchor node (live-probed over Tor before acceptance) -> optional
// bootstrap import from a trusted instance (signature-gated) -> review ->
// apply. Re-runnable; instance data is never touched by a re-run.
import { readFile, writeFile, mkdir, stat, copyFile, chmod } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPaymentCode, isOnionHost, onionHostOf, isNodeName, parsePairing,
  operatorMessage, mergeTorrc, renderServerUnit, renderUpdateUnit, renderNginx, SERVICE_USER,
  renderPolkitRule, POLKIT_RULE_PATH, SYSTEMD_MANAGE_UNITS,
  anchorSeed, operatorDoc, countryFor,
} from "./installer-lib.mjs";
import { chooseUI } from "./installer-ui.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Thrown by the probe step when the node answers but is too old. Distinguished
// from an unreachable node because the two need opposite offers: a bad payload
// is re-pasted, an old Dojo is upgraded and re-probed with the same payload.
class VersionTooOld extends Error {
  constructor(message, version) { super(message); this.name = "VersionTooOld"; this.version = version; }
}

// Long canonical JSON, wrapped for the note pane and indented like the operator
// message in step 5, so the two signing prompts look the same. Wrapping is
// display only: the paste is checked against the unwrapped text.
function wrapForNote(text, width = 64) {
  const lines = [];
  for (let i = 0; i < text.length; i += width) lines.push("    " + text.slice(i, i + width));
  return lines.join("\n");
}

const TOTAL = 9;

async function main() {
  if (!process.stdin.isTTY) {
    console.error("The installer is interactive; run it in a terminal (over SSH is fine).");
    process.exit(1);
  }
  const ui = chooseUI();
  if (process.getuid && process.getuid() !== 0) {
    await ui.fail("Run as root: the installer writes torrc, an nginx site and systemd units.\n  sudo node scripts/install.mjs");
  }

  // ---- 1. prerequisites -------------------------------------------------------
  await ui.step(1, TOTAL, "Prerequisites");
  const nodeMajor = +process.versions.node.split(".")[0];
  if (nodeMajor < 24) await ui.fail(`Node ${process.versions.node} found; Node 24+ is required (the BIP47/Auth47 libraries require it).`);
  ui.ok(`Node ${process.versions.node}`);
  const missing = [];
  for (const bin of ["tor", "nginx"]) {
    try { await run("sh", ["-c", `command -v ${bin}`]); ui.ok(bin); }
    catch { missing.push(bin); ui.err(`${bin} not found`); }
  }
  if (missing.length) {
    if (!(await ui.confirm(`Install ${missing.join(" + ")} with apt now?`, true))) {
      await ui.fail("Cannot continue without " + missing.join(" and ") + ".");
    }
    await ui.progress("installing packages", async (log) => {
      log("apt-get update"); await run("apt-get", ["update"]);
      log("apt-get install -y " + missing.join(" ")); await run("apt-get", ["install", "-y", ...missing]);
      log("installed ✓");
    });
  }
  const { webRoot } = await ui.form([
    { key: "webRoot", label: "Web root", type: "text", value: "/var/www/dojobay",
      hint: "where the site lives", validate: (v) => v.startsWith("/") || "must be an absolute path" },
  ]);

  // ---- 2. backend dependencies ---------------------------------------------------
  await ui.step(2, TOTAL, "Backend dependencies");
  await ui.progress("npm ci in server/ (needed for signature verification)", async (log) => {
    await run("npm", ["ci", "--omit=dev"], { cwd: path.join(ROOT, "server") });
    log("server dependencies installed ✓");
  });
  const crypto = await import("../server/crypto.ts");
  const { canonicalPairing } = crypto;
  // Read once, from the same module the submission gates read it from, so the
  // installer cannot drift to a different minimum than the instance enforces.
  const { MIN_DOJO_VERSION } = await import("../server/dojo-version.ts");

  // ---- 3. identity -----------------------------------------------------------------
  await ui.step(3, TOTAL, "Your identity");
  const id = await ui.form([
    { key: "paymentCode", label: "Your BIP47 payment code (PM8T…)", type: "text",
      hint: "Samourai/Ashigaru → PayNym. This code becomes this instance's admin.",
      validate: (v) => isPaymentCode(v) || "not a valid BIP47 payment code (PM8T…, 116 base58 chars)" },
    { key: "paynym", label: "Your PayNym handle (+name, optional)", type: "text",
      hint: "leave empty to skip; it can be resolved later" },
  ], { note: "No accounts and no email: your payment code is your identity here." });
  const paymentCode = id.paymentCode;
  const paynym = id.paynym ? (id.paynym.startsWith("+") ? id.paynym : "+" + id.paynym) : "";

  // ---- 4. hidden service ---------------------------------------------------------
  await ui.step(4, TOTAL, "Hidden service");
  const hsDir = "/var/lib/tor/dojobay";
  if (await ui.confirm("Import an existing .onion key (e.g. a vanity address)?", false)) {
    const { keyPath } = await ui.form([
      { key: "keyPath", label: "Path to hs_ed25519_secret_key (or its directory)", type: "text",
        validate: (v) => v.startsWith("/") || "must be an absolute path" },
    ], { note: "Only the key is imported here; generating vanity keys is out of scope." });
    let src = keyPath;
    try { if ((await stat(keyPath)).isDirectory()) src = path.join(keyPath, "hs_ed25519_secret_key"); } catch {}
    const keyBuf = await readFile(src).catch(() => null);
    if (!keyBuf || keyBuf.length !== 96 || !keyBuf.subarray(0, 29).toString("latin1").startsWith("== ed25519v1-secret")) {
      await ui.fail("That is not a Tor v3 hidden-service secret key (expected 96 bytes, ed25519v1-secret header).");
    }
    await mkdir(hsDir, { recursive: true });
    await copyFile(src, path.join(hsDir, "hs_ed25519_secret_key"));
    await run("chown", ["-R", "debian-tor:debian-tor", hsDir]);
    await chmod(hsDir, 0o700);
    await chmod(path.join(hsDir, "hs_ed25519_secret_key"), 0o600);
    ui.ok("vanity key installed (tor derives the hostname)");
  }
  const onionHost = await ui.progress("configuring tor and waiting for the hidden service", async (log) => {
    const torrcPath = "/etc/tor/torrc";
    const torrc = await readFile(torrcPath, "utf8").catch(() => "");
    await writeFile(torrcPath, mergeTorrc(torrc, hsDir));
    log("torrc updated (managed block)");
    await run("systemctl", ["restart", "tor"]);
    log("tor restarted; waiting for hostname…");
    for (let i = 0; i < 30; i++) {
      const h = (await readFile(path.join(hsDir, "hostname"), "utf8").catch(() => "")).trim();
      if (isOnionHost(h)) { log("hostname: " + h); return h; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("tor did not produce a hostname; check journalctl -u tor");
  });

  // ---- 5. operator signature (required) --------------------------------------------
  await ui.step(5, TOTAL, "Operator signature (required)");
  const message = operatorMessage(onionHost, paymentCode);
  let opDoc;
  for (;;) {
    const block = await ui.paste("Signed block", {
      endMarker: "-----END BITCOIN SIGNATURE-----",
      note: "Sign this EXACT text in your wallet under PayNym → Sign message:\n\n"
        + message.split("\n").map((l) => "    " + l).join("\n")
        + "\n\nIt must be signed under PayNym → Sign message, which uses your"
        + "\nPayNym's notification address. Tools → Sign message signs with a"
        + "\nwallet address instead and will not verify."
        + "\n\nThen paste the full signed block below, including its own"
        + "\n-----END BITCOIN SIGNATURE----- line. It finishes as soon as it"
        + "\nsees that line, so there is nothing to type afterwards.",
    });
    opDoc = operatorDoc(onionHost, paymentCode, block.trim(), paynym || null);
    const v = crypto.verifyOperatorDoc(opDoc, { expectedOnion: `http://${onionHost}` });
    if (v.ok) { ui.ok("signature verifies against your payment code's notification address"); break; }
    ui.err(v.error);
    if (!(await ui.confirm("Try pasting the signed block again?", true))) {
      await ui.fail("The operator signature is required; cannot continue without it.");
    }
  }

  // ---- 6. anchor node ------------------------------------------------------------------
  await ui.step(6, TOTAL, "Your Dojo (the anchor node)");
  const anchor = await ui.form([
    { key: "network", label: "Network", type: "toggle", options: ["mainnet", "testnet"], value: 0 },
    { key: "name", label: "Node name", type: "text",
      validate: (v) => isNodeName(v) || "letters/digits (≤40 chars)" },
    { key: "jurisdiction", label: "Where is it? (optional)", type: "text",
      // One free-text question, and a flag appears on the card if what you wrote
      // names somewhere the runtime recognises. Nothing is enforced: "Europe" or
      // "Ancapistan" are perfectly good answers that simply get no flag. There
      // is no separate code field because asking twice for one fact, and
      // validating the second, was more ceremony than a flag is worth.
      hint: "e.g. Finland, Helsinki FI, Europe \u2014 a country gets you a flag" },
    { key: "hardware", label: "Hardware (optional)", type: "text", hint: "e.g. N100 16GB" },
  ], { note: "Running a Dojo Bay requires running a Dojo. This node seeds your directory." });
  let payload;
  // Two loops, because a bad payload and an old Dojo need different offers. A
  // payload that will not parse, or a node that does not answer, means pasting
  // again. A node that answers and is simply too old means going away, upgrading
  // it, and probing the SAME payload again: asking the operator to re-paste
  // unchanged JSON after a Dojo upgrade would be busywork with a chance of
  // introducing a typo.
  paste: for (;;) {
    const parsed = parsePairing(await ui.paste("Dojo pairing payload", {
      note: `The JSON from your Dojo maintenance tool (pairing + explorer).\n`
        + `You chose ${anchor.network}, so the URL should look like `
        + (anchor.network === "testnet" ? "http://<onion>/test/v2" : "http://<onion>/v2") + ".",
    }), { network: anchor.network });
    if (!parsed.ok) { ui.err(parsed.error); continue; }
    for (;;) {
      try {
        payload = await ui.progress("probing your Dojo over Tor", async (log) => {
          const { probe, PROBE_CFG } = await import("../server/probe.mjs");
          const { judgeVersion } = await import("../server/dojo-version.ts");
          log("connecting to " + parsed.payload.pairing.url.slice(0, 46) + "…");
          // PROBE_CFG carries the Tor SOCKS host, port and timeout; without it
          // the probe has no proxy to dial. Every other call site spreads it too.
          const check = await probe(parsed.payload.pairing.url, {
            ...PROBE_CFG, apikey: parsed.payload.pairing.apikey, network: anchor.network,
          });
          if (!check.up) throw new Error(check.reason || "no response");
          log(`reachable ✓  block height ${check.height ?? "?"}`);

          // The same judgement a submitted listing gets, from the same function,
          // so an instance cannot hold itself to a lower standard than the
          // listings it will publish. The detected version wins over the one
          // declared in the payload for the reason dojo-version.ts gives: the
          // declared one is frozen when the payload is generated and is
          // routinely stale.
          const v = judgeVersion(check.detectedVersion, parsed.payload.pairing?.version, MIN_DOJO_VERSION);
          if (!v.ok) throw new VersionTooOld(v.reason, v.version);
          log(`Dojo ${v.version} ✓  (minimum ${MIN_DOJO_VERSION}${v.source === "declared" ? ", read from the payload" : ""})`);
          return parsed.payload;
        });
        break paste;
      } catch (e) {
        if (e instanceof VersionTooOld) {
          // The installer cannot upgrade a Dojo, and it should not work around
          // one either: this instance would be publishing a node it would refuse
          // from anybody else. Leave the prompt open, let them upgrade in
          // another terminal, and re-probe on the same payload.
          ui.err(e.message);
          if (await ui.confirm("Upgrade your Dojo now, then re-test the connection?", true)) continue;
          await ui.fail(`Your Dojo must be ${MIN_DOJO_VERSION} or newer to seed a directory `
            + "that requires the same of everybody else.");
        }
        ui.err("not reachable: " + e.message);
        if (!(await ui.confirm("Edit the payload and try again?", true))) process.exit(1);
        continue paste;
      }
    }
  }

  // ---- 6b. anchor signature (required) ------------------------------------------
  // The anchor is a listing, and every listing must carry a signature over its
  // pairing payload. Without one the rebuild withholds it, so an instance
  // installed before this step existed came up with an empty directory and no
  // explanation. Signed here, against the same canonical text and the same
  // notification addresses the submission gate uses, so the anchor is checkable
  // by a visitor on the first page load rather than after a round trip through
  // Manage my Dojo.
  const pairingText = canonicalPairing(payload);
  let anchorSigned;
  for (;;) {
    const block = await ui.paste("Signed pairing payload", {
      endMarker: "-----END BITCOIN SIGNATURE-----",
      note: "Now sign your pairing payload, the same way you signed your onion\n"
        + "address in step 5. Sign this EXACT text under PayNym \u2192 Sign message,\n"
        + "including the blank line and the BIP47 line at the end:\n\n"
        + wrapForNote(pairingText)
        + "\n\n    BIP47:\n" + wrapForNote(paymentCode)
        + "\n\nThe BIP47 line is required, not decoration. It is what makes the\n"
        + "block you publish self-contained: a reader pastes it into a verifier\n"
        + "and gets your payment code back, instead of having to be told\n"
        + "separately which code to check it against. A block without it will\n"
        + "be refused here even if the signature itself is good.\n\n"
        + "Then paste the whole signed block below, including its own\n"
        + "-----END BITCOIN SIGNATURE----- line.",
    });
    // Same repair the web form applies: a paste through a terminal or a chat
    // window loses the blank line before the BIP47 line, which the signature
    // covers. A reconstruction is only accepted if it verifies.
    const repaired = crypto.repairSignedBlock(block.trim());
    const candidate = repaired ? repaired.block : block.trim();
    const sig = crypto.verifySignedPayload({
      signedText: candidate,
      expectedMessage: pairingText,
      // A PayNym signs from its mainnet notification address even for a testnet
      // node, so both derivations are acceptable. Same rule as the gate.
      expectedAddress: crypto.notificationAddresses(paymentCode),
      network: anchor.network === "testnet" ? "testnet" : "bitcoin",
    });
    // The signature verifying is necessary and not sufficient. verifySignedPayload
    // only checks a BIP47 line when one is present, because the submission gate
    // has an authenticated session and supplies the code itself. Here there is
    // no session, and more to the point this block is about to be published: a
    // reader with a verifier needs the payment code inside the message, or they
    // are trusting this site to tell them which code to check it against, which
    // is the one thing the signature exists to avoid.
    if (sig.ok && !sig.paymentCode) {
      ui.err("that block verifies, but it carries no BIP47 line. Sign the payload again "
        + "with a blank line, then BIP47:, then your payment code, so a reader can check "
        + "it without being told your code separately.");
    } else if (sig.ok && String(sig.paymentCode).trim() !== paymentCode.trim()) {
      ui.err("the BIP47 line inside the signed block is a different payment code from the "
        + "one you gave in step 3.");
    } else if (sig.ok) {
      anchorSigned = candidate;
      ui.ok("pairing payload signed by your payment code, BIP47 line included"
        + (repaired?.note ? ` (${repaired.note})` : ""));
      break;
    } else {
      ui.err(sig.error);
    }
    if (!(await ui.confirm("Try pasting the signed block again?", true))) {
      await ui.fail("Every listing needs a signed pairing payload, including your own; "
        + "without one your directory would publish nothing.");
    }
  }

  // ---- 7. bootstrap import -----------------------------------------------------------
  let timerUnarmed = false;
  let polkitUnverified = false;
  await ui.step(7, TOTAL, "Bootstrap from a trusted Dojo Bay (optional)");
  let bootstrap = null;
  if (await ui.confirm("Import nodes + history from an existing instance you trust?", false)) {
    const b = await ui.form([
      { key: "onion", label: "Trusted instance .onion", type: "text",
        validate: (v) => isOnionHost(v) || "not a v3 onion address" },
      { key: "code", label: "That operator's BIP47 payment code", type: "text",
        hint: "from their footer chip or Verify popup; their signature is verified against it",
        validate: (v) => isPaymentCode(v) || "not a valid payment code" },
    ], { note: "Nothing is imported unless the remote operator.json signature verifies for exactly this onion and code." });
    bootstrap = { onionHost: onionHostOf(b.onion), trustedCode: b.code };
  }

  // ---- 8. review + apply ------------------------------------------------------------------
  // 8) Permission for self-update's last step.
  //
  // Asked rather than assumed, and asked here rather than granted quietly in
  // the write phase, because granting an account the standing right to restart
  // a service is a decision an operator should make with the rule in front of
  // them. Declining is a supported answer: updating by hand still works, and
  // the console tells them what is missing when they come to use the button.
  //
  // Nothing is written yet. The file goes down in the write phase with the
  // other /etc files, so a declined "write configuration" leaves nothing behind.
  await ui.step(8, TOTAL, "Self-update permission (optional)");
  const polkitTplPath = path.join(ROOT, "deploy/polkit-restart.rules.example");
  const polkitRule = renderPolkitRule(await readFile(polkitTplPath, "utf8"), { user: SERVICE_USER });
  // polkit has to be installed AND running for a rule file to mean anything. A
  // rule written into a directory nothing reads is the exact failure this
  // project keeps producing: an operation that appears to succeed because the
  // thing that would report it is not the thing anybody is looking at.
  const polkitActive = await run("systemctl", ["is-active", "--quiet", "polkit.service"])
    .then(() => true, () => false);
  let wantPolkit = false;
  if (!polkitActive) {
    await ui.show("polkit is not running on this machine", [
      "Self-update's last step restarts the service, and systemd asks polkit",
      `whether ${SERVICE_USER} may do that. With no polkit there is nobody to ask,`,
      "so an update would install the new code and leave the old process serving",
      "it. Nothing is written here: install polkit (apt install polkitd) and",
      `copy deploy/polkit-restart.rules.example to`,
      `  ${POLKIT_RULE_PATH}`,
      "or update by hand and restart the service yourself.",
    ]);
  } else {
    await ui.show("Self-update ends by restarting the service", [
      `Granting ${SERVICE_USER} permission to do that, and nothing else:`,
      "",
      ...polkitRule.split("\n").filter((l) => l && !l.startsWith("//")).map((l) => "  " + l),
      "",
      `This permits restart of dojobay-server.service by ${SERVICE_USER}, with no`,
      "password. It does not permit stop, start, enable, mask, or any other unit,",
      "and it does not weaken the distribution's own defaults.",
      "",
      "Decline and everything else still works: self-update will install code and",
      "leave the old process running, which the admin console checks for and says",
      `so before offering the button. You can add ${POLKIT_RULE_PATH} later.`,
    ]);
    wantPolkit = await ui.confirm(`Grant ${SERVICE_USER} permission to restart its own service?`, true);
  }

  await ui.step(9, TOTAL, "Review");
  await ui.show("About to write", [
    `onion       http://${onionHost}/`,
    `admin code  ${paymentCode.slice(0, 12)}…${paymentCode.slice(-6)}  ${paynym}`,
    `anchor      ${anchor.network}-${anchor.name}`,
    `web root    ${webRoot}`,
    `bootstrap   ${bootstrap ? bootstrap.onionHost : "none"}`,
    `restart     ${wantPolkit ? `${SERVICE_USER} may restart its own service (polkit rule)`
      : polkitActive ? "declined; self-update will need a manual restart"
      : "no polkit on this machine; self-update will need a manual restart"}`,
  ]);
  if (!(await ui.confirm("Write configuration and start services?", true))) {
    await ui.fail("Nothing written.");
  }
  await ui.progress("installing", async (log) => {
    if (path.resolve(webRoot) !== ROOT) {
      await mkdir(webRoot, { recursive: true });
      await run("cp", ["-a", ROOT + "/.", webRoot]);
      log("files copied to " + webRoot);
    }
    const dataDir = path.join(webRoot, "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "seed.json"), JSON.stringify(anchorSeed({
      network: anchor.network, name: anchor.name, paymentCode, paynym: paynym || null,
      payload, signed: anchorSigned, jurisdiction: anchor.jurisdiction,
      country: countryFor(anchor.jurisdiction), hardware: anchor.hardware,
    }), null, 2) + "\n");
    await writeFile(path.join(dataDir, "operator.json"), JSON.stringify(opDoc, null, 2) + "\n");
    log("seed.json (anchor) + operator.json written");

    // The account the services run as, created before the units that name it.
    // A system account with no login and no home: it needs to read the code and
    // write under data/, and nothing else.
    const haveUser = await run("id", ["-u", SERVICE_USER]).then(() => true, () => false);
    if (!haveUser) {
      await run("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", SERVICE_USER]);
      log(`created service account ${SERVICE_USER}`);
    } else {
      log(`service account ${SERVICE_USER} already exists`);
    }
    const nginxTpl = await readFile(path.join(webRoot, "deploy/nginx-onion.conf.example"), "utf8");
    await writeFile("/etc/nginx/sites-available/dojobay", renderNginx(nginxTpl, { webRoot }));
    await run("ln", ["-sf", "/etc/nginx/sites-available/dojobay", "/etc/nginx/sites-enabled/dojobay"]);
    const srvTpl = await readFile(path.join(webRoot, "scripts/dojobay-server.service"), "utf8");
    await writeFile("/etc/systemd/system/dojobay-server.service",
      renderServerUnit(srvTpl, { webRoot, baseUrl: `http://${onionHost}`, adminCode: paymentCode }));
    const updTpl = await readFile(path.join(webRoot, "scripts/dojobay-update.service"), "utf8");
    await writeFile("/etc/systemd/system/dojobay-update.service", renderUpdateUnit(updTpl, { webRoot }));
    await copyFile(path.join(webRoot, "scripts/dojobay-update.timer"), "/etc/systemd/system/dojobay-update.timer");
    await run("systemctl", ["daemon-reload"]);
    log("nginx site + systemd units installed");

    // The polkit rule, if it was agreed to in step 8. 0644 because polkitd
    // reads it as a distinct user; the directory is root-owned, which is what
    // stops anyone else writing there.
    if (wantPolkit) {
      await mkdir(path.dirname(POLKIT_RULE_PATH), { recursive: true });
      await writeFile(POLKIT_RULE_PATH, polkitRule);
      await chmod(POLKIT_RULE_PATH, 0o644);
      log(`restart permission written to ${POLKIT_RULE_PATH}`);
      // And prove it took, the same way the ownership and timer checks do.
      //
      // This has to be asked from ROOT, which the installer is and the backend
      // is not. polkit refuses a details-bearing CheckAuthorization() from any
      // caller that is not uid 0 or the action's owner, and the rule keys on
      // the unit and the verb, so a query without details cannot match. That is
      // why the console no longer makes this claim at all and why the installer
      // still can.
      //
      // The subject has to be a process belonging to the service account, so
      // one is started for a few seconds and asked about: `sh -c` prints its own
      // pid and then becomes the sleep, so the pid stays valid for the query.
      let holder = null;
      try {
        holder = spawn("sudo", ["-u", SERVICE_USER, "sh", "-c", "echo $$; exec sleep 10"],
          { stdio: ["ignore", "pipe", "ignore"] });
        const pid = await new Promise((resolve, reject) => {
          let buf = "";
          const t = setTimeout(() => reject(new Error("no pid from the holder process")), 5000);
          holder.stdout.on("data", (d) => {
            buf += d.toString();
            if (buf.includes("\n")) { clearTimeout(t); resolve(buf.trim().split("\n")[0]); }
          });
          holder.on("error", (e) => { clearTimeout(t); reject(e); });
        });
        await run("pkcheck", ["--action-id", SYSTEMD_MANAGE_UNITS, "--process", pid,
          "--detail", "unit", "dojobay-server.service", "--detail", "verb", "restart"]);
        log(`${SERVICE_USER} can restart dojobay-server.service; self-update can complete`);
      } catch (e) {
        // Exit 1, 2 and 3 are answers about authorisation; anything else is
        // pkcheck unable to ask, which says nothing about the rule.
        if ([1, 2, 3].includes(e.code)) {
          polkitUnverified = true;
          log("✗ the rule was written but polkit refuses the restart");
          log(`  the rule is at ${POLKIT_RULE_PATH}; check the account inside it reads ${SERVICE_USER}:`);
          log(`  sudo grep subject.user ${POLKIT_RULE_PATH}`);
          log(`  and whether polkitd rejected the file when it reloaded:`);
          log(`  sudo journalctl -u polkit --since '5 min ago'`);
          log(`  self-update will install code and leave the old process running until this is fixed.`);
          log(`  Updating by hand still works; restart the service yourself afterwards.`);
        } else {
          log(`! rule written, but it could not be verified here (${e.message}).`);
          log(`  That is pkcheck being unable to ask rather than an answer about the rule.`);
          log(`  Test it directly when convenient, which restarts the service:`);
          log(`  sudo -u ${SERVICE_USER} systemctl restart dojobay-server.service`);
        }
      } finally {
        try { holder?.kill(); } catch { /* already gone */ }
      }
    }

    if (bootstrap) {
      log("verifying trusted instance and importing (over Tor)…");
      process.env.PUBLIC_DATA_DIR = dataDir;
      process.env.SERVER_DATA_DIR = path.join(webRoot, "server", "data");
      const { bootstrapImport } = await import(path.join(webRoot, "scripts/bootstrap-import.mjs"));
      try { await bootstrapImport({ ...bootstrap, log }); }
      catch (e) { log("✗ bootstrap import failed: " + e.message); log("  (continuing; re-run scripts/bootstrap-import.mjs later)"); }
    }

    await run("node", ["build-public.mjs"], { cwd: path.join(webRoot, "server"), env: { ...process.env } });
    await run("node", [path.join(webRoot, "scripts/pack-source.mjs")]);
    log("public list built; source archive packed");

    // Ownership of the whole tree, and it has to happen HERE, after everything
    // this installer writes and not before.
    //
    // It used to run before the bootstrap import, the public build and the
    // source pack. All three of those write as root, because the installer runs
    // under sudo and the import runs in-process, and two of them write by
    // rename, so they produce new root-owned files even where a chowned one
    // stood. The service account then could not write data/dojos.json, the
    // history files or data/avatars, so the first probe cycle failed with
    // permission denied and the timer failed the same way every ten minutes
    // afterwards. Nothing announced it: nginx serves the directory as static
    // files whether or not anything behind it is alive, so the site came up
    // looking finished while the updater had never once run. What an operator
    // saw was a list of Dojos with no block heights, no avatars and no probe
    // results, and no reason given.
    //
    // Ownership of the whole tree rather than data/ alone: the backend writes
    // the store, the updater writes the published list and the avatars, and a
    // self-update replaces the code in place.
    await run("chown", ["-R", `${SERVICE_USER}:${SERVICE_USER}`, webRoot]);

    // And prove it took, rather than assuming. This is the check that would
    // have turned a silent non-polling instance into a sentence at install
    // time, so it is worth the two seconds: write and delete a file in each
    // directory the updater has to write, as the account the updater will be.
    const mustWrite = [dataDir, path.join(dataDir, "avatars"), path.join(webRoot, "server", "data")];
    const unwritable = [];
    for (const dir of mustWrite) {
      await run("install", ["-d", "-o", SERVICE_USER, "-g", SERVICE_USER, dir]).catch(() => {});
      const probe = path.join(dir, ".installer-write-check");
      const ok = await run("sudo", ["-u", SERVICE_USER, "touch", probe]).then(() => true, () => false);
      await run("rm", ["-f", probe]).catch(() => {});
      if (!ok) unwritable.push(dir);
    }
    if (unwritable.length) {
      await ui.fail(`${SERVICE_USER} cannot write to ${unwritable.join(", ")}. `
        + "The instance would serve its list and never poll: no statuses, no block heights, "
        + `no avatars. Fix the ownership (chown -R ${SERVICE_USER}:${SERVICE_USER} ${webRoot}) and re-run.`);
    }
    log(`${SERVICE_USER} can write everywhere the updater needs to`);
    // Clear any failed state first. Reinstalling over a broken install leaves
    // the old units in `failed`, and a failed oneshot does not re-arm its timer,
    // so a corrected install could still never poll.
    await run("systemctl", ["reset-failed", "dojobay-server.service",
      "dojobay-update.service", "dojobay-update.timer"]).catch(() => {});
    // The TIMER is deliberately not started yet. Enabling it with --now fires a
    // catch-up run at once, because its schedule is a calendar one with
    // Persistent=true, and that ran headlong into the installer's own first
    // probe cycle below: two updaters writing the same file, one of them
    // failing, and an install ending with warnings about a directory that was
    // already perfectly up to date. Enabled for boot here, started after the
    // first cycle has finished.
    await run("systemctl", ["enable", "dojobay-update.timer"]);
    await run("systemctl", ["enable", "--now", "nginx", "dojobay-server.service"]);
    await run("systemctl", ["restart", "nginx", "dojobay-server.service"]);
    log("services enabled and started");

    // One probe cycle now, rather than leaving the first one to the timer.
    //
    // The timer's first run is relative to boot, so on a machine that has been
    // up a while it fires promptly, and on one that has just booted it does not.
    // Either way an operator finishing an install looks at their directory
    // immediately, and what they saw was whatever the bootstrap import carried
    // over: statuses from another instance's last cycle, no block heights, and
    // no avatars, because none of those exist until something probes. Running it
    // here means the first page they load is their own instance's work.
    //
    // Run as the service account so nothing it writes is owned by root, and
    // failure is reported rather than fatal: the units are installed, the timer
    // will come round, and an unreachable Tor at this exact moment should not
    // undo an otherwise complete install.
    log("running the first probe cycle over Tor (this takes a minute)…");
    try {
      await run("sudo", ["-u", SERVICE_USER, "node", path.join(webRoot, "scripts", "update.mjs")],
        { cwd: webRoot });
      log("first probe cycle complete: statuses, block heights and avatars are your own");
    } catch (e) {
      // Non-fatal, and it is worth being clear why that is defensible now and
      // was not before. The writability check above has already ruled out the
      // failure that never recovers; what is left is Tor being slow or a node
      // being down at this exact moment, which the timer genuinely will fix.
      log("✗ first probe cycle failed: " + e.message);
      log("  ownership is correct, so this is most likely Tor or an unreachable node,");
      log("  and the timer will retry within ten minutes. To run it by hand:");
      log(`  sudo -u ${SERVICE_USER} node ${path.join(webRoot, "scripts", "update.mjs")}`);
    }

    // Now the timer, with the first cycle out of the way and nothing for its
    // catch-up run to collide with.
    await run("systemctl", ["start", "dojobay-update.timer"]);

    // Prove the timer is actually scheduled, the same way the ownership check
    // proves the chown took. An enabled timer with no next elapse is exactly the
    // failure this install is meant to rule out: the site serves its list, looks
    // finished, and never updates again. Checked after the first probe cycle
    // because a schedule relative to the last run has nothing to work from until
    // one has happened.
    const next = await run("systemctl", ["show", "dojobay-update.timer",
      "-p", "NextElapseUSecRealtime", "--value"]).then((r) => String(r.stdout || "").trim(), () => "");
    if (!next || next === "0" || /^n\/a$/i.test(next)) {
      timerUnarmed = true;
      log("✗ the update timer is enabled but has no next run scheduled");
      log("  your directory would serve its list and never refresh it. To fix:");
      log("  sudo systemctl reset-failed dojobay-update.service dojobay-update.timer");
      log("  sudo systemctl start dojobay-update.service");
      log("  systemctl list-timers dojobay-update.timer");
    } else {
      log(`update timer armed; next run ${next}`);
    }
  });

  await ui.finish([
    ...(polkitUnverified
      ? ["!! the restart permission was written but polkit still refuses it — self-update",
         "   will install code and leave the old process running until that is fixed"]
      : []),
    ...(timerUnarmed
      ? ["!! the update timer has no next run scheduled — see the note above, or this",
         "   instance will serve its list and never refresh it"]
      : []),
    `Your Dojo Bay is live at http://${onionHost}/`,
    "· sign in at /admin with your PayNym (Auth47) to moderate",
    "· the ten-minute timer keeps statuses, history and avatars current",
    "· the footer's branch icon serves this instance's own source zip",
  ]);
}

main().catch((e) => { console.error("fatal: " + e.message); process.exit(1); });
