// =============================================================================
// Which index the next invoice gets.
//
// All invoices come from ONE BIP47 chain, so this counter is the most
// safety-critical piece of durable state in the system after the seed itself.
// Lose it and the gateway reissues addresses it has already handed out, which
// cross-credits one customer's payment to another customer's order.
//
// THE GAP-LIMIT PROBLEM, which is why this file is more than a counter. The
// operator's wallet scans a limited window of unused addresses ahead of the
// last one it has seen paid — twenty, in most implementations. A store that
// allocated a fresh index for every abandoned checkout would march past that
// window within an afternoon of browsing, and the wallet would simply stop
// seeing payments. Silently. So an index belonging to an invoice that expired
// unpaid is RECLAIMED and handed out again, which keeps the chain dense.
//
// THE HAZARD THAT CREATES, and the quarantine that answers it. If a customer
// pays an expired invoice late, and that index has already been reissued, the
// payment lands on an address the store now associates with somebody else's
// order. Reclaiming therefore has a floor enforced HERE rather than in the
// caller: an index is not offered again until it has sat released for
// RECLAIM_QUARANTINE_MS. The invoice layer decides when to release; this file
// guarantees the delay, because it owns the index and the caller may be
// rewritten by somebody who has not read this comment.
// =============================================================================
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

/** An index that was issued and then released, with when it was released. */
export interface Reclaimed { index: number; at: string }

export interface IndexState {
  v: 1;
  /** The lowest index never yet allocated. Only ever increases. */
  next: number;
  /** Released indices, oldest first, awaiting the end of their quarantine. */
  reclaimed: Reclaimed[];
  /** Allocated and not released: the addresses currently live on invoices. */
  issued: number[];
  updated_at: string | null;
}

const EMPTY: IndexState = { v: 1, next: 0, reclaimed: [], issued: [], updated_at: null };

/**
 * How long a released index must rest before it can be reissued. A day, because
 * the risk it covers is a customer paying an invoice hours after it expired,
 * and because the cost of waiting is only that the chain grows slightly denser
 * at the tip than it strictly had to.
 */
export const RECLAIM_QUARANTINE_MS = +(process.env.RECLAIM_QUARANTINE_MS || 24 * 60 * 60 * 1000);

export class IndexStore {
  file: string;
  private state: IndexState | null = null;
  private tmpSeq = 0;

  /**
   * One store per chain, in its own file.
   *
   * The network is required rather than defaulted because the failure it
   * prevents is silent and expensive: a shop keeps an identity per network, the
   * chains are separate, and a shared file would let a testnet allocation
   * consume a mainnet index. That index is then handed to a real customer while
   * the quarantine and retirement bookkeeping — which exists to keep the
   * operator's wallet inside its scanning window — has been counting the wrong
   * chain's activity. Defaulting would make forgetting it look like working.
   */
  constructor(dir: string, network: string) {
    if (!network) throw new Error("an index store must be told its network: the chains do not share indices");
    this.file = path.join(dir, `index-state.${network}.json`);
  }

  private async load(): Promise<IndexState> {
    if (this.state) return this.state;
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      this.state = { ...structuredClone(EMPTY), ...parsed };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.state = structuredClone(EMPTY);
    }
    return this.state!;
  }

  // A temporary name no other writer can take. `<file>.tmp` is not atomic
  // between processes: two writers produce the same path, the first rename
  // consumes it, and the second fails with ENOENT on a file it had just
  // written. Dojobay shipped that bug; this does not repeat it.
  private async persist() {
    const tmp = `${this.file}.${process.pid}.${(this.tmpSeq = (this.tmpSeq + 1) % 1e6)}.tmp`;
    this.state!.updated_at = new Date().toISOString();
    await writeFile(tmp, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /**
   * The next index to issue: the oldest reclaimed index that has finished its
   * quarantine, or a fresh one. Reclaimed indices go out oldest-first, so the
   * one handed back has had the longest possible time for a late payment to
   * arrive before its address is associated with anyone else.
   */
  async allocate(now: number = Date.now()): Promise<number> {
    const s = await this.load();
    let index: number;
    const ready = s.reclaimed.findIndex((r) => now - Date.parse(r.at) >= RECLAIM_QUARANTINE_MS);
    if (ready >= 0) {
      index = s.reclaimed.splice(ready, 1)[0].index;
    } else {
      index = s.next;
      s.next += 1;
    }
    if (!s.issued.includes(index)) s.issued.push(index);
    await this.persist();
    return index;
  }

  /**
   * Give an index back, for an invoice that expired without being paid.
   *
   * Idempotent, and deliberately so: a caller that releases twice must not put
   * the index into the free list twice, because that hands the same address to
   * two different orders — exactly the cross-crediting this file exists to
   * prevent. An index that was never issued is ignored rather than invented.
   */
  async release(index: number, now: number = Date.now()): Promise<boolean> {
    const s = await this.load();
    const at = s.issued.indexOf(index);
    if (at < 0) return false;
    s.issued.splice(at, 1);
    if (!s.reclaimed.some((r) => r.index === index)) {
      s.reclaimed.push({ index, at: new Date(now).toISOString() });
    }
    await this.persist();
    return true;
  }

  /**
   * Retire an index permanently: it was paid, so it must never be reissued.
   * Reusing a paid address would publish a link between two customers' orders
   * on the chain, which is the privacy loss this whole design is built to avoid.
   */
  async settle(index: number): Promise<boolean> {
    const s = await this.load();
    const at = s.issued.indexOf(index);
    if (at < 0) return false;
    s.issued.splice(at, 1);
    await this.persist();
    return true;
  }

  async status(now: number = Date.now()) {
    const s = await this.load();
    return {
      next: s.next,
      issued: s.issued.length,
      reclaimed: s.reclaimed.length,
      reclaimable: s.reclaimed.filter((r) => now - Date.parse(r.at) >= RECLAIM_QUARANTINE_MS).length,
      updated_at: s.updated_at,
    };
  }
}
