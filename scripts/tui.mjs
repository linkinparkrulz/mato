// Minimal full-screen TUI toolkit for the Dojo Bay installer. Node builtins
// only: raw-mode stdin, the alternate screen buffer, ANSI drawing. The
// interactive shell is deliberately thin; everything with logic in it -- the
// key decoder, the form state reducer, the frame renderer -- is a pure
// function exported for scripts/selftest.mjs.
//
// Design notes: multiline pastes never happen inside raw mode (the installer
// suspends the TUI into cooked line mode for those, because paste behaviour
// in raw mode varies wildly across SSH clients), and everything degrades: the
// installer only chooses this UI on a real TTY of sane size.

// ---- key decoding (pure) -----------------------------------------------------
// Turns a raw stdin chunk into a list of abstract keys.
export function decodeKeys(buf) {
  const s = buf.toString("utf8");
  const keys = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\x1b") {
      const rest = s.slice(i);
      const m = rest.match(/^\x1b\[([ABCDHF])/);
      if (m) {
        keys.push({ A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" }[m[1]]);
        i += 2; continue;
      }
      if (rest.startsWith("\x1b[3~")) { keys.push("delete"); i += 3; continue; }
      keys.push("esc"); continue;
    }
    if (c === "\r" || c === "\n") { keys.push("enter"); continue; }
    if (c === "\t") { keys.push("tab"); continue; }
    if (c === "\x7f" || c === "\b") { keys.push("backspace"); continue; }
    if (c === "\x03") { keys.push("ctrl-c"); continue; }
    if (c === "\x15") { keys.push("ctrl-u"); continue; }
    if (c >= " ") keys.push({ char: c });
  }
  return keys;
}

// ---- form reducer (pure) -----------------------------------------------------
// fields: [{key, label, hint?, type: "text"|"toggle"|"action", options?,
//           value?, validate?(v, all) -> true|string, mask?}]
// A trailing implicit "Continue" action row is appended automatically.
export function formInit(fields) {
  return {
    fields: fields.map((f) => ({ error: null, value: f.value ?? (f.type === "toggle" ? 0 : ""), ...f })),
    active: 0,
    submitted: false,
    cancelled: false,
  };
}
const valuesOf = (st) => Object.fromEntries(
  st.fields.map((f) => [f.key, f.type === "toggle" ? f.options[f.value] : String(f.value).trim()]));
function validateField(f, all) {
  if (!f.validate) return null;
  const v = f.type === "toggle" ? f.options[f.value] : String(f.value).trim();
  const r = f.validate(v, all);
  return r === true ? null : (typeof r === "string" ? r : "invalid value");
}
export function formReduce(st, key) {
  const n = st.fields.length;                     // rows: fields + continue button
  const rows = n + 1;
  const next = { ...st, fields: st.fields.map((f) => ({ ...f })) };
  const f = next.active < n ? next.fields[next.active] : null;
  if (key === "ctrl-c" || key === "esc") { next.cancelled = true; return next; }
  if (key === "up") { next.active = (next.active + rows - 1) % rows; return next; }
  if (key === "down" || key === "tab") { next.active = (next.active + 1) % rows; return next; }
  if (f && f.type === "toggle" && (key === "left" || key === "right")) {
    f.value = (f.value + (key === "right" ? 1 : f.options.length - 1)) % f.options.length;
    f.error = null;
    return next;
  }
  if (f && f.type === "text") {
    if (typeof key === "object" && key.char) { f.value = String(f.value) + key.char; f.error = null; return next; }
    if (key === "backspace") { f.value = String(f.value).slice(0, -1); f.error = null; return next; }
    if (key === "ctrl-u") { f.value = ""; f.error = null; return next; }
  }
  if (key === "enter") {
    if (f) {                                       // validate this field, advance
      f.error = validateField(f, valuesOf(next));
      if (!f.error) next.active = next.active + 1;
      return next;
    }
    // continue button: validate everything, focus the first failure
    let firstBad = -1;
    for (let i = 0; i < n; i++) {
      next.fields[i].error = validateField(next.fields[i], valuesOf(next));
      if (next.fields[i].error && firstBad < 0) firstBad = i;
    }
    if (firstBad >= 0) next.active = firstBad;
    else next.submitted = true;
    return next;
  }
  return next;
}
export const formValues = valuesOf;

// ---- frame renderer (pure) -----------------------------------------------------
const ESC = "\x1b[";
// Brand red, #b5302a. Exact where the terminal admits to 24-bit colour, and
// xterm 124 otherwise. Kept in step with installer-lib.mjs's red(); the two are
// separate because this module deliberately depends on nothing.
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || "");
const R = (s) => `${ESC}${TRUECOLOR ? "38;2;181;48;42" : "38;5;124"}m${s}${ESC}0m`;
const DIM = (s) => `${ESC}2m${s}${ESC}0m`;
const BOLD = (s) => `${ESC}1m${s}${ESC}0m`;
const BADC = (s) => `${ESC}38;5;196m${s}${ESC}0m`;
const OKC = (s) => `${ESC}38;5;71m${s}${ESC}0m`;
const INV = (s) => `${ESC}7m${s}${ESC}27m`;
const plainLen = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
const padTo = (s, w) => s + " ".repeat(Math.max(0, w - plainLen(s)));

// No gate here. The full art is sixty-six columns by thirty-four rows and this
// header is redrawn on every keystroke: it would leave an eighty by twenty-four
// terminal with nothing but a header, and a cut-down version of it turned out
// to be a worse picture rather than a smaller one. installer-lib.mjs prints the
// real thing once, before the TUI takes over. A rule and a wordmark do the job
// a frame header actually has, which is to say which program you are in.
export const HEADER = [];

/**
 * @param {{ width?: number, stepLabel?: string, title?: string,
 *   body?: string[], footer?: string, note?: string }} frame
 */
export function renderFrame({ width = 80, stepLabel = "", title = "", body = [], footer = "" }) {
  const lines = [];
  for (const l of HEADER) lines.push(R(l));
  lines.push(R(" ") + BOLD("THE DOJO BAY") + R("  " + "0".repeat(Math.max(0, width - 16))));
  lines.push(padTo(DIM(stepLabel), width - 1) );
  lines.push(R("── ") + BOLD(title) + " " + R("─".repeat(Math.max(2, width - 6 - plainLen(title)))));
  lines.push("");
  for (const b of body) lines.push("  " + b);
  lines.push("");
  lines.push(DIM(footer));
  return lines.map((l) => (plainLen(l) > width ? l.slice(0, width + (l.length - plainLen(l))) : l)).join("\r\n");
}

/**
 * @param {any} st
 * @param {{ width?: number, stepLabel?: string, title?: string, note?: string }} frame
 */
export function renderForm(st, { width = 80, stepLabel, title, note }) {
  const body = [];
  if (note) { for (const l of note.split("\n")) body.push(DIM(l)); body.push(""); }
  st.fields.forEach((f, i) => {
    const active = st.active === i;
    const marker = active ? R("▸ ") : "  ";
    let valueShown;
    if (f.type === "toggle") {
      valueShown = f.options.map((o, oi) => (oi === f.value ? INV(` ${o} `) : DIM(` ${o} `))).join(" ");
    } else {
      const raw = f.mask ? "•".repeat(String(f.value).length) : String(f.value);
      valueShown = raw + (active ? INV(" ") : "");
    }
    body.push(marker + BOLD(f.label));
    body.push("    " + valueShown);
    if (f.error) body.push("    " + BADC("✗ " + f.error));
    else if (f.hint && active) body.push("    " + DIM(f.hint));
  });
  const btnActive = st.active === st.fields.length;
  body.push("");
  body.push("  " + (btnActive ? INV(BOLD("  Continue  ")) : DIM("[ Continue ]")));
  return renderFrame({
    width, stepLabel, title, body,
    footer: "↑↓/Tab move · type to edit · ←→ choose · Enter next/confirm · Esc abort",
  });
}

export function renderProgress({ width = 80, stepLabel, title, spinnerIndex = 0, log = [], done = false, failed = false }) {
  const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const body = [];
  const state = failed ? BADC("✗ failed") : done ? OKC("✓ done") : R(SPIN[spinnerIndex % SPIN.length]) + DIM(" working…");
  body.push(state);
  body.push("");
  for (const l of log.slice(-12)) body.push(DIM(l.slice(0, width - 6)));
  return renderFrame({ width, stepLabel, title, body, footer: done || failed ? "Enter to continue" : "please wait (Tor operations can take ~30s)" });
}

// ---- interactive shell -------------------------------------------------------
export function makeScreen({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const write = (s) => stdout.write(s);
  let inTui = false;
  const enter = () => { if (inTui) return; inTui = true; stdin.setRawMode(true); stdin.resume(); write(`${ESC}?1049h${ESC}?25l`); };
  const leave = () => { if (!inTui) return; inTui = false; try { stdin.setRawMode(false); } catch {} write(`${ESC}?25h${ESC}?1049l`); };
  const paint = (frame) => write(`${ESC}H${ESC}2J` + frame);
  const width = () => Math.min(stdout.columns || 80, 100);

  async function runForm(fields, meta) {
    enter();
    let st = formInit(fields);
    paint(renderForm(st, { ...meta, width: width() }));
    return new Promise((resolve) => {
      const onData = (chunk) => {
        for (const key of decodeKeys(chunk)) {
          st = formReduce(st, key);
          if (st.cancelled) { cleanup(); leave(); process.exit(130); }
          if (st.submitted) { cleanup(); resolve(formValues(st)); return; }
        }
        paint(renderForm(st, { ...meta, width: width() }));
      };
      const onResize = () => paint(renderForm(st, { ...meta, width: width() }));
      const cleanup = () => { stdin.off("data", onData); stdout.off("resize", onResize); };
      stdin.on("data", onData);
      stdout.on("resize", onResize);
    });
  }

  async function runProgress(meta, fn) {
    enter();
    const log = [];
    let spinnerIndex = 0, done = false, failed = false;
    const repaint = () => paint(renderProgress({ ...meta, width: width(), spinnerIndex, log, done, failed }));
    const timer = setInterval(() => { spinnerIndex++; repaint(); }, 120);
    repaint();
    let result, error = null;
    try { result = await fn((line) => { log.push(line); repaint(); }); }
    catch (e) { error = e; failed = true; log.push("✗ " + e.message); }
    done = !failed;
    clearInterval(timer);
    repaint();
    await new Promise((resolve) => {
      const onData = (chunk) => {
        if (decodeKeys(chunk).some((k) => k === "enter" || k === "esc")) { stdin.off("data", onData); resolve(); }
      };
      stdin.on("data", onData);
    });
    if (error) throw error;
    return result;
  }

  // Suspend the TUI for cooked-mode multiline paste, then resume.
  async function suspend(fn) {
    leave();
    try { return await fn(); } finally { /* caller repaints via next screen */ }
  }

  return { enter, leave, runForm, runProgress, suspend, paint, width };
}
