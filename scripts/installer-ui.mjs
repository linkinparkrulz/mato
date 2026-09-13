// The installer's two faces behind one interface. Stage logic in install.mjs
// talks only to this adapter, so the full-screen TUI and the plain sequential
// flow (kept for dumb terminals, tiny windows, and --plain) stay behaviourally
// identical. Node builtins only.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { red, dim, bold, ok as okc, bad, banner, collectPasteFrom } from "./installer-lib.mjs";
import { makeScreen } from "./tui.mjs";

// interface:
//   step(n, total, title)
//   form(fields, {note}) -> {key: value}          fields as tui.mjs formInit
//   paste(label, {note, endWord}) -> string       cooked-mode multiline
//   confirm(question, dflt) -> bool
//   progress(title, fn(log)) -> result of fn      fn may throw; adapter rethrows
//   show(title, lines[])                          informational screen
//   finish(lines[]) / fail(message)               terminal states

// One UI, and it is the sequential one.
//
// The full-screen TUI was the default on any terminal that looked capable, with
// the sequential flow as a fallback. That was the wrong way round for a program
// whose whole job is to be run once, carefully, on somebody's server: the TUI
// takes over the screen, so when something goes wrong the output that would
// explain it is gone, and it is the path nobody has completed an install on.
// The sequential flow scrolls, which means the whole transcript stays on the
// screen and in the scrollback, and it is what every successful install so far
// has used. It also matches the uninstaller, which has only ever been
// sequential.
//
// tui.mjs and tuiUI() are kept rather than deleted, and their pure core is
// still self-tested, because the intention is to come back to this. Nothing
// reaches them at present, deliberately: an unfinished alternative that people
// can stumble into is worse than one that is parked.
//
// `--plain` is accepted and ignored, so anyone who learned to pass it, or has
// it in a script, is not met with an error about an option that used to be the
// only way to get the working path.
// Which commit this tree is. data/version.json is written by the deploy and
// shipped inside the source archive, so it describes the code that was actually
// unpacked here rather than whatever GitHub happens to be serving now, which is
// the distinction that matters when somebody is reporting what they installed.
// Absent on a git clone, and "dev" is not a build, so both give nothing rather
// than something misleading.
function buildCommit() {
  try {
    const v = JSON.parse(readFileSync(new URL("../data/version.json", import.meta.url), "utf8"));
    return typeof v.commit === "string" && v.commit && v.commit !== "dev" ? v.commit : null;
  } catch { return null; }
}

export function chooseUI(_argv = process.argv) {
  return sequentialUI();
}

// ---- sequential (phase one) --------------------------------------------------
export function sequentialUI() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const say = (s = "") => process.stdout.write(s + "\n");
  let stepLabel = "";
  say("\n" + banner(undefined, buildCommit()));
  async function askOne(f, all) {
    for (;;) {
      if (f.type === "toggle") {
        // Numbered, because a scrolling prompt cannot have a checkbox and the
        // previous phrasing, "Network (mainnet/testnet) [mainnet]:", read as an
        // instruction to type the word out. It always accepted a prefix; it just
        // never said so, and an operator typing "mainnet" in full every time is
        // the interface's fault rather than theirs.
        const def = f.value ?? 0;
        const menu = f.options.map((o, i) => `${i + 1}) ${o}`).join("  ");
        const v = (await rl.question(
          red(" ▸ ") + `${f.label}  ${menu}  [${def + 1}]: `)).trim();
        if (v === "") return f.options[def];
        // A number, or any unambiguous prefix of a name. Both, because someone
        // who has typed "testnet" at this prompt before should not be told off
        // for typing it again.
        const byNumber = /^\d+$/.test(v) ? f.options[Number(v) - 1] : undefined;
        const byName = f.options.filter((o) => o.toLowerCase().startsWith(v.toLowerCase()));
        const chosen = byNumber || (byName.length === 1 ? byName[0] : undefined);
        if (chosen) return chosen;
        say(bad(`   ✗ enter a number 1-${f.options.length}, or one of: ${f.options.join(", ")}`));
        continue;
      }
      if (f.hint) say(dim("   " + f.hint));
      const v = (await rl.question(red(" ▸ ") + f.label + (f.value ? ` [${f.value}]` : "") + ": ")).trim() || String(f.value ?? "");
      const r = f.validate ? f.validate(v, all) : true;
      if (r === true) return v;
      say(bad("   ✗ " + (typeof r === "string" ? r : "invalid value")));
    }
  }
  return {
    async step(n, total, title) { stepLabel = `${n}/${total}`; say("\n" + red("── ") + bold(`${n}. ${title}`) + red(" " + "─".repeat(Math.max(2, 50 - title.length)))); },
    /** @param {any[]} fields @param {{ note?: string }} [opts] */
    async form(fields, { note } = {}) {
      if (note) say(dim("   " + note.replace(/\n/g, "\n   ")));
      const out = {};
      for (const f of fields) out[f.key] = await askOne(f, out);
      return out;
    },
    /** @param {string} label @param {{ note?: string, endWord?: string }} [opts] */
    /** @param {string} label @param {{ note?: string, endWord?: string, endMarker?: string }} [opts] */
    async paste(label, { note, endWord = "END", endMarker = null } = {}) {
      if (note) say(dim("   " + note.replace(/\n/g, "\n   ")));
      // Listener attached before the prompt: a bulk paste must not lose lines.
      const collected = collectPasteFrom(rl, endWord, { endMarker });
      say(red(" ▸ ") + label + dim(endMarker
        ? `  (paste it all; it finishes on its own, or type ${endWord} on a line)`
        : `  (paste, then press Enter and type ${endWord} on a line of its own)`));
      return collected;
    },
    async confirm(q, dflt = true) {
      const v = (await rl.question(red(" ▸ ") + q + (dflt ? " [Y/n]: " : " [y/N]: "))).trim().toLowerCase();
      return v === "" ? dflt : v.startsWith("y");
    },
    async progress(title, fn) {
      say(dim("   " + title + "…"));
      return fn((line) => say(dim("     " + line)));
    },
    async show(title, lines) { say(bold("   " + title)); for (const l of lines) say("   " + l); },
    async finish(lines) { say("\n" + okc(bold("Done.")) + "\n" + lines.map((l) => "   " + l).join("\n") + "\n"); rl.close(); },
    async fail(message) { say(bad("✗ " + message)); rl.close(); process.exit(1); },
    ok(s) { say(okc("   ✓ " + s)); },
    err(s) { say(bad("   ✗ " + s)); },
  };
}

// ---- full-screen (phase two) ---------------------------------------------------
export function tuiUI() {
  const screen = makeScreen();
  let stepLabel = "", stepTitle = "";
  let pendingNotes = [];                       // ok/err lines shown on the next screen
  const noteBlock = () => { const n = pendingNotes.join("\n"); pendingNotes = []; return n; };
  process.on("exit", () => screen.leave());
  return {
    async step(n, total, title) { stepLabel = `The Dojo Bay installer · step ${n} of ${total}`; stepTitle = title; },
    /** @param {any[]} fields @param {{ note?: string }} [opts] */
    async form(fields, { note } = {}) {
      const merged = [noteBlock(), note].filter(Boolean).join("\n");
      return screen.runForm(fields, { stepLabel, title: stepTitle, note: merged });
    },
    /** @param {string} label @param {{ note?: string, endWord?: string, endMarker?: string }} [opts] */
    async paste(label, { note, endWord = "END", endMarker = null } = {}) {
      // cooked-mode paste: raw-mode paste handling is unreliable across SSH clients
      return screen.suspend(async () => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        process.stdout.write("\n" + bold(stepTitle) + "\n");
        const merged = [noteBlock(), note].filter(Boolean).join("\n");
        if (merged) process.stdout.write(dim(merged.replace(/^/gm, "  ")) + "\n");
        // Listener attached before the prompt: a bulk paste must not lose lines.
        const collected = collectPasteFrom(rl, endWord, { endMarker });
        process.stdout.write(red(" ▸ ") + label + dim(endMarker
          ? `  (paste it all; it finishes on its own, or type ${endWord} on a line)`
          : `  (paste, then press Enter and type ${endWord} on a line of its own)`) + "\n");
        const text = await collected;
        rl.close();
        return text;
      });
    },
    async confirm(q, dflt = true) {
      const v = await screen.runForm(
        [{ key: "a", label: q, type: "toggle", options: ["Yes", "No"], value: dflt ? 0 : 1 }],
        { stepLabel, title: stepTitle, note: noteBlock() });
      return v.a === "Yes";
    },
    async progress(title, fn) {
      return screen.runProgress({ stepLabel, title: `${stepTitle} — ${title}` }, fn);
    },
    async show(title, lines) {
      await screen.runForm([], { stepLabel, title, note: [noteBlock(), ...lines].filter(Boolean).join("\n") });
    },
    async finish(lines) {
      await screen.runForm([], { stepLabel: "The Dojo Bay installer · complete", title: "Done", note: lines.join("\n") });
      screen.leave();
    },
    async fail(message) { screen.leave(); console.error(bad("✗ " + message)); process.exit(1); },
    ok(s) { pendingNotes.push("✓ " + s); },
    err(s) { pendingNotes.push("✗ " + s); },
  };
}
