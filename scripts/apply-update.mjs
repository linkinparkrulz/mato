#!/usr/bin/env node
// Detached helper that finishes a self-update AFTER the backend has replied to
// the browser. Spawned by server/self-update.mjs; not meant to be run by hand.
// It overlays the staged code onto the web root, reinstalls server
// dependencies, rebuilds the public list and source archive, records the
// result where the (about-to-restart) backend's status endpoint can read it,
// then restarts the service. Because restarting kills this helper's parent but
// not this detached process, the restart is the last thing it does.
import { cp, writeFile, rm, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const staging = arg("--staging");
const webRoot = arg("--webroot");
const version = arg("--version", "");

const resultPath = path.join(webRoot, "data", "updates", "last-result.json");
async function writeResult(obj) {
  try { await mkdir(path.dirname(resultPath), { recursive: true }); await writeFile(resultPath, JSON.stringify({ ...obj, at: new Date().toISOString(), version }, null, 2)); } catch {}
}

async function main() {
  if (!staging || !webRoot) { await writeResult({ ok: false, error: "missing --staging/--webroot" }); process.exit(1); }
  // Give the backend a moment to flush its "restarting" response.
  await new Promise((r) => setTimeout(r, 1500));
  try {
    // Dependencies are installed into STAGING, before anything is swapped.
    //
    // This used to run after the overlay, with a comment saying a failure was
    // survivable because the existing node_modules would still be there. They
    // would not: `npm ci` deletes node_modules and then installs, so a failure
    // leaves none at all, and the backend cannot resolve its own imports. An
    // instance did exactly that and restarted a hundred and three times.
    //
    // Two things had to change. Installing here means a failure aborts with the
    // web root untouched, still serving the old code, which is the only
    // acceptable outcome for a step that can fail. And npm is given a cache and
    // a HOME it can actually write: the service account is created with
    // --no-create-home, so the default $HOME/.npm is a directory it has no
    // permission to make, and that is what failed.
    const npmHome = path.join(webRoot, "data", ".npm");
    await mkdir(npmHome, { recursive: true }).catch(() => {});
    try {
      await run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--cache", npmHome],
        { cwd: path.join(staging, "server"), env: { ...process.env, HOME: npmHome } });
    } catch (e) {
      await writeResult({ ok: false, restarting: false,
        error: "dependency install failed, so nothing was changed: " + (e.message || String(e)) });
      process.exit(1);
    }

    // Overlay staged code onto the web root. Nothing under data/ is ever staged
    // (stripTopLevel drops it), so this cannot touch instance state. That used
    // to be an assumption about the archive rather than a guarantee, and it was
    // false for a GitHub zipball, which carries the repository's own copies of
    // dojos.json, the history files, the seed anchor and the operator binding.
    await cp(staging, webRoot, { recursive: true, force: true });

    // The version marker is written here rather than taken from the archive.
    // pack-source ships a version.json describing the instance that built it,
    // and a GitHub zipball ships the repository's, which says "dev"; neither
    // describes what has just been installed. The commit that was fetched is
    // known to this process and to nothing else, so this is the only place the
    // right answer exists. Getting it wrong is not cosmetic: the update check
    // refuses to run without a real commit, so an instance that overwrote this
    // with "dev" stopped being able to tell whether it was up to date.
    if (version) {
      await mkdir(path.join(webRoot, "data"), { recursive: true }).catch(() => {});
      // Short, because the deploy writes `cut -c1-7` and everything that reads
      // this expects that shape: the footer prints the value verbatim, so a
      // forty-character SHA there is not a longer answer, it is a different one
      // from the same file depending on how the code arrived.
      await writeFile(path.join(webRoot, "data", "version.json"),
        JSON.stringify({ commit: String(version).slice(0, 7), built: new Date().toISOString() }, null, 2) + "\n");
    }
    // Rebuild public list + source archive from the new code.
    await run(process.execPath, ["build-public.mjs"], { cwd: path.join(webRoot, "server") }).catch(() => {});
    await run(process.execPath, [path.join(webRoot, "scripts", "pack-source.mjs")]).catch(() => {});
    // Clean this staging tree (keep backups and the result file).
    await rm(path.dirname(staging), { recursive: true, force: true }).catch(() => {});
    await writeResult({ ok: true, restarting: true });
    // Restart the service last: this replaces the running (old-code) backend
    // with the new one. If we lack privilege, record it so /admin can show how
    // to finish by hand.
    try { await run("systemctl", ["restart", "dojobay-server.service"]); }
    catch (e) { await writeResult({ ok: true, restarting: false, note: "code updated; restart dojobay-server manually: " + e.message }); }
  } catch (e) {
    await writeResult({ ok: false, error: e.message });
    process.exit(1);
  }
}
main();
