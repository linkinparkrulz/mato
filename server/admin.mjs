#!/usr/bin/env node
// Maintainer moderation CLI (run on the server by a maintainer over SSH).
//   node admin.mjs list                    show pending/approved/rejected
//   node admin.mjs approve <id> [paynym]   approve a submission (optionally set its PayNym)
//   node admin.mjs reject  <id>            reject a submission
//   node admin.mjs remove  <id>            delete a submission outright
// After approving/rejecting, run build-public.mjs to regenerate the public list.
import { store } from "./store.ts";
import { resolvePayNym } from "./paynym.mjs";

const [cmd, id, extra] = process.argv.slice(2);

function line(r) {
  return `${r.status.padEnd(8)} ${r.id.padEnd(26)} ${r.network.padEnd(7)} ${(r.paynym || "-").padEnd(18)} ${(r.name || "-").padEnd(18)} ${r.payload?.pairing?.url || ""}`;
}

const cmds = {
  async list() {
    const subs = await store.listSubmissions();
    if (!subs.length) return console.log("(no submissions)");
    for (const r of subs.sort((a, b) => (a.status).localeCompare(b.status))) console.log(line(r));
  },
  async approve() {
    const r = await store.getSubmission(id);
    if (!r) return console.error("no such submission:", id);
    r.status = "approved";
    if (extra) {
      r.paynym = extra.startsWith("+") ? extra : "+" + extra;      // maintainer override
    } else if (!r.paynym) {
      const resolved = await resolvePayNym((r.paymentCodes || [])[0]).catch(() => null);
      if (resolved) r.paynym = resolved;
    }
    r.updated_at = new Date().toISOString();
    await store.putSubmission(r);
    console.log("approved:", id, "paynym:", r.paynym || "(none set — pass one as the 3rd arg)");
    console.log("now run: node build-public.mjs");
  },
  async reject() {
    const r = await store.getSubmission(id);
    if (!r) return console.error("no such submission:", id);
    r.status = "rejected"; r.updated_at = new Date().toISOString();
    await store.putSubmission(r);
    console.log("rejected:", id, "(run build-public.mjs to drop it from the public list)");
  },
  async remove() {
    await store.deleteSubmission(id);
    console.log("removed:", id);
  },
};

(cmds[cmd] || (async () => { console.log("usage: node admin.mjs [list|approve <id> [paynym]|reject <id>|remove <id>]"); }))()
  .then(() => process.exit(0))
  .catch((e) => { console.error("error:", e.message); process.exit(1); });
