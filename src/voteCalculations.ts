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
  const normalized = rawDesignation.replace(/[.\s]/g, "").toUpperCase();
  const match = normalized.match(/^([A-Z]+)(\d+)$/);
  if (!match) return "";
  const [, type, number] = match;
  const slug = BILL_TYPE_SLUGS[type];
  if (!slug) return "";
  return `https://www.congress.gov/bill/${ordinal(congress)}-congress/${slug}/${number}`;
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

// When the description is too long to fit, shorten it — never the
// Result/Population lines, which are the whole point of the post.
function shortenDescription(description: string, budget: number): string {
  if (budget < 2) return "";
  return truncateToGraphemes(description, budget - 1) + "…";
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

function linkFacet(text: string, descriptionStart: number, descriptionText: string, billUrl: string): PostFacet[] {
  if (!billUrl) return [];
  return [
    {
      byteStart: utf16IndexToByteIndex(text, descriptionStart),
      byteEnd: utf16IndexToByteIndex(text, descriptionStart + descriptionText.length),
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
  description: string;
  result: string;
  yeas: number;
  nays: number;
  billUrl: string;
}

/**
 * Assembles a bot post: shared header/description/result lines, then the
 * bot-specific `statBlock` (e.g. population represented, average age).
 *
 * The header, result line, and stat block are fixed — only the description is
 * shortened to fit, and it carries the congress.gov link facet when there is one.
 * Every bot shares this so post-length and facet handling only lives in one place.
 */
export function buildVotePost(v: VotePostMeta, statBlock: string): Post {
  const header = `${v.chamber} Vote: ${v.question}`;
  const resultLine = `Result: ${v.result} (${v.yeas}-${v.nays})`;

  const withoutDescription = `${header}\n${resultLine}\n\n${statBlock}`;
  if (!v.description) return finalizePost(v.id, withoutDescription, []);

  const descriptionStart = header.length + 1; // after "header\n"

  const fullDescriptionText = `${header}\n${v.description}\n${resultLine}\n\n${statBlock}`;
  if (fitsInPost(fullDescriptionText)) {
    return finalizePost(v.id, fullDescriptionText, linkFacet(fullDescriptionText, descriptionStart, v.description, v.billUrl));
  }

  const fixedLength = graphemeLength(withoutDescription) + 1; // +1 for the description line's own newline
  const shortened = shortenDescription(v.description, MAX_POST_LENGTH - fixedLength);
  if (!shortened) return finalizePost(v.id, withoutDescription, []);

  const text = `${header}\n${shortened}\n${resultLine}\n\n${statBlock}`;
  return finalizePost(v.id, text, linkFacet(text, descriptionStart, shortened, v.billUrl));
}

export function buildPopulationPost(v: VoteResult): Post {
  const popBlock =
    `🇺🇸 Population represented:\n` +
    `✅ YES: ${formatPop(v.populationYea)} (${formatPct(v.pctYea)})\n` +
    `❌  NO: ${formatPop(v.populationNay)} (${formatPct(v.pctNay)})`;

  return buildVotePost(v, popBlock);
}
