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

export function buildPopulationPost(v: VoteResult): string {
  return (
    `${v.chamber} Vote: ${v.question}\n` +
    (v.description ? `${v.description}\n` : "") +
    `Result: ${v.result} (${v.yeas}-${v.nays})\n\n` +
    `🇺🇸 Population represented:\n` +
    `✅ YES: ${formatPop(v.populationYea)} (${formatPct(v.pctYea)})\n` +
    `❌  NO: ${formatPop(v.populationNay)} (${formatPct(v.pctNay)})`
  );
}
