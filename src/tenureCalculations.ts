/**
 * tenureCalculations.ts
 *
 * Pure calculation logic for the tenure bot: average time in office (years of
 * congressional service) of the members who voted yea vs. nay. Extracted from
 * fetchTenureVotes.ts so it can be unit tested without network or filesystem
 * access (mirrors ageCalculations.ts for the age bot).
 *
 * What "tenure" means here
 * -----------------------
 * Total time actually served in Congress, both chambers combined, counting only
 * days inside a term. Members who left and came back (or moved House → Senate
 * with a gap) get the served stretches summed and the gap excluded, so tenure is
 * "time in office", not "years since first sworn in". Service in state
 * legislatures or other offices is NOT counted — congress-legislators only
 * publishes congressional terms, and inventing a wider definition we can't
 * source would make the number unfalsifiable.
 *
 * Tenure caching
 * --------------
 * Tenure has the same shape as age: it's a pure function of dates already on
 * disk plus the clock. So each cached entry stores the two immutable inputs —
 * `priorServiceDays` (days served in terms that have already ended) and
 * `currentTermStart` — alongside a derived whole-year `tenureYears` and the
 * date that number stops being right (`tenureValidUntil`, the member's next
 * service anniversary). A cached tenure is used as-is until that date passes,
 * then recomputed in place from the stored inputs. That means the cache only
 * needs a real refresh when the *roster* changes (new Congress, special
 * elections), not every time somebody passes an anniversary.
 *
 * Tenure is counted in whole years per member, exactly as age is: a member in
 * their first year reads as 0, and the averages across a few hundred members
 * carry the decimal. The alternative — caching a fractional figure — would go
 * stale every single day and make the cache meaningless.
 *
 * All date math is done in UTC so a machine's local timezone can't shift an
 * anniversary by a day.
 */

import { normalizeHouseVote, buildVotePost, type Post, type VotePostMeta } from "./voteCalculations.js";
import { toIsoDate } from "./ageCalculations.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One member's cached tenure record. */
export interface MemberTenure {
  /** BioGuide ID — present for every member; the House vote XML keys off this. */
  bioguide: string;
  /** LIS member ID — senators only ("" for House members); the Senate vote XML keys off this. */
  lisId: string;
  name: string;
  state: string;
  party: string;
  chamber: "Senate" | "House";
  /**
   * Days served across every term that has already ended. Immutable input —
   * together with `currentTermStart` this is what `tenureYears` derives from.
   */
  priorServiceDays: number;
  /** YYYY-MM-DD: start of the term the member is serving now. */
  currentTermStart: string;
  /** Whole years of congressional service, valid until `tenureValidUntil`. */
  tenureYears: number;
  /** YYYY-MM-DD: the date `tenureYears` ticks over, i.e. stops being correct. */
  tenureValidUntil: string;
}

/**
 * Members indexed by both identifiers, since the two chambers publish
 * different ones: House votes carry BioGuide IDs, Senate votes carry LIS IDs.
 */
export interface MemberTenureIndex {
  byBioguide: Map<string, MemberTenure>;
  byLis: Map<string, MemberTenure>;
}

/** The minimum a vote record needs for tenure lookup — `RawMemberVote` satisfies it. */
export interface TenureMemberVote {
  bioguide: string;
  lisId: string;
  voteCast: string;
}

/** One congressional term as congress-legislators publishes it. */
export interface ServiceTerm {
  /** YYYY-MM-DD. */
  start: string;
  /** YYYY-MM-DD. Present for every term including the current one (its scheduled end). */
  end?: string;
}

/** The immutable service inputs a cache entry is built from. */
export interface ServiceHistory {
  priorServiceDays: number;
  currentTermStart: string;
}

export interface TenureBreakdown {
  /** Average years in office of yea voters, or 0 when nobody voted yea. */
  avgTenureYea: number;
  /** Average years in office of nay voters, or 0 when nobody voted nay. */
  avgTenureNay: number;
  countYea: number;
  countNay: number;
  /** Yea/nay voters found in the tenure cache. */
  matched: number;
  /** Yea/nay voters missing from the tenure cache (their tenure isn't counted). */
  unmatched: number;
}

export interface TenureVoteResult extends VotePostMeta, TenureBreakdown {
  voteNumber: string;
  date: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Date helpers (UTC throughout)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Average length of a calendar year, leap years included. Service is measured in
 * days and converted with this rather than by counting calendar anniversaries,
 * because a member's terms can start on different dates in different years —
 * there is no single anniversary to count from once service has gaps in it.
 */
export const DAYS_PER_YEAR = 365.25;

/** Parses YYYY-MM-DD as a UTC timestamp. Returns NaN for anything unparseable. */
export function parseUtcDate(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!match) return NaN;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

/** Whole days from `startIso` to `endIso`, negative if end precedes start. */
export function daysBetween(startIso: string, endIso: string): number {
  const start = parseUtcDate(startIso);
  const end = parseUtcDate(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / MS_PER_DAY);
}

/** `iso` shifted by `days`, as YYYY-MM-DD. */
export function addDays(iso: string, days: number): string {
  const base = parseUtcDate(iso);
  if (Number.isNaN(base)) return iso;
  return toIsoDate(new Date(base + days * MS_PER_DAY));
}

// ---------------------------------------------------------------------------
// Service history
// ---------------------------------------------------------------------------

/**
 * Reduces a member's published terms to the two numbers the cache stores.
 *
 * Terms that ended before `asOf` are summed as served days; the term containing
 * `asOf` supplies `currentTermStart`. Splitting it this way is what excludes
 * gaps in service: only days inside a term are ever added, so a member who sat
 * out a Congress doesn't get credited for the years they were out of office.
 *
 * Returns null when no term contains `asOf` — a member whose terms are all in
 * the past or all in the future has no current service to measure, and the
 * caller should skip them rather than cache a figure that means nothing.
 * (A member's *scheduled* term end is in the published data, so a sitting
 * member always has a term spanning today.)
 */
export function summarizeService(terms: ServiceTerm[], asOf: Date): ServiceHistory | null {
  const today = toIsoDate(asOf);
  let priorServiceDays = 0;
  let currentTermStart = "";

  for (const term of terms) {
    if (!term.start || Number.isNaN(parseUtcDate(term.start))) continue;
    if (term.start > today) continue; // hasn't begun yet — no service to count

    const end = term.end ?? "";
    const ended = end !== "" && !Number.isNaN(parseUtcDate(end)) && end <= today;

    if (ended) {
      priorServiceDays += Math.max(0, daysBetween(term.start, end));
      continue;
    }

    // A term that has started and not yet ended is the current one. Members are
    // listed with terms in chronological order, but take the earliest such term
    // rather than the last so overlapping/duplicated records can't shorten the
    // count.
    if (!currentTermStart || term.start < currentTermStart) currentTermStart = term.start;
  }

  if (!currentTermStart) return null;
  return { priorServiceDays, currentTermStart };
}

/** Total days served as of `asOf`: completed terms plus the current one so far. */
export function serviceDays(service: ServiceHistory, asOf: Date): number {
  const elapsed = daysBetween(service.currentTermStart, toIsoDate(asOf));
  return Math.max(0, service.priorServiceDays + Math.max(0, elapsed));
}

/** Whole years of service represented by a day count. */
export function tenureYearsFromDays(days: number): number {
  return Math.floor(Math.max(0, days) / DAYS_PER_YEAR);
}

/**
 * The date this member's whole-year tenure next increments, as YYYY-MM-DD.
 *
 * Derived from the current term's start rather than from `asOf`, so the answer
 * doesn't drift depending on when it's asked: the member crosses n+1 years once
 * `priorServiceDays` plus the days elapsed in this term reach (n+1) × 365.25.
 */
export function nextTenureAnniversary(service: ServiceHistory, asOf: Date): string {
  const years = tenureYearsFromDays(serviceDays(service, asOf));
  const daysNeeded = Math.ceil((years + 1) * DAYS_PER_YEAR) - service.priorServiceDays;
  return addDays(service.currentTermStart, daysNeeded);
}

/** Builds a cache entry with `tenureYears` and `tenureValidUntil` derived from the service history. */
export function buildMemberTenure(
  member: Omit<MemberTenure, "tenureYears" | "tenureValidUntil">,
  asOf: Date
): MemberTenure {
  const service = {
    priorServiceDays: member.priorServiceDays,
    currentTermStart: member.currentTermStart,
  };
  return {
    ...member,
    tenureYears: tenureYearsFromDays(serviceDays(service, asOf)),
    tenureValidUntil: nextTenureAnniversary(service, asOf),
  };
}

// ---------------------------------------------------------------------------
// Cache freshness
// ---------------------------------------------------------------------------

/** True once `asOf` has reached the member's next service anniversary — their cached tenure is now wrong. */
export function isTenureStale(member: MemberTenure, asOf: Date): boolean {
  // ISO dates compare correctly as strings.
  return toIsoDate(asOf) >= member.tenureValidUntil;
}

/**
 * Recomputes any cached tenures whose anniversary has passed, in place.
 * Returns the members that were updated so the caller can log and re-save.
 */
export function refreshStaleTenures(members: MemberTenure[], asOf: Date): MemberTenure[] {
  const refreshed: MemberTenure[] = [];
  for (const member of members) {
    if (!isTenureStale(member, asOf)) continue;
    const service = {
      priorServiceDays: member.priorServiceDays,
      currentTermStart: member.currentTermStart,
    };
    member.tenureYears = tenureYearsFromDays(serviceDays(service, asOf));
    member.tenureValidUntil = nextTenureAnniversary(service, asOf);
    refreshed.push(member);
  }
  return refreshed;
}

// ---------------------------------------------------------------------------
// Lookup + aggregation
// ---------------------------------------------------------------------------

export function buildMemberTenureIndex(members: MemberTenure[]): MemberTenureIndex {
  const byBioguide = new Map<string, MemberTenure>();
  const byLis = new Map<string, MemberTenure>();
  for (const member of members) {
    if (member.bioguide) byBioguide.set(member.bioguide, member);
    if (member.lisId) byLis.set(member.lisId, member);
  }
  return { byBioguide, byLis };
}

export function lookupMemberTenure(
  index: MemberTenureIndex,
  vote: TenureMemberVote
): MemberTenure | undefined {
  if (vote.bioguide) {
    const byBioguide = index.byBioguide.get(vote.bioguide);
    if (byBioguide) return byBioguide;
  }
  if (vote.lisId) return index.byLis.get(vote.lisId);
  return undefined;
}

/**
 * Average years in office of yea vs. nay voters. Works for both chambers:
 * Senate votes are always Yea/Nay, House votes are Yea/Nay on bills but Aye/No
 * on resolutions, and `normalizeHouseVote` folds all four together. Present /
 * Not Voting members are excluded from both averages — they took no side.
 *
 * Uses each member's cached `tenureYears` directly; call `refreshStaleTenures`
 * first so anyone who has passed an anniversary since the cache was written is
 * up to date.
 */
export function calculateAverageTenures(
  members: TenureMemberVote[],
  index: MemberTenureIndex
): TenureBreakdown {
  let sumYea = 0;
  let sumNay = 0;
  let countYea = 0;
  let countNay = 0;
  let unmatched = 0;

  for (const m of members) {
    const voteCast = normalizeHouseVote(m.voteCast);
    if (!voteCast) continue;

    const memberTenure = lookupMemberTenure(index, m);
    if (!memberTenure) {
      unmatched++;
      continue;
    }

    if (voteCast === "Yea") {
      sumYea += memberTenure.tenureYears;
      countYea++;
    } else {
      sumNay += memberTenure.tenureYears;
      countNay++;
    }
  }

  return {
    avgTenureYea: countYea > 0 ? sumYea / countYea : 0,
    avgTenureNay: countNay > 0 ? sumNay / countNay : 0,
    countYea,
    countNay,
    matched: countYea + countNay,
    unmatched,
  };
}

// ---------------------------------------------------------------------------
// Display / post formatting
// ---------------------------------------------------------------------------

/** One side's average tenure, or "n/a" when nobody voted that way. */
export function formatTenure(avgTenure: number, count: number): string {
  if (count === 0) return "n/a";
  return `${avgTenure.toFixed(1)} yrs (${count} member${count === 1 ? "" : "s"})`;
}

export function buildTenurePost(v: TenureVoteResult): Post {
  const tenureBlock =
    `⏳ Average time in office:\n` +
    `✅ YES: ${formatTenure(v.avgTenureYea, v.countYea)}\n` +
    `❌  NO: ${formatTenure(v.avgTenureNay, v.countNay)}`;

  return buildVotePost(v, tenureBlock);
}
