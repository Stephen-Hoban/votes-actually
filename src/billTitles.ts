/**
 * billTitles.ts
 *
 * Resolves the name a bill is actually known by — "Lindsey O. Graham
 * Sanctioning Russia and Iran Act of 2026" — from its designation, "H.R. 5334".
 *
 * Why this needs a second data source:
 *
 * Neither roll call feed carries a usable title. The Senate's vote XML has a
 * `document_short_title` field, but it is not maintained: on the H.R. 5334
 * passage vote it held the short title of an entirely unrelated bill (an
 * educator expense deduction), because H.R. 5334 was a shell the Senate
 * amended. Its `document_title` is the long official title ("An act to impose
 * sanctions and other measures with respect to the Russian Federation…"), never
 * the common name, and `vote_title` is just "H.R. 5334, as amended". The
 * House's `vote-desc` is often the short title but is blank on amendment votes
 * and on some passage votes.
 *
 * So titles come from govinfo's BILLSTATUS bulk data — the official Congress.gov
 * bill record, published by GPO. No API key, same tier of source as the
 * senate.gov and clerk.house.gov vote feeds this project already reads.
 *
 * Cost control (the constraint that shapes this module):
 *   - a module-level cache means a bill is fetched at most once per process,
 *     which is what stops `--watch` runs from re-asking every poll, and why the
 *     two H.R. 7008 votes in one run (passage, then motion to recommit) cost one
 *     request between them;
 *   - votes with no bill (nominations, amendments) are never looked up;
 *   - requests go out in small parallel batches, so a catch-up run doesn't
 *     serialize dozens of round trips.
 *
 * A failure here is never fatal. Posts fall back to the chamber's own
 * description, exactly as they read before titles existed.
 */

import { parseStringPromise } from "xml2js";
import { extractText, BillDesignation } from "./voteCalculations.js";

const BULKDATA_BASE = "https://www.govinfo.gov/bulkdata/BILLSTATUS";
const USER_AGENT = "votes-actually (educational project)";
const REQUEST_TIMEOUT_MS = 15_000;

/** How many bills to fetch at once. Small enough to stay a polite client. */
const CONCURRENCY = 5;

/** Our normalized type keys → the path segment govinfo files each type under. */
const BULKDATA_PATHS: Record<string, string> = {
  HR: "hr",
  HRES: "hres",
  HJRES: "hjres",
  HCONRES: "hconres",
  S: "s",
  SRES: "sres",
  SJRES: "sjres",
  SCONRES: "sconres",
};

/** A bill to look up: a parsed designation plus the Congress it belongs to. */
export interface BillRef extends BillDesignation {
  congress: number;
}

/** Cache key for one bill, e.g. "119:HR:5334". */
export function billKey(ref: BillRef): string {
  return `${ref.congress}:${ref.type}:${ref.number}`;
}

/**
 * Titles already resolved this process, keyed by billKey().
 *
 * A bill with no title available is cached as "" too, so a run that votes on it
 * repeatedly doesn't ask again and again.
 */
const titleCache = new Map<string, string>();

/**
 * Picks the name a bill is commonly referred to by, out of a BILLSTATUS
 * `<titles>` block.
 *
 * That is the entry whose `titleType` is "Display Title" — Congress.gov's own
 * choice of what to call the bill, which resolves to the sponsor-given short
 * title of the bill's current version when there is one and the official title
 * when there isn't. Every bill and resolution type checked carries one.
 *
 * Deliberately not "the most recent short title", which looks more precise and
 * is worse. A bill can carry several short titles at once — H.R. 6500 lists
 * "AGOA Extension Act", "Continuing Appropriations Act, 2027" and "Surface
 * Transportation Extension Act of 2026", one per division of an omnibus — and
 * picking the last would have named the whole continuing resolution after its
 * highway division. Naming a bill wrongly in public is a worse failure than
 * naming it verbosely, and Congress.gov has already made this judgment.
 *
 * The cost of that choice: a bill whose short title applies only to an earlier
 * version falls back to the long official title (H.R. 4541 reads "To reauthorize
 * the Young Women's Breast Health…" rather than "EARLY Act Reauthorization").
 * Long, but accurate, and buildVotePost() shortens it to fit.
 */
export function pickBillTitle(titleItems: unknown): string {
  const items: unknown[] = Array.isArray(titleItems) ? titleItems : [titleItems];

  for (const item of items) {
    const entry = item as Record<string, unknown> | undefined;
    if (!entry) continue;
    if (extractText(entry.titleType) === "Display Title") {
      return extractText(entry.title);
    }
  }

  return "";
}

/** Fetches and parses one bill's BILLSTATUS record, returning its display title. */
async function fetchTitle(ref: BillRef): Promise<string> {
  const path = BULKDATA_PATHS[ref.type];
  const stem = `${ref.congress}${path}${ref.number}`;
  const url = `${BULKDATA_BASE}/${ref.congress}/${path}/BILLSTATUS-${stem}.xml`;

  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/xml" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // A bill voted on the same day it was introduced may not be published yet.
  // That's a miss, not an error — the post falls back to the description.
  if (resp.status === 404) return "";
  if (!resp.ok) throw new Error(`govinfo returned ${resp.status}`);

  const parsed = await parseStringPromise(await resp.text(), { explicitArray: false });
  const bill = parsed?.billStatus?.bill as Record<string, unknown> | undefined;
  const titles = bill?.titles as Record<string, unknown> | undefined;
  return pickBillTitle(titles?.item);
}

/** Runs `task` over `items` a few at a time rather than all at once. */
async function inBatches<T>(items: T[], size: number, task: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(task));
  }
}

/**
 * Resolves titles for a set of bills, returning a billKey() → title map.
 *
 * Bills with no title available are simply absent from the map. Never throws:
 * a bill that fails is warned about and left unresolved, so the bots keep
 * posting with the chamber's own description.
 */
export async function fetchBillTitles(refs: BillRef[]): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  // Keyed, not a plain array: a run votes on the same bill repeatedly (passage,
  // then a motion to recommit), and each bill must be asked for only once.
  const missing = new Map<string, BillRef>();

  for (const ref of refs) {
    if (!(ref.type in BULKDATA_PATHS)) continue;
    const key = billKey(ref);
    const cached = titleCache.get(key);
    if (cached !== undefined) {
      if (cached) known.set(key, cached);
    } else {
      missing.set(key, ref);
    }
  }

  if (missing.size > 0) {
    console.log(`\n📖 Looking up ${missing.size} bill title(s) from govinfo...`);
  }

  await inBatches([...missing], CONCURRENCY, async ([key, ref]) => {
    try {
      titleCache.set(key, await fetchTitle(ref));
    } catch (err) {
      console.warn(
        `  ⚠️  Could not fetch the title for ${ref.type} ${ref.number}: ${(err as Error).message}. ` +
          `That post falls back to the chamber's description.`
      );
    }
  });

  for (const key of missing.keys()) {
    const title = titleCache.get(key);
    if (title) known.set(key, title);
  }

  return known;
}
