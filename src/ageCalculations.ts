/**
 * ageCalculations.ts
 *
 * Pure calculation logic for the age bot: average age of the members who voted
 * yea vs. nay. Extracted from fetchAgeVotes.ts so it can be unit tested without
 * network or filesystem access (mirrors voteCalculations.ts for the population bot).
 *
 * Age caching
 * -----------
 * Ages are cached per member in data/member-ages.json alongside the one thing
 * that makes an age go stale: the member's birthday. Each entry carries an
 * `ageValidUntil` date — their next birthday — so a cached age is used as-is
 * until that date passes, then recomputed from the birthday. That means the
 * cache only needs a real refresh when the *roster* changes (new Congress,
 * special elections), not every time somebody has a birthday.
 *
 * All date math is done in UTC so a machine's local timezone can't shift
 * somebody's birthday by a day.
 */

import { normalizeHouseVote, buildVotePost, type Post, type VotePostMeta } from "./voteCalculations.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One member's cached age record. */
export interface MemberAge {
  /** BioGuide ID — present for every member; the House vote XML keys off this. */
  bioguide: string;
  /** LIS member ID — senators only ("" for House members); the Senate vote XML keys off this. */
  lisId: string;
  name: string;
  state: string;
  party: string;
  chamber: "Senate" | "House";
  /** YYYY-MM-DD. The source of truth — `age` is derived from it. */
  birthday: string;
  /** Age in whole years, valid until `ageValidUntil`. */
  age: number;
  /** YYYY-MM-DD: their next birthday, i.e. the date `age` stops being correct. */
  ageValidUntil: string;
}

/**
 * Members indexed by both identifiers, since the two chambers publish
 * different ones: House votes carry BioGuide IDs, Senate votes carry LIS IDs.
 */
export interface MemberAgeIndex {
  byBioguide: Map<string, MemberAge>;
  byLis: Map<string, MemberAge>;
}

/** The minimum a vote record needs for age lookup — `RawMemberVote` satisfies it. */
export interface AgeMemberVote {
  bioguide: string;
  lisId: string;
  voteCast: string;
}

export interface AgeBreakdown {
  /** Average age of yea voters, or 0 when nobody voted yea. */
  avgAgeYea: number;
  /** Average age of nay voters, or 0 when nobody voted nay. */
  avgAgeNay: number;
  countYea: number;
  countNay: number;
  /** Yea/nay voters found in the age cache. */
  matched: number;
  /** Yea/nay voters missing from the age cache (their age isn't counted). */
  unmatched: number;
}

export interface AgeVoteResult extends VotePostMeta, AgeBreakdown {
  voteNumber: string;
  date: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Date helpers (UTC throughout)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseIsoDate(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Formats a Date as YYYY-MM-DD in UTC. */
export function toIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Age in whole years on `asOf`, from a YYYY-MM-DD birthday. */
export function calculateAge(birthday: string, asOf: Date): number {
  const b = parseIsoDate(birthday);
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth() + 1;
  const day = asOf.getUTCDate();

  let age = year - b.year;
  if (month < b.month || (month === b.month && day < b.day)) age--;
  return age;
}

/**
 * The next date on which this member's age increments, as YYYY-MM-DD.
 * Feb 29 birthdays roll to Mar 1 in non-leap years, matching `calculateAge`,
 * which increments on Mar 1 when Feb 29 doesn't exist that year.
 */
export function nextBirthday(birthday: string, asOf: Date): string {
  const b = parseIsoDate(birthday);
  const month = asOf.getUTCMonth() + 1;
  const day = asOf.getUTCDate();

  const alreadyHadBirthdayThisYear = month > b.month || (month === b.month && day >= b.day);
  const year = asOf.getUTCFullYear() + (alreadyHadBirthdayThisYear ? 1 : 0);

  if (b.month === 2 && b.day === 29 && !isLeapYear(year)) return `${year}-03-01`;
  return `${year}-${pad2(b.month)}-${pad2(b.day)}`;
}

/** Builds a cache entry with `age` and `ageValidUntil` derived from the birthday. */
export function buildMemberAge(
  member: Omit<MemberAge, "age" | "ageValidUntil">,
  asOf: Date
): MemberAge {
  return {
    ...member,
    age: calculateAge(member.birthday, asOf),
    ageValidUntil: nextBirthday(member.birthday, asOf),
  };
}

// ---------------------------------------------------------------------------
// Cache freshness
// ---------------------------------------------------------------------------

/** True once `asOf` has reached the member's next birthday — their cached age is now wrong. */
export function isAgeStale(member: MemberAge, asOf: Date): boolean {
  // ISO dates compare correctly as strings.
  return toIsoDate(asOf) >= member.ageValidUntil;
}

/**
 * Recomputes any cached ages whose birthday has passed, in place.
 * Returns the members that were updated so the caller can log and re-save.
 */
export function refreshStaleAges(members: MemberAge[], asOf: Date): MemberAge[] {
  const refreshed: MemberAge[] = [];
  for (const member of members) {
    if (!isAgeStale(member, asOf)) continue;
    member.age = calculateAge(member.birthday, asOf);
    member.ageValidUntil = nextBirthday(member.birthday, asOf);
    refreshed.push(member);
  }
  return refreshed;
}

// ---------------------------------------------------------------------------
// Lookup + aggregation
// ---------------------------------------------------------------------------

export function buildMemberAgeIndex(members: MemberAge[]): MemberAgeIndex {
  const byBioguide = new Map<string, MemberAge>();
  const byLis = new Map<string, MemberAge>();
  for (const member of members) {
    if (member.bioguide) byBioguide.set(member.bioguide, member);
    if (member.lisId) byLis.set(member.lisId, member);
  }
  return { byBioguide, byLis };
}

export function lookupMemberAge(index: MemberAgeIndex, vote: AgeMemberVote): MemberAge | undefined {
  if (vote.bioguide) {
    const byBioguide = index.byBioguide.get(vote.bioguide);
    if (byBioguide) return byBioguide;
  }
  if (vote.lisId) return index.byLis.get(vote.lisId);
  return undefined;
}

/**
 * Average age of yea vs. nay voters. Works for both chambers: Senate votes are
 * always Yea/Nay, House votes are Yea/Nay on bills but Aye/No on resolutions,
 * and `normalizeHouseVote` folds all four together. Present / Not Voting members
 * are excluded from both averages — they took no side.
 *
 * Uses each member's cached `age` directly; call `refreshStaleAges` first so
 * anyone who has had a birthday since the cache was written is up to date.
 */
export function calculateAverageAges(
  members: AgeMemberVote[],
  index: MemberAgeIndex
): AgeBreakdown {
  let sumYea = 0;
  let sumNay = 0;
  let countYea = 0;
  let countNay = 0;
  let unmatched = 0;

  for (const m of members) {
    const voteCast = normalizeHouseVote(m.voteCast);
    if (!voteCast) continue;

    const memberAge = lookupMemberAge(index, m);
    if (!memberAge) {
      unmatched++;
      continue;
    }

    if (voteCast === "Yea") {
      sumYea += memberAge.age;
      countYea++;
    } else {
      sumNay += memberAge.age;
      countNay++;
    }
  }

  return {
    avgAgeYea: countYea > 0 ? sumYea / countYea : 0,
    avgAgeNay: countNay > 0 ? sumNay / countNay : 0,
    countYea,
    countNay,
    matched: countYea + countNay,
    unmatched,
  };
}

// ---------------------------------------------------------------------------
// Display / post formatting
// ---------------------------------------------------------------------------

/** One side's average age, or "n/a" when nobody voted that way. */
export function formatAge(avgAge: number, count: number): string {
  if (count === 0) return "n/a";
  return `${avgAge.toFixed(1)} yrs (${count} member${count === 1 ? "" : "s"})`;
}

export function buildAgePost(v: AgeVoteResult): Post {
  const ageBlock =
    `🎂 Average age:\n` +
    `✅ YES: ${formatAge(v.avgAgeYea, v.countYea)}\n` +
    `❌  NO: ${formatAge(v.avgAgeNay, v.countNay)}`;

  return buildVotePost(v, ageBlock);
}
