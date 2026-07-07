/**
 * refreshCache.ts
 *
 * Fetches slow-changing reference data and saves it to local JSON files.
 * Run this manually when needed — not on every vote fetch.
 *
 * When to refresh:
 *   district-populations.json  → After each decennial Census (next: ~2031)
 *   member-districts.json      → Start of each Congress + after special elections
 *
 * Usage:
 *   npm run refresh-cache              — refresh everything
 *   npm run refresh-cache -- --members — refresh member→district map only
 *   npm run refresh-cache -- --census  — refresh district populations only
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const CENSUS_API_KEY = process.env.CENSUS_API_KEY ?? "";

const LEGISLATORS_URL =
  "https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages/legislators-current.json";

const DATA_DIR = path.join(process.cwd(), "data");
const DISTRICT_POP_FILE = path.join(DATA_DIR, "district-populations.json");
const MEMBER_DISTRICT_FILE = path.join(DATA_DIR, "member-districts.json");
const STATE_POP_FILE = path.join(DATA_DIR, "state-populations.json");

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

  const resp = await fetch(url);
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

  const resp = await fetch(url);
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

  const resp = await fetch(LEGISLATORS_URL);
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
// Show cache status
// ---------------------------------------------------------------------------

function showCacheStatus(): void {
  console.log("\n📋 Cache status:");

  const files = [
    { label: "State populations", path: STATE_POP_FILE },
    { label: "District populations", path: DISTRICT_POP_FILE },
    { label: "Member→district map", path: MEMBER_DISTRICT_FILE },
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

  showCacheStatus();

  console.log("=".repeat(60));
  console.log("  Cache refresh complete.");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
