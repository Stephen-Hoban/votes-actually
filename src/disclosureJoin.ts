/**
 * disclosureJoin.ts
 *
 * Joins financial disclosure filings to the congressional roster.
 *
 * Neither chamber keys its filings by BioGuide ID — the House publishes
 * "Last, First, StateDst", the Senate publishes little more than a name. The
 * vote XML, meanwhile, keys by BioGuide (House) and LIS ID (Senate). Something
 * has to bridge the two, and that something is name matching, which is the
 * most dangerous step in this pipeline: a wrong match doesn't error, it
 * silently attributes one member's wealth to another and posts it.
 *
 * So the rules here are deliberately conservative:
 *   - House filings match on state + district FIRST (there is exactly one
 *     representative per district), and the surname must then agree. A
 *     district whose surname doesn't agree is a former member's filing — a
 *     special election happened — and is dropped rather than guessed at.
 *   - Senate filings have no district and often no state, so they match on
 *     surname within the chamber, disambiguated by given name and then state.
 *   - Anything still ambiguous is reported, never guessed. An unmatched member
 *     lowers the bot's coverage figure, which is visible; a wrong match is not.
 *
 * This module is pure so the matching rules can be unit tested against the
 * real-world name variants that break naive comparison.
 */

import type { RawDisclosure } from "./disclosureTypes.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A current member of Congress, as derived from congress-legislators. */
export interface RosterMember {
  bioguide: string;
  lisId: string;
  name: string;
  state: string;
  /** Zero-padded district for representatives ("11", "00" at-large); "" for senators. */
  district: string;
  party: string;
  chamber: "Senate" | "House";
}

export interface MatchedDisclosure {
  member: RosterMember;
  disclosure: RawDisclosure;
}

export interface JoinResult {
  matched: MatchedDisclosure[];
  /** Filings that could not be tied to a sitting member, with the reason. */
  unmatched: Array<{ disclosure: RawDisclosure; reason: string }>;
  /** Sitting members with no filing at all — the coverage gap. */
  missing: RosterMember[];
}

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

/** Generational suffixes, which the two sources disagree about constantly. */
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/** Honorifics the House index puts in its Prefix field and sometimes inline. */
const PREFIXES = new Set(["hon", "mr", "mrs", "ms", "miss", "dr", "rep", "sen", "the"]);

/**
 * Reduces a name fragment to a comparable key: lowercase, accents folded,
 * punctuation dropped, honorifics and generational suffixes removed.
 *
 * Accent folding matters — congress-legislators writes "Nydia M. Velázquez"
 * while the disclosure index writes "Velazquez", and a byte comparison would
 * miss it. Apostrophes and hyphens matter for the same reason ("O'Halleran"
 * vs "OHalleran", "Garcia-Perez" vs "Garcia Perez").
 */
export function normalizeNamePart(raw: string): string {
  const tokens = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accent marks
    .toLowerCase()
    .replace(/[.,'’`]/g, "")
    .replace(/[-–—]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Honorifics and suffixes are stripped only where they can actually occur —
  // leading and trailing respectively. Filtering them from anywhere in the name
  // would eat legitimate name tokens: there are members surnamed "Rose", "Long"
  // and "May", and a blanket filter on short words like "sen", "dr" or "v" is
  // asking for a silent mismatch. Never strip the last remaining token either,
  // so a one-word name always survives intact.
  let start = 0;
  while (start < tokens.length - 1 && PREFIXES.has(tokens[start])) start++;
  let end = tokens.length;
  while (end > start + 1 && SUFFIXES.has(tokens[end - 1])) end--;

  return tokens.slice(start, end).join(" ");
}

/**
 * The comparable surname. Compound surnames are kept whole ("van hollen",
 * "de la cruz") because dropping a particle would collide with other members.
 */
export function normalizeSurname(last: string): string {
  return normalizeNamePart(last);
}

/**
 * The first token of a given name, which is the only part both sources
 * reliably agree on. congress-legislators has "Nancy" where a filing may have
 * "Nancy P." or "Nancy Patricia"; comparing first tokens avoids that whole
 * class of mismatch without loosening things enough to confuse two members.
 */
export function firstNameToken(first: string): string {
  return normalizeNamePart(first).split(" ")[0] ?? "";
}

/** Splits a roster member's display name into given and family parts. */
export function splitRosterName(name: string): { first: string; last: string } {
  const cleaned = normalizeNamePart(name);
  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length === 0) return { first: "", last: "" };
  if (tokens.length === 1) return { first: "", last: tokens[0] };
  return { first: tokens[0], last: tokens[tokens.length - 1] };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function districtKey(state: string, district: string): string {
  return `${state.toUpperCase()}-${district.padStart(2, "0")}`;
}

/**
 * True when two surnames refer to the same person as far as we can tell.
 *
 * Exact match after normalization, or one being the final token of the other —
 * which covers a compound surname recorded whole in one source and truncated
 * in the other ("Rodriguez Garcia" vs "Garcia"). Deliberately does NOT do
 * fuzzy/edit-distance matching: "Miller" and "Milller" being one typo apart is
 * not evidence they're the same member, and a false positive here is exactly
 * the failure this module exists to prevent.
 */
export function surnamesAgree(a: string, b: string): boolean {
  const na = normalizeSurname(a);
  const nb = normalizeSurname(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return surnameKey(na) === surnameKey(nb);
}

/**
 * The bucketing key for a surname: its final token.
 *
 * Compound surnames are recorded inconsistently between the roster and the
 * filings — congress-legislators has "Debbie Wasserman Schultz" while a filing
 * has Last="Wasserman Schultz" — so bucketing on the whole string would put the
 * same person in two different buckets and lose the match. The final token is
 * the part both sources always carry.
 */
export function surnameKey(last: string): string {
  const tokens = normalizeSurname(last).split(" ").filter(Boolean);
  return tokens.length === 0 ? "" : tokens[tokens.length - 1];
}

/**
 * Joins a batch of disclosures to the roster.
 *
 * House filings resolve by district (one seat, one member) with a surname
 * check; Senate filings resolve by surname within the chamber, narrowed by
 * given name and state when more than one senator shares a surname.
 */
export function joinDisclosures(disclosures: RawDisclosure[], roster: RosterMember[]): JoinResult {
  const houseByDistrict = new Map<string, RosterMember>();
  const senatorsBySurname = new Map<string, RosterMember[]>();

  for (const member of roster) {
    if (member.chamber === "House") {
      houseByDistrict.set(districtKey(member.state, member.district), member);
    } else {
      const key = surnameKey(splitRosterName(member.name).last);
      const bucket = senatorsBySurname.get(key);
      if (bucket) bucket.push(member);
      else senatorsBySurname.set(key, [member]);
    }
  }

  const matched: MatchedDisclosure[] = [];
  const unmatched: JoinResult["unmatched"] = [];
  const claimed = new Set<string>();

  function claim(member: RosterMember, disclosure: RawDisclosure): void {
    // A member filing both an original and an amendment should already have
    // been deduped upstream; if two filings still reach here, the first wins
    // and the second is reported rather than silently overwriting.
    if (claimed.has(member.bioguide)) {
      unmatched.push({
        disclosure,
        reason: `duplicate filing for ${member.name} (${member.bioguide}); kept the earlier one`,
      });
      return;
    }
    claimed.add(member.bioguide);
    matched.push({ member, disclosure });
  }

  for (const d of disclosures) {
    if (d.chamber === "House") {
      const member = houseByDistrict.get(districtKey(d.state, d.district));
      if (!member) {
        unmatched.push({ disclosure: d, reason: `no sitting member for ${d.state}-${d.district}` });
        continue;
      }
      if (!surnamesAgree(splitRosterName(member.name).last, d.last)) {
        // The seat changed hands since this was filed — this is a former
        // member's disclosure, not the current occupant's.
        unmatched.push({
          disclosure: d,
          reason: `${d.state}-${d.district} is now held by ${member.name}, not ${d.last}`,
        });
        continue;
      }
      claim(member, d);
      continue;
    }

    // Senate: surname first, then given name, then state.
    const candidates = senatorsBySurname.get(surnameKey(d.last)) ?? [];
    if (candidates.length === 0) {
      unmatched.push({ disclosure: d, reason: `no sitting senator named ${d.last}` });
      continue;
    }

    let narrowed = candidates;
    if (narrowed.length > 1 && d.first) {
      const byFirst = narrowed.filter(
        (m) => firstNameToken(splitRosterName(m.name).first) === firstNameToken(d.first)
      );
      if (byFirst.length > 0) narrowed = byFirst;
    }
    if (narrowed.length > 1 && d.state) {
      const byState = narrowed.filter((m) => m.state.toUpperCase() === d.state.toUpperCase());
      if (byState.length > 0) narrowed = byState;
    }

    if (narrowed.length !== 1) {
      unmatched.push({
        disclosure: d,
        reason: `ambiguous: ${narrowed.length} sitting senators match "${d.first} ${d.last}"`,
      });
      continue;
    }
    claim(narrowed[0], d);
  }

  const missing = roster.filter((m) => !claimed.has(m.bioguide));

  return { matched, unmatched, missing };
}
