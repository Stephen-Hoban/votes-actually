/**
 * voteCalculations.ts
 *
 * Pure calculation logic for vote population representation, extracted from
 * fetchVotes.ts so it can be unit tested without network/filesystem access.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatePop {
  name: string;
  abbr: string;
  population: number;
  fips: string;
}

export interface DistrictPop {
  stateAbbr: string;
  district: string;
  population: number;
}

export interface MemberDistrict {
  districtKey: string;
  name: string;
  state: string;
  district: number;
  party: string;
}

export interface VoteResult {
  id: string;
  chamber: "Senate" | "House";
  voteNumber: string;
  date: string;
  question: string;
  description: string;
  result: string;
  yeas: number;
  nays: number;
  populationYea: number;
  populationNay: number;
  totalUsPopulation: number;
  pctYea: number;
  pctNay: number;
  url: string;
  /** congress.gov URL for the bill/resolution this vote is on, or "" if it couldn't be resolved (e.g. nominations). */
  billUrl: string;
  /** Display designation of that bill, e.g. "H.R. 5334", or "". */
  billDesignation: string;
  /** That bill's common name, or "" if unresolved. */
  billTitle: string;
}

/** A link over a byte range of post text, in the form Bluesky's rich-text facets expect. */
export interface PostFacet {
  byteStart: number;
  byteEnd: number;
  uri: string;
}

export interface Post {
  text: string;
  facets: PostFacet[];
}

export interface SenateMemberVote {
  state: string;
  voteCast: string;
}

export interface HouseMemberVote {
  bioguide: string;
  voteCast: string;
}

// ---------------------------------------------------------------------------
// Helper: safely extract a string from an xml2js parsed value
// ---------------------------------------------------------------------------

export function extractText(val: unknown): string {
  if (!val) return "";
  if (typeof val === "string") return val.trim();
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if ("_" in obj && typeof obj._ === "string") return obj._.trim();
    if ("#text" in obj && typeof obj["#text"] === "string") return obj["#text"].trim();
  }
  return String(val).trim();
}

// The House XML uses "Yea"/"Nay" for bill votes but "Aye"/"No" for votes on
// resolutions (procedural/rule votes). Normalize both to "Yea"/"Nay".
export function normalizeHouseVote(voteCast: string): "Yea" | "Nay" | null {
  if (voteCast === "Yea" || voteCast === "Aye") return "Yea";
  if (voteCast === "Nay" || voteCast === "No") return "Nay";
  return null;
}

// ---------------------------------------------------------------------------
// Auto-detection: Congress number, Senate session
// ---------------------------------------------------------------------------

// A Congress spans two years starting in odd-numbered years (e.g. 119th = 2025-2026).
// Session 1 is the first (odd) year, Session 2 is the second (even) year.
export function computeCongressSession(date: Date): { congress: number; session: number } {
  const year = date.getFullYear();
  const congress = Math.floor((year - 1789) / 2) + 1;
  const session = year % 2 === 1 ? 1 : 2;
  return { congress, session };
}

// ---------------------------------------------------------------------------
// Senate vote list ordering
// ---------------------------------------------------------------------------

// The Senate's vote_menu XML lists votes newest-first (descending vote_number:
// e.g. #210, #209, ... #1), unlike the House feed. Take the first N entries —
// not the last — to get the most recent votes, already newest-first.
export function selectRecentSenateVotes<T>(voteArray: T[], count: number): T[] {
  return voteArray.slice(0, count);
}

// ---------------------------------------------------------------------------
// How far back a run reaches
//
// Each run used to look at a fixed window of the newest DISPLAY_COUNT votes per
// chamber. That silently drops votes: the schedule asks for a run every 15
// minutes, but GitHub defers scheduled workflows heavily under load — in
// practice runs land roughly hourly, with observed gaps up to ~2.5 hours. A
// chamber can easily publish more than DISPLAY_COUNT roll calls in that time
// (the House ran 7 votes in 38 minutes on 2026-07-22; the Senate has had 14 in a
// day), and anything that fell off the back of the window was never posted and
// never reported as missing.
//
// So the window is anchored to what the bot has already handled — its
// high-water mark — rather than to a fixed count.
// ---------------------------------------------------------------------------

/**
 * Reorder a run's votes oldest-first for posting.
 *
 * Both chamber feeds arrive newest-first, which is the right order to *display*
 * but the wrong order to *post*, for a reason that only exists because of
 * catchUpStart(): a bot's window now starts above its high-water mark, and that
 * mark is the highest vote number it has posted.
 *
 * If a run dies partway through a batch — claimVote() throws on any non-duplicate
 * Supabase error, which aborts the run — whatever posted so far is permanent.
 * Posting newest-first would push the high-water mark straight to the top, so
 * the votes the run never reached would sit below it and never be fetched again:
 * silently dropped, the exact failure catchUpStart() exists to prevent. Going
 * oldest-first advances the mark only as far as the run actually got, leaving
 * everything unposted above it for the next run to catch.
 *
 * So this is a correctness constraint, not presentation. Reversing it reopens
 * the hole.
 */
export function orderForPosting<T>(votes: T[]): T[] {
  return [...votes].reverse();
}

/**
 * The oldest vote number a run should fetch for one chamber.
 *
 * - `latest`      newest vote number the chamber has published.
 * - `highWater`   newest vote number this bot has already handled, or 0 if it
 *                 has no history for this chamber/session yet.
 * - `displayCount` how many recent votes to fetch regardless, so console output
 *                 (and `npm run fetch-votes` with no --post) is unchanged.
 * - `maxCatchUp`  hard ceiling on votes fetched in one run.
 *
 * With no history the result is just the newest `displayCount`: a brand-new bot
 * must not treat a whole session as unposted backlog and flood Bluesky. That is
 * also what baselineSeenVotes.ts relies on to seed a bot.
 */
export function catchUpStart(
  latest: number,
  highWater: number,
  displayCount: number,
  maxCatchUp: number
): number {
  const displayStart = Math.max(1, latest - displayCount + 1);
  if (highWater <= 0) return displayStart;

  // Reach back past the display window to the first vote after the high-water
  // mark, but never further back than the cap allows.
  const wanted = Math.min(displayStart, highWater + 1);
  return Math.max(1, wanted, latest - maxCatchUp + 1);
}

// ---------------------------------------------------------------------------
// congress.gov bill/resolution URLs
// ---------------------------------------------------------------------------

const BILL_TYPE_SLUGS: Record<string, string> = {
  HR: "house-bill",
  HRES: "house-resolution",
  HJRES: "house-joint-resolution",
  HCONRES: "house-concurrent-resolution",
  S: "senate-bill",
  SRES: "senate-resolution",
  SJRES: "senate-joint-resolution",
  SCONRES: "senate-concurrent-resolution",
};

// How each type is written for readers. The chambers are not consistent with
// each other — the House writes "H R 8595" and "H J RES 139", the Senate
// "H.R. 8595" — so posts render this canonical form instead of whichever
// spelling the source feed happened to use.
const BILL_TYPE_LABELS: Record<string, string> = {
  HR: "H.R.",
  HRES: "H.Res.",
  HJRES: "H.J.Res.",
  HCONRES: "H.Con.Res.",
  S: "S.",
  SRES: "S.Res.",
  SJRES: "S.J.Res.",
  SCONRES: "S.Con.Res.",
};

/** A bill or resolution identified by its type key ("HR", "SJRES") and number. */
export interface BillDesignation {
  /** Normalized, punctuation-free type key — a key of BILL_TYPE_SLUGS. */
  type: string;
  number: number;
}

/**
 * Parses a raw bill/resolution designation as it appears in congressional data,
 * e.g. "H.R. 5103", "H R 5103", "H J RES 139", "S.Con.Res. 33".
 *
 * Returns null for anything that isn't a bill or resolution — nominations
 * ("PN615-2"), amendments ("S.Amdt. 5235"), or an empty designation.
 */
export function parseBillDesignation(rawDesignation: string): BillDesignation | null {
  const normalized = rawDesignation.replace(/[.\s]/g, "").toUpperCase();
  const match = normalized.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const [, type, number] = match;
  if (!(type in BILL_TYPE_SLUGS)) return null;
  return { type, number: parseInt(number, 10) };
}

/** Renders a parsed designation the way readers see it, e.g. "H.R. 5334". */
export function formatBillDesignation(bill: BillDesignation): string {
  return `${BILL_TYPE_LABELS[bill.type]} ${bill.number}`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

// Accepts a raw bill/resolution designation as it appears in congressional
// data, e.g. "H.R. 5103", "H R 5103", "H J RES 139", "S.Con.Res. 33".
// Returns "" if it doesn't map to a congress.gov bill page (e.g. nominations,
// or an amendment with no underlying bill to fall back to).
export function buildBillUrl(congress: number, rawDesignation: string): string {
  const bill = parseBillDesignation(rawDesignation);
  if (!bill) return "";
  const slug = BILL_TYPE_SLUGS[bill.type];
  return `https://www.congress.gov/bill/${ordinal(congress)}-congress/${slug}/${bill.number}`;
}

// ---------------------------------------------------------------------------
// Population aggregation
// ---------------------------------------------------------------------------

export function calculateSenatePopulation(
  members: SenateMemberVote[],
  statePops: Map<string, StatePop>
): { popYea: number; popNay: number } {
  let popYea = 0;
  let popNay = 0;

  for (const m of members) {
    const statePop = statePops.get(m.state);
    if (!statePop) continue;
    if (m.voteCast === "Yea") popYea += statePop.population;
    else if (m.voteCast === "Nay") popNay += statePop.population;
  }

  return { popYea, popNay };
}

export function calculateHousePopulation(
  members: HouseMemberVote[],
  memberDistricts: Map<string, MemberDistrict>,
  districtPops: Map<string, DistrictPop>
): { popYea: number; popNay: number; matched: number; unmatched: number } {
  let popYea = 0;
  let popNay = 0;
  let matched = 0;
  let unmatched = 0;

  for (const m of members) {
    const voteCast = normalizeHouseVote(m.voteCast);
    if (!m.bioguide || !voteCast) continue;

    const memberInfo = memberDistricts.get(m.bioguide);
    if (!memberInfo) { unmatched++; continue; }

    const districtPop = districtPops.get(memberInfo.districtKey);
    if (!districtPop) { unmatched++; continue; }

    matched++;
    if (voteCast === "Yea") popYea += districtPop.population;
    else popNay += districtPop.population;
  }

  return { popYea, popNay, matched, unmatched };
}

// ---------------------------------------------------------------------------
// Post length checking
//
// Bluesky's 300-char post limit is counted in grapheme clusters, not UTF-16
// code units or codepoints. Plain `.length` overcounts things like the 🇺🇸
// flag (two codepoints, one grapheme) and can undercount other multi-part
// emoji, so it's not a reliable stand-in for what Bluesky actually enforces.
// ---------------------------------------------------------------------------

export const MAX_POST_LENGTH = 300;

function segmentGraphemes(text: string): string[] {
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (s) => s.segment
  );
}

export function graphemeLength(text: string): number {
  return segmentGraphemes(text).length;
}

export function fitsInPost(text: string): boolean {
  return graphemeLength(text) <= MAX_POST_LENGTH;
}

export function truncateToGraphemes(text: string, maxGraphemes: number): string {
  if (maxGraphemes <= 0) return "";
  const graphemes = segmentGraphemes(text);
  return graphemes.length <= maxGraphemes ? text : graphemes.slice(0, maxGraphemes).join("");
}

// ---------------------------------------------------------------------------
// Display / post formatting
// ---------------------------------------------------------------------------

export function formatPop(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

export function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// Bluesky rich-text facets index by UTF-8 byte offset, not the UTF-16 index
// JS string ops use, so every facet boundary has to be converted.
function utf16IndexToByteIndex(text: string, utf16Index: number): number {
  return Buffer.byteLength(text.slice(0, utf16Index), "utf-8");
}

// When the bill line is too long to fit, shorten it — never the
// Result/Population lines, which are the whole point of the post.
function shortenBillLine(billLine: string, budget: number): string {
  if (budget < 2) return "";
  return truncateToGraphemes(billLine, budget - 1) + "…";
}

// Every buildPopulationPost exit path funnels through here so nothing ever
// escapes over the limit, even in pathological cases (e.g. a `question` long
// enough that the fixed header/result/population content alone exceeds it).
function finalizePost(voteId: string, text: string, facets: PostFacet[]): Post {
  if (fitsInPost(text)) return { text, facets };
  // The description boundaries (if any) are no longer reliable once the
  // whole text is blindly sliced, so drop the link along with it.
  console.warn(
    `  ⚠️  Post for vote ${voteId} still exceeds ${MAX_POST_LENGTH} graphemes after shortening; truncating as a last resort.`
  );
  return { text: truncateToGraphemes(text, MAX_POST_LENGTH - 1) + "…", facets: [] };
}

function linkFacet(text: string, billLineStart: number, billLineText: string, billUrl: string): PostFacet[] {
  if (!billUrl) return [];
  return [
    {
      byteStart: utf16IndexToByteIndex(text, billLineStart),
      byteEnd: utf16IndexToByteIndex(text, billLineStart + billLineText.length),
      uri: billUrl,
    },
  ];
}

/**
 * The vote fields every bot's post needs, regardless of what it measures.
 * `VoteResult` (and each bot's own result type) satisfies this structurally.
 */
export interface VotePostMeta {
  id: string;
  chamber: "Senate" | "House";
  question: string;
  /** The chamber's own words for the vote, used when there's no bill title. */
  description: string;
  result: string;
  yeas: number;
  nays: number;
  billUrl: string;
  /** Display designation of the bill this vote is on, e.g. "H.R. 5334", or "". */
  billDesignation: string;
  /** The bill's common name, e.g. "Value Over Cost Act of 2026", or "" if unresolved. */
  billTitle: string;
}

/**
 * The line under the header, naming what was actually voted on.
 *
 * Readers can't identify a bill from the chamber's own words: the Senate calls
 * this vote "H.R. 5334, as amended" and the House often leaves it blank, so the
 * post used to say nothing a reader could recognize without opening the link.
 * When we know the bill's common name it goes here with its number
 * ("H.R. 5334: Lindsey O. Graham Sanctioning Russia and Iran Act of 2026").
 *
 * Falls back to the chamber's description when there's no title to show —
 * nominations and procedural votes have no bill, and a govinfo outage must
 * degrade the post, not block it.
 */
export function billLine(v: VotePostMeta): string {
  if (!v.billTitle) return v.description;
  return v.billDesignation ? `${v.billDesignation}: ${v.billTitle}` : v.billTitle;
}

/**
 * Assembles a bot post: shared header/bill/result lines, then the bot-specific
 * `statBlock` (e.g. population represented, average age).
 *
 * The header, result line, and stat block are fixed — only the bill line is
 * shortened to fit, and it carries the congress.gov link facet when there is one.
 * Every bot shares this so post-length and facet handling only lives in one place.
 */
export function buildVotePost(v: VotePostMeta, statBlock: string): Post {
  const header = `${v.chamber} Vote: ${v.question}`;
  const resultLine = `Result: ${v.result} (${v.yeas}-${v.nays})`;
  const bill = billLine(v);

  const withoutBillLine = `${header}\n${resultLine}\n\n${statBlock}`;
  if (!bill) return finalizePost(v.id, withoutBillLine, []);

  const billLineStart = header.length + 1; // after "header\n"

  const fullText = `${header}\n${bill}\n${resultLine}\n\n${statBlock}`;
  if (fitsInPost(fullText)) {
    return finalizePost(v.id, fullText, linkFacet(fullText, billLineStart, bill, v.billUrl));
  }

  const fixedLength = graphemeLength(withoutBillLine) + 1; // +1 for the bill line's own newline
  const shortened = shortenBillLine(bill, MAX_POST_LENGTH - fixedLength);
  if (!shortened) return finalizePost(v.id, withoutBillLine, []);

  const text = `${header}\n${shortened}\n${resultLine}\n\n${statBlock}`;
  return finalizePost(v.id, text, linkFacet(text, billLineStart, shortened, v.billUrl));
}

export function buildPopulationPost(v: VoteResult): Post {
  const popBlock =
    `🇺🇸 Population represented:\n` +
    `✅ YES: ${formatPop(v.populationYea)} (${formatPct(v.pctYea)})\n` +
    `❌  NO: ${formatPop(v.populationNay)} (${formatPct(v.pctNay)})`;

  return buildVotePost(v, popBlock);
}
