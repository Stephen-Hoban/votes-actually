/**
 * refreshCache.ts
 *
 * Fetches slow-changing reference data and saves it to local JSON files.
 * Run this manually when needed — not on every vote fetch.
 *
 * When to refresh:
 *   district-populations.json  → After each decennial Census (next: ~2031)
 *   member-districts.json      → Start of each Congress + after special elections
 *   member-ages.json           → Start of each Congress + after special elections
 *   member-tenure.json         → Start of each Congress + after special elections
 *   member-networth.json       → Quarterly (NET_WORTH_REFRESH_DAYS), and after
 *                                the mid-May annual financial disclosure filing
 *
 * Usage:
 *   npm run refresh-cache                — refresh everything
 *   npm run refresh-cache -- --members   — refresh member→district map only
 *   npm run refresh-cache -- --census    — refresh district populations only
 *   npm run refresh-cache -- --ages      — refresh member ages only
 *   npm run refresh-cache -- --tenure    — refresh member tenures only
 *   npm run refresh-cache -- --networth  — refresh member net worths only
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { buildMemberAge, type MemberAge } from "./ageCalculations.js";
import {
  buildMemberTenure,
  summarizeService,
  type MemberTenure,
  type ServiceTerm,
} from "./tenureCalculations.js";
import {
  buildMemberNetWorth,
  NET_WORTH_REFRESH_DAYS,
  type MemberNetWorth,
} from "./netWorthCalculations.js";
import { netWorthRange } from "./disclosureBrackets.js";
import { joinDisclosures, type RosterMember } from "./disclosureJoin.js";
import { fetchHouseDisclosures } from "./disclosureHouse.js";
import { fetchSenateDisclosures } from "./disclosureSenate.js";
import type { RawDisclosure } from "./disclosureTypes.js";

dotenv.config();

const CENSUS_API_KEY = process.env.CENSUS_API_KEY ?? "";

const LEGISLATORS_URL =
  "https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages/legislators-current.json";

const DATA_DIR = path.join(process.cwd(), "data");
const DISTRICT_POP_FILE = path.join(DATA_DIR, "district-populations.json");
const MEMBER_DISTRICT_FILE = path.join(DATA_DIR, "member-districts.json");
const STATE_POP_FILE = path.join(DATA_DIR, "state-populations.json");
const MEMBER_AGE_FILE = path.join(DATA_DIR, "member-ages.json");
const MEMBER_NET_WORTH_FILE = path.join(DATA_DIR, "member-networth.json");
const MEMBER_TENURE_FILE = path.join(DATA_DIR, "member-tenure.json");

// ---------------------------------------------------------------------------
// State FIPS lookup
// ---------------------------------------------------------------------------

const STATE_ABBR_TO_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09",
  DE: "10", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18",
  IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25",
  MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32",
  NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38", OH: "39",
  OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46", TN: "47",
  TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55",
  WY: "56",
};

const FIPS_TO_STATE_ABBR: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_ABBR_TO_FIPS).map(([abbr, fips]) => [fips, abbr])
);

// ---------------------------------------------------------------------------
// Ensure data directory exists
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Created data directory: ${DATA_DIR}`);
  }
}

// ---------------------------------------------------------------------------
// Refresh state populations
// ---------------------------------------------------------------------------

async function refreshStatePopulations(): Promise<void> {
  console.log("📊 Fetching state populations from Census ACS5...");

  if (!CENSUS_API_KEY) {
    throw new Error("CENSUS_API_KEY is required. Add it to your .env file.");
  }

  const url =
    `https://api.census.gov/data/2022/acs/acs5?get=NAME,B01003_001E` +
    `&for=state:*&key=${CENSUS_API_KEY}`;

  const resp = await fetch(url, {
    headers: { "User-Agent": "votes-actually (educational project)" },
  });
  if (!resp.ok) throw new Error(`Census API error: ${resp.status} ${resp.statusText}`);

  const data = (await resp.json()) as string[][];
  const [, ...rows] = data;

  // Build map: stateAbbr → population
  const statePops: Record<string, { name: string; abbr: string; population: number; fips: string }> = {};

  for (const [name, popStr, fips] of rows) {
    const abbr = FIPS_TO_STATE_ABBR[fips];
    if (abbr) {
      statePops[abbr] = {
        name,
        abbr,
        population: parseInt(popStr, 10),
        fips,
      };
    }
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    source: "US Census Bureau ACS5 2022",
    note: "Refresh after each decennial Census (~2031)",
    totalStates: Object.keys(statePops).length,
    states: statePops,
  };

  fs.writeFileSync(STATE_POP_FILE, JSON.stringify(output, null, 2));
  console.log(`✅ Saved ${Object.keys(statePops).length} state populations → ${STATE_POP_FILE}`);
}

// ---------------------------------------------------------------------------
// Refresh congressional district populations
// ---------------------------------------------------------------------------

async function refreshDistrictPopulations(): Promise<void> {
  console.log("🗺️  Fetching congressional district populations from Census ACS5...");

  if (!CENSUS_API_KEY) {
    throw new Error("CENSUS_API_KEY is required. Add it to your .env file.");
  }

  const url =
    `https://api.census.gov/data/2022/acs/acs5?get=NAME,B01003_001E` +
    `&for=congressional%20district:*&in=state:*&key=${CENSUS_API_KEY}`;

  const resp = await fetch(url, {
    headers: { "User-Agent": "votes-actually (educational project)" },
  });
  if (!resp.ok) throw new Error(`Census API (districts) error: ${resp.status} ${resp.statusText}`);

  // Columns: [NAME, B01003_001E, state, congressional district]
  const data = (await resp.json()) as string[][];
  const [, ...rows] = data;

  // Build map: "TX-07" → population
  const districtPops: Record<string, { stateAbbr: string; district: string; population: number }> = {};

  for (const [, popStr, stateFips, districtCode] of rows) {
    const stateAbbr = FIPS_TO_STATE_ABBR[stateFips];
    if (!stateAbbr) continue;
    const key = `${stateAbbr}-${districtCode}`;
    districtPops[key] = {
      stateAbbr,
      district: districtCode,
      population: parseInt(popStr, 10),
    };
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    source: "US Census Bureau ACS5 2022",
    note: "Refresh after each decennial Census (~2031) or after redistricting",
    totalDistricts: Object.keys(districtPops).length,
    districts: districtPops,
  };

  fs.writeFileSync(DISTRICT_POP_FILE, JSON.stringify(output, null, 2));
  console.log(`✅ Saved ${Object.keys(districtPops).length} district populations → ${DISTRICT_POP_FILE}`);
}

// ---------------------------------------------------------------------------
// Refresh member → district map
// ---------------------------------------------------------------------------

async function refreshMemberDistricts(): Promise<void> {
  console.log("👥 Fetching member→district map from congress-legislators...");

  const resp = await fetch(LEGISLATORS_URL, {
    headers: { "User-Agent": "votes-actually (educational project)" },
  });
  if (!resp.ok) throw new Error(`Legislators fetch error: ${resp.status} ${resp.statusText}`);

  const legislators = (await resp.json()) as Array<{
    id: { bioguide: string };
    name: { official_full?: string; first: string; last: string };
    terms: Array<{ type: string; state: string; district?: number; start: string; end?: string; party?: string }>;
  }>;

  // Build map: bioguideId → { districtKey, name, state, district, party }
  const memberMap: Record<string, {
    districtKey: string;
    name: string;
    state: string;
    district: number;
    party: string;
  }> = {};

  let houseCount = 0;

  for (const leg of legislators) {
    const bioguide = leg.id.bioguide;
    if (!bioguide) continue;

    // Find the most recent House term
    const repTerms = (leg.terms ?? []).filter(t => t.type === "rep");
    if (repTerms.length === 0) continue;

    const lastTerm = repTerms[repTerms.length - 1];
    const state = lastTerm.state;
    const district = lastTerm.district ?? 0;
    const party = lastTerm.party ?? "Unknown";

    // Zero-pad district to 2 digits; at-large (0) → "00"
    const districtKey = `${state}-${String(district).padStart(2, "0")}`;
    const name = leg.name.official_full ?? `${leg.name.first} ${leg.name.last}`;

    memberMap[bioguide] = { districtKey, name, state, district, party };
    houseCount++;
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    source: "unitedstates/congress-legislators (gh-pages branch)",
    note: "Refresh at start of each Congress (every 2 years) and after special elections",
    totalMembers: houseCount,
    members: memberMap,
  };

  fs.writeFileSync(MEMBER_DISTRICT_FILE, JSON.stringify(output, null, 2));
  console.log(`✅ Saved ${houseCount} House member→district mappings → ${MEMBER_DISTRICT_FILE}`);
}

// ---------------------------------------------------------------------------
// Refresh member ages
// ---------------------------------------------------------------------------

async function refreshMemberAges(): Promise<void> {
  console.log("🎂 Fetching member ages from congress-legislators...");

  const resp = await fetch(LEGISLATORS_URL, {
    headers: { "User-Agent": "votes-actually (educational project)" },
  });
  if (!resp.ok) throw new Error(`Legislators fetch error: ${resp.status} ${resp.statusText}`);

  const legislators = (await resp.json()) as Array<{
    id: { bioguide: string; lis?: string };
    name: { official_full?: string; first: string; last: string };
    // `bio` is present for every current member today, but a newly-seated member
    // can land in the feed before their bio block is filled in — so don't assume it.
    bio?: { birthday?: string };
    terms: Array<{ type: string; state: string; party?: string }>;
  }>;

  const now = new Date();
  const members: MemberAge[] = [];
  let senateCount = 0;
  let houseCount = 0;
  let skipped = 0;

  for (const leg of legislators) {
    const bioguide = leg.id.bioguide;
    const birthday = leg.bio?.birthday;
    if (!bioguide || !birthday) {
      skipped++;
      continue;
    }

    const terms = leg.terms ?? [];
    const lastTerm = terms[terms.length - 1];
    if (!lastTerm) {
      skipped++;
      continue;
    }

    const lisId = leg.id.lis ?? "";
    const state = lastTerm.state;
    const party = lastTerm.party ?? "Unknown";
    const chamber = lastTerm.type === "sen" ? "Senate" : "House";
    const name = leg.name.official_full ?? `${leg.name.first} ${leg.name.last}`;

    members.push(
      buildMemberAge({ bioguide, lisId, name, state, party, chamber, birthday }, now)
    );

    if (chamber === "Senate") senateCount++;
    else houseCount++;
  }

  if (skipped > 0) {
    console.warn(`⚠️  Skipped ${skipped} legislator(s) missing bioguide or birthday`);
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    source: "unitedstates/congress-legislators (gh-pages branch)",
    note: "Ages auto-recompute from birthdays at run time; refresh when the roster changes (new Congress, special elections)",
    totalMembers: members.length,
    members,
  };

  fs.writeFileSync(MEMBER_AGE_FILE, JSON.stringify(output, null, 2));
  console.log(`✅ Saved ${members.length} member ages (${senateCount} Senate, ${houseCount} House) → ${MEMBER_AGE_FILE}`);
}

// ---------------------------------------------------------------------------
// Refresh member tenures
//
// Same source and shape as the age refresh, reading `terms` instead of `bio`.
// Only days inside a term are counted, so a member who left Congress and came
// back is credited for the time served, not the time since they first arrived.
// ---------------------------------------------------------------------------

async function refreshMemberTenures(): Promise<void> {
  console.log("⏳ Fetching member tenures from congress-legislators...");

  const resp = await fetch(LEGISLATORS_URL, {
    headers: { "User-Agent": "votes-actually (educational project)" },
  });
  if (!resp.ok) throw new Error(`Legislators fetch error: ${resp.status} ${resp.statusText}`);

  const legislators = (await resp.json()) as Array<{
    id: { bioguide: string; lis?: string };
    name: { official_full?: string; first: string; last: string };
    terms: Array<{ type: string; state: string; party?: string; start: string; end?: string }>;
  }>;

  const now = new Date();
  const members: MemberTenure[] = [];
  let senateCount = 0;
  let houseCount = 0;
  let skipped = 0;

  for (const leg of legislators) {
    const bioguide = leg.id.bioguide;
    const terms = leg.terms ?? [];
    const lastTerm = terms[terms.length - 1];
    if (!bioguide || !lastTerm) {
      skipped++;
      continue;
    }

    // Skipping rather than defaulting: a member with no term covering today has
    // no time in office to report, and a zero would quietly drag the averages
    // down instead of showing up as an unmatched voter in the bot's output.
    const service = summarizeService(terms as ServiceTerm[], now);
    if (!service) {
      skipped++;
      continue;
    }

    const lisId = leg.id.lis ?? "";
    const state = lastTerm.state;
    const party = lastTerm.party ?? "Unknown";
    const chamber = lastTerm.type === "sen" ? "Senate" : "House";
    const name = leg.name.official_full ?? `${leg.name.first} ${leg.name.last}`;

    members.push(
      buildMemberTenure(
        {
          bioguide,
          lisId,
          name,
          state,
          party,
          chamber,
          priorServiceDays: service.priorServiceDays,
          currentTermStart: service.currentTermStart,
        },
        now
      )
    );

    if (chamber === "Senate") senateCount++;
    else houseCount++;
  }

  if (skipped > 0) {
    console.warn(`⚠️  Skipped ${skipped} legislator(s) missing bioguide or a current term`);
  }

  const output = {
    fetchedAt: now.toISOString(),
    source: "unitedstates/congress-legislators (gh-pages branch)",
    note:
      "Tenure is total time served in Congress (both chambers, gaps in service excluded), " +
      "in whole years per member. Values auto-recompute from the stored term dates at run " +
      "time; refresh when the roster changes (new Congress, special elections).",
    totalMembers: members.length,
    members,
  };

  fs.writeFileSync(MEMBER_TENURE_FILE, JSON.stringify(output, null, 2));
  console.log(
    `✅ Saved ${members.length} member tenures (${senateCount} Senate, ${houseCount} House) → ${MEMBER_TENURE_FILE}`
  );
}

// ---------------------------------------------------------------------------
// Refresh member net worths
//
// This is by far the heaviest refresh, and the only one whose source doesn't
// hand us numbers. Congress discloses assets and liabilities in *brackets*, in
// per-member PDFs (House) and HTML behind a session flow (Senate), keyed by
// name rather than by any ID the vote feeds use. So the pipeline is:
//
//   congress-legislators  →  roster with BioGuide + LIS IDs
//   House ZIP + PDFs      ┐
//   Senate eFD HTML       ┘→  bracketed asset/liability totals, keyed by name
//   disclosureJoin        →  name+state/district → BioGuide
//   netWorthRange         →  assets − liabilities, as a range
//
// Every figure that comes out is a derived estimate with an explicit range, not
// a reported fact. See BRIEF.md for the methodology and its limits.
// ---------------------------------------------------------------------------

/** Builds the roster the disclosure join matches against. */
async function fetchRoster(): Promise<RosterMember[]> {
  const resp = await fetch(LEGISLATORS_URL, {
    headers: { "User-Agent": "votes-actually (educational project)" },
  });
  if (!resp.ok) throw new Error(`Legislators fetch error: ${resp.status} ${resp.statusText}`);

  const legislators = (await resp.json()) as Array<{
    id: { bioguide: string; lis?: string };
    name: { official_full?: string; first: string; last: string };
    terms: Array<{ type: string; state: string; district?: number; party?: string }>;
  }>;

  const roster: RosterMember[] = [];
  for (const leg of legislators) {
    const terms = leg.terms ?? [];
    const lastTerm = terms[terms.length - 1];
    if (!leg.id.bioguide || !lastTerm) continue;

    roster.push({
      bioguide: leg.id.bioguide,
      lisId: leg.id.lis ?? "",
      name: leg.name.official_full ?? `${leg.name.first} ${leg.name.last}`,
      state: lastTerm.state,
      district: lastTerm.type === "sen" ? "" : String(lastTerm.district ?? 0).padStart(2, "0"),
      party: lastTerm.party ?? "Unknown",
      chamber: lastTerm.type === "sen" ? "Senate" : "House",
    });
  }
  return roster;
}

/** Pulls both chambers for one report year, tolerating a failure in either. */
async function fetchDisclosuresForYear(reportYear: number): Promise<RawDisclosure[]> {
  const disclosures: RawDisclosure[] = [];

  try {
    const house = await fetchHouseDisclosures(reportYear);
    disclosures.push(...house.disclosures);
    console.log(
      `   🏠 House ${reportYear}: ${house.disclosures.length} parsed, ${house.skipped.length} skipped.`
    );
  } catch (err) {
    console.error(`   ❌ House ${reportYear} disclosures failed:`, (err as Error).message);
  }

  try {
    const senate = await fetchSenateDisclosures(reportYear);
    disclosures.push(...senate.disclosures);
    console.log(
      `   🏛️  Senate ${reportYear}: ${senate.disclosures.length} parsed, ${senate.skipped.length} skipped.`
    );
  } catch (err) {
    console.error(`   ❌ Senate ${reportYear} disclosures failed:`, (err as Error).message);
  }

  return disclosures;
}

function toMemberNetWorth(
  member: RosterMember,
  disclosure: RawDisclosure,
  asOf: Date
): MemberNetWorth {
  const range = netWorthRange(disclosure.assets, disclosure.liabilities);
  return buildMemberNetWorth(
    {
      bioguide: member.bioguide,
      lisId: member.lisId,
      name: member.name,
      state: member.state,
      party: member.party,
      chamber: member.chamber,
      netWorthLow: range.low,
      netWorthHigh: range.high,
      disclosureYear: disclosure.reportYear,
    },
    asOf
  );
}

async function refreshMemberNetWorths(): Promise<void> {
  console.log("💰 Building member net worths from financial disclosures...");

  const roster = await fetchRoster();
  console.log(`   👥 Roster: ${roster.length} sitting members.`);

  // The annual report filed in May covers the *previous* calendar year, and a
  // large share of members take a filing extension into August/November. So the
  // most recent report year is always partially filed: start there for freshness,
  // then backfill anyone still missing from the year before, which is complete.
  // Each member's own `disclosureYear` records which one they came from.
  const now = new Date();
  const primaryYear = now.getFullYear() - 1;
  const fallbackYear = primaryYear - 1;

  console.log(`\n   📅 Primary report year: ${primaryYear}`);
  const primary = await fetchDisclosuresForYear(primaryYear);
  let join = joinDisclosures(primary, roster);
  console.log(
    `   🔗 Matched ${join.matched.length}/${roster.length} members ` +
    `(${join.unmatched.length} filings unmatched).`
  );

  const entries = new Map<string, MemberNetWorth>();
  // Kept alongside the entries so the quality warnings below cover backfilled
  // members too, not just the ones matched in the primary year.
  const usedDisclosures: RawDisclosure[] = [];

  for (const { member, disclosure } of join.matched) {
    entries.set(member.bioguide, toMemberNetWorth(member, disclosure, now));
    usedDisclosures.push(disclosure);
  }

  if (join.missing.length > 0) {
    console.log(
      `\n   📅 ${join.missing.length} member(s) have no ${primaryYear} report — ` +
      `backfilling from ${fallbackYear}.`
    );
    const fallback = await fetchDisclosuresForYear(fallbackYear);
    // Join against only the still-missing members so a stale filing can never
    // overwrite a fresher one that already matched.
    const backfill = joinDisclosures(fallback, join.missing);
    for (const { member, disclosure } of backfill.matched) {
      entries.set(member.bioguide, toMemberNetWorth(member, disclosure, now));
      usedDisclosures.push(disclosure);
    }
    console.log(`   🔗 Backfilled ${backfill.matched.length} member(s) from ${fallbackYear}.`);
    join = { ...join, missing: backfill.missing };
  }

  const members = [...entries.values()];
  if (members.length === 0) {
    throw new Error(
      "No disclosures could be matched to any sitting member. Refusing to write an empty " +
      "cache — the bot would then post nothing rather than post something wrong, but this " +
      "almost certainly means a source format changed. Check the House ZIP and Senate eFD."
    );
  }

  const senateCount = members.filter((m) => m.chamber === "Senate").length;
  const houseCount = members.length - senateCount;
  const coverage = members.length / roster.length;
  const withUnparsed = usedDisclosures.filter((d) => d.unparsedRows > 0).length;
  const byYear = new Map<number, number>();
  for (const d of usedDisclosures) byYear.set(d.reportYear, (byYear.get(d.reportYear) ?? 0) + 1);

  const output = {
    fetchedAt: now.toISOString(),
    source: "US House Clerk financial disclosures + US Senate eFD (annual reports)",
    note:
      "Net worth is a DERIVED ESTIMATE, not a reported figure. Disclosure law requires only " +
      "bracketed ranges, so each member's netWorthLow/netWorthHigh are the summed bracket " +
      "bounds (assets minus liabilities) and netWorth is their midpoint. Spouse and joint " +
      "holdings are included; an open-ended top bracket is counted at one dollar above its " +
      `threshold. Refresh every ${NET_WORTH_REFRESH_DAYS} days and after the mid-May filing deadline.`,
    disclosureYear: primaryYear,
    totalMembers: members.length,
    rosterSize: roster.length,
    coverage: Number(coverage.toFixed(4)),
    membersWithUnparsedRows: withUnparsed,
    members,
  };

  fs.writeFileSync(MEMBER_NET_WORTH_FILE, JSON.stringify(output, null, 2));

  console.log(
    `\n✅ Saved ${members.length} member net worths (${senateCount} Senate, ${houseCount} House) ` +
    `→ ${MEMBER_NET_WORTH_FILE}`
  );
  console.log(`   📊 Roster coverage: ${(coverage * 100).toFixed(1)}%`);
  for (const [year, count] of [...byYear.entries()].sort((a, b) => b[0] - a[0])) {
    console.log(`   📅 ${count} member(s) from ${year} disclosures.`);
  }
  if (join.missing.length > 0) {
    console.warn(`   ⚠️  ${join.missing.length} sitting member(s) have no usable disclosure:`);
    for (const m of join.missing.slice(0, 10)) {
      console.warn(`      · ${m.name} (${m.chamber}, ${m.state}${m.district ? `-${m.district}` : ""})`);
    }
    if (join.missing.length > 10) console.warn(`      … and ${join.missing.length - 10} more.`);
  }
  if (withUnparsed > 0) {
    console.warn(
      `   ⚠️  ${withUnparsed} member(s) had rows whose value couldn't be parsed — ` +
      `their totals understate reality.`
    );
  }
}

// ---------------------------------------------------------------------------
// Show cache status
// ---------------------------------------------------------------------------

function showCacheStatus(): void {
  console.log("\n📋 Cache status:");

  const files = [
    { label: "State populations", path: STATE_POP_FILE },
    { label: "District populations", path: DISTRICT_POP_FILE },
    { label: "Member→district map", path: MEMBER_DISTRICT_FILE },
    { label: "Member ages", path: MEMBER_AGE_FILE },
    { label: "Member tenures", path: MEMBER_TENURE_FILE },
    { label: "Member net worths", path: MEMBER_NET_WORTH_FILE },
  ];

  for (const f of files) {
    if (fs.existsSync(f.path)) {
      const data = JSON.parse(fs.readFileSync(f.path, "utf-8")) as { fetchedAt: string };
      const age = Math.round((Date.now() - new Date(data.fetchedAt).getTime()) / (1000 * 60 * 60 * 24));
      console.log(`   ✅ ${f.label}: cached ${age} day(s) ago`);
    } else {
      console.log(`   ❌ ${f.label}: not cached`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Congress Vote Bots — Cache Refresh");
  console.log("=".repeat(60));
  console.log();

  ensureDataDir();

  const args = process.argv.slice(2);
  const refreshAll = args.length === 0;
  const refreshCensus = refreshAll || args.includes("--census");
  const refreshMembers = refreshAll || args.includes("--members");
  const refreshAges = refreshAll || args.includes("--ages");
  const refreshTenure = refreshAll || args.includes("--tenure");
  const refreshNetWorth = refreshAll || args.includes("--networth");

  if (refreshCensus) {
    try {
      await refreshStatePopulations();
    } catch (err) {
      console.error("❌ State population refresh failed:", err);
    }

    try {
      await refreshDistrictPopulations();
    } catch (err) {
      console.error("❌ District population refresh failed:", err);
    }
  }

  if (refreshMembers) {
    try {
      await refreshMemberDistricts();
    } catch (err) {
      console.error("❌ Member district refresh failed:", err);
    }
  }

  if (refreshAges) {
    try {
      await refreshMemberAges();
    } catch (err) {
      console.error("❌ Member age refresh failed:", err);
    }
  }

  if (refreshTenure) {
    try {
      await refreshMemberTenures();
    } catch (err) {
      console.error("❌ Member tenure refresh failed:", err);
    }
  }

  if (refreshNetWorth) {
    try {
      await refreshMemberNetWorths();
    } catch (err) {
      console.error("❌ Member net worth refresh failed:", err);
    }
  }

  showCacheStatus();

  console.log("=".repeat(60));
  console.log("  Cache refresh complete.");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
