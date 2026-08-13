/**
 * netWorthCalculations.ts
 *
 * Pure calculation logic for the net worth bot: average estimated net worth of
 * the members who voted yea vs. nay. Extracted from fetchNetWorthVotes.ts so it
 * can be unit tested without network or filesystem access (mirrors
 * ageCalculations.ts for the age bot).
 *
 * Net worth caching
 * -----------------
 * Unlike ages, a net worth figure cannot self-heal from data already on disk:
 * an age is a pure function of a birthday and the clock, but net worth only
 * changes when a new financial disclosure is published. So each cached entry
 * carries a `validUntil` date computed from the refresh cadence
 * (`NET_WORTH_REFRESH_DAYS`, quarterly), and when that date passes the bot says
 * so loudly rather than pretending the number is current.
 *
 * All date math is done in UTC so a machine's local timezone can't shift a
 * cutoff by a day.
 */

import { normalizeHouseVote, buildVotePost, type Post, type VotePostMeta } from "./voteCalculations.js";
import { toIsoDate } from "./ageCalculations.js";

// ---------------------------------------------------------------------------
// Refresh cadence
// ---------------------------------------------------------------------------

/**
 * How long a cached net worth figure is treated as current, in days.
 *
 * Financial disclosures are annual (filed mid-May), but members also file
 * periodic transaction reports throughout the year and the roster itself
 * changes. A quarterly re-check is the cadence this project settled on: often
 * enough to pick up amendments and new members, rare enough that it's a manual
 * `npm run refresh-networth` rather than anything the 15-minute bot run does.
 */
export const NET_WORTH_REFRESH_DAYS = 90;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One member's cached net worth record. */
export interface MemberNetWorth {
  /** BioGuide ID — present for every member; the House vote XML keys off this. */
  bioguide: string;
  /** LIS member ID — senators only ("" for House members); the Senate vote XML keys off this. */
  lisId: string;
  name: string;
  state: string;
  party: string;
  chamber: "Senate" | "House";
  /**
   * Estimated net worth in USD — the midpoint of `netWorthLow`/`netWorthHigh`.
   * Can be negative: disclosed liabilities routinely exceed disclosed assets
   * (mortgages, student loans), and that is a real result, not a data error.
   */
  netWorth: number;
  /** Low end of the disclosed range (assets low minus liabilities high). */
  netWorthLow: number;
  /** High end of the disclosed range (assets high minus liabilities low). */
  netWorthHigh: number;
  /** Calendar year of the financial disclosure these figures come from. */
  disclosureYear: number;
  /** YYYY-MM-DD: the date this figure should be re-checked against a new disclosure. */
  validUntil: string;
}

/**
 * Members indexed by both identifiers, since the two chambers publish
 * different ones: House votes carry BioGuide IDs, Senate votes carry LIS IDs.
 */
export interface MemberNetWorthIndex {
  byBioguide: Map<string, MemberNetWorth>;
  byLis: Map<string, MemberNetWorth>;
}

/** The minimum a vote record needs for net worth lookup — `RawMemberVote` satisfies it. */
export interface NetWorthMemberVote {
  bioguide: string;
  lisId: string;
  voteCast: string;
}

export interface NetWorthBreakdown {
  /** Average net worth of yea voters in USD, or 0 when nobody voted yea. */
  avgNetWorthYea: number;
  /** Average net worth of nay voters in USD, or 0 when nobody voted nay. */
  avgNetWorthNay: number;
  /** Median net worth of yea voters in USD, or 0 when nobody voted yea. */
  medianNetWorthYea: number;
  /** Median net worth of nay voters in USD, or 0 when nobody voted nay. */
  medianNetWorthNay: number;
  countYea: number;
  countNay: number;
  /** Yea/nay voters found in the net worth cache. */
  matched: number;
  /** Yea/nay voters missing from the net worth cache (their wealth isn't counted). */
  unmatched: number;
  /** Share of yea/nay voters that were matched, 0-1. 1 when nobody took a side. */
  coverage: number;
}

export interface NetWorthVoteResult extends VotePostMeta, NetWorthBreakdown {
  voteNumber: string;
  date: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Minimum share of yea/nay voters that must have a net worth on file before a
 * post is allowed out.
 *
 * Financial disclosure coverage is not guaranteed the way birthdays are:
 * members in their first months of service haven't filed yet, and filings get
 * withdrawn or amended. An average taken over half a chamber isn't "the average
 * net worth of the members who voted yea" — it's a different, misleading
 * number, and a wrong post is public and irreversible. Below this threshold the
 * bot skips the vote and says why (same fail-loud stance as the Supabase
 * outage path).
 */
export const MIN_COVERAGE = 0.8;

export function hasSufficientCoverage(breakdown: NetWorthBreakdown): boolean {
  return breakdown.coverage >= MIN_COVERAGE;
}

// ---------------------------------------------------------------------------
// Cache construction + freshness
// ---------------------------------------------------------------------------

/** Adds `days` to a date and formats the result as YYYY-MM-DD in UTC. */
export function addDays(asOf: Date, days: number): string {
  const next = new Date(asOf.getTime() + days * 24 * 60 * 60 * 1000);
  return toIsoDate(next);
}

/** Midpoint of a disclosed range — the single figure the averages are built on. */
export function estimateNetWorth(low: number, high: number): number {
  return (low + high) / 2;
}

/** Builds a cache entry with `netWorth` and `validUntil` derived from the range and the clock. */
export function buildMemberNetWorth(
  member: Omit<MemberNetWorth, "netWorth" | "validUntil">,
  asOf: Date,
  refreshDays: number = NET_WORTH_REFRESH_DAYS
): MemberNetWorth {
  return {
    ...member,
    netWorth: estimateNetWorth(member.netWorthLow, member.netWorthHigh),
    validUntil: addDays(asOf, refreshDays),
  };
}

/** True once `asOf` has reached the entry's re-check date. */
export function isNetWorthStale(member: MemberNetWorth, asOf: Date): boolean {
  // ISO dates compare correctly as strings.
  return toIsoDate(asOf) >= member.validUntil;
}

/**
 * The entries due for a re-check. Unlike ages, these can't be recomputed from
 * anything already on disk — the caller can only warn and point at
 * `npm run refresh-networth`.
 */
export function findStaleNetWorths(members: MemberNetWorth[], asOf: Date): MemberNetWorth[] {
  return members.filter((m) => isNetWorthStale(m, asOf));
}

// ---------------------------------------------------------------------------
// Lookup + aggregation
// ---------------------------------------------------------------------------

export function buildMemberNetWorthIndex(members: MemberNetWorth[]): MemberNetWorthIndex {
  const byBioguide = new Map<string, MemberNetWorth>();
  const byLis = new Map<string, MemberNetWorth>();
  for (const member of members) {
    if (member.bioguide) byBioguide.set(member.bioguide, member);
    if (member.lisId) byLis.set(member.lisId, member);
  }
  return { byBioguide, byLis };
}

export function lookupMemberNetWorth(
  index: MemberNetWorthIndex,
  vote: NetWorthMemberVote
): MemberNetWorth | undefined {
  if (vote.bioguide) {
    const byBioguide = index.byBioguide.get(vote.bioguide);
    if (byBioguide) return byBioguide;
  }
  if (vote.lisId) return index.byLis.get(vote.lisId);
  return undefined;
}

/** Arithmetic mean, or 0 for an empty set (never NaN). */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Median, or 0 for an empty set. Even-sized sets average the two middle values.
 *
 * This is the number that actually answers "are wealthier members voting this
 * way?" — congressional wealth is extremely top-heavy, so a mean is dominated
 * by a handful of very rich members and can swing by millions when one of them
 * changes sides. The post publishes both so the gap between them is visible.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Average and median net worth of yea vs. nay voters. Works for both chambers:
 * Senate votes are always Yea/Nay, House votes are Yea/Nay on bills but Aye/No
 * on resolutions, and `normalizeHouseVote` folds all four together. Present /
 * Not Voting members are excluded from both sides — they took no side.
 */
export function calculateNetWorthBreakdown(
  members: NetWorthMemberVote[],
  index: MemberNetWorthIndex
): NetWorthBreakdown {
  const yea: number[] = [];
  const nay: number[] = [];
  let unmatched = 0;

  for (const m of members) {
    const voteCast = normalizeHouseVote(m.voteCast);
    if (!voteCast) continue;

    const memberNetWorth = lookupMemberNetWorth(index, m);
    if (!memberNetWorth) {
      unmatched++;
      continue;
    }

    if (voteCast === "Yea") yea.push(memberNetWorth.netWorth);
    else nay.push(memberNetWorth.netWorth);
  }

  const matched = yea.length + nay.length;
  const total = matched + unmatched;

  return {
    avgNetWorthYea: mean(yea),
    avgNetWorthNay: mean(nay),
    medianNetWorthYea: median(yea),
    medianNetWorthNay: median(nay),
    countYea: yea.length,
    countNay: nay.length,
    matched,
    unmatched,
    coverage: total > 0 ? matched / total : 1,
  };
}

// ---------------------------------------------------------------------------
// Display / post formatting
// ---------------------------------------------------------------------------

/**
 * A dollar figure at post scale: "$6.2M", "$450K", "-$1.2M".
 *
 * The sign goes before the "$" ("-$1.2M", not "$-1.2M") because that's how
 * negative money is normally written, and negative averages do happen — a
 * chamber's disclosed liabilities can outweigh its disclosed assets.
 */
export function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);

  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${Math.round(abs)}`;
}

/**
 * One side's figures as "avg | median (n members)", or "n/a" when nobody voted
 * that way. Both statistics are shown because the gap between them is the
 * point: a mean far above the median means a few very wealthy members are
 * carrying that side's number.
 */
export function formatNetWorth(avgNetWorth: number, medianNetWorth: number, count: number): string {
  if (count === 0) return "n/a";
  return (
    `${formatMoney(avgNetWorth)} | ${formatMoney(medianNetWorth)} ` +
    `(${count} member${count === 1 ? "" : "s"})`
  );
}

export function buildNetWorthPost(v: NetWorthVoteResult): Post {
  const netWorthBlock =
    `💰 Net worth (avg | median):\n` +
    `✅ YES: ${formatNetWorth(v.avgNetWorthYea, v.medianNetWorthYea, v.countYea)}\n` +
    `❌  NO: ${formatNetWorth(v.avgNetWorthNay, v.medianNetWorthNay, v.countNay)}`;

  return buildVotePost(v, netWorthBlock);
}
