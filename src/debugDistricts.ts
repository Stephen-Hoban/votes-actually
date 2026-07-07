/**
 * debugDistricts.ts
 * Diagnoses the district key mismatch between House XML and Census API
 * Run with: npx tsx src/debugDistricts.ts
 */

import * as dotenv from "dotenv";
import { parseStringPromise } from "xml2js";
dotenv.config();

const CENSUS_API_KEY = process.env.CENSUS_API_KEY ?? "";

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
const FIPS_TO_STATE_ABBR = Object.fromEntries(
  Object.entries(STATE_ABBR_TO_FIPS).map(([a, f]) => [f, a])
);

async function main() {
  // 1. Fetch first 10 Census district keys
  console.log("=== CENSUS DISTRICT KEYS (first 20) ===");
  const censusUrl =
    `https://api.census.gov/data/2022/acs/acs5?get=NAME,B01003_001E` +
    `&for=congressional%20district:*&in=state:*&key=${CENSUS_API_KEY}`;
  const censusResp = await fetch(censusUrl);
  const censusData = (await censusResp.json()) as string[][];
  const [, ...rows] = censusData;
  
  // Show first 20 rows raw
  for (const row of rows.slice(0, 20)) {
    const [name, pop, stateFips, districtCode] = row;
    const stateAbbr = FIPS_TO_STATE_ABBR[stateFips];
    console.log(`  Raw: state=${stateFips}(${stateAbbr}) district=${districtCode} | Key would be: ${stateAbbr}-${districtCode} | ${name}`);
  }

  // 2. Fetch House XML and show first 10 member district attributes
  console.log("\n=== HOUSE XML MEMBER DISTRICT ATTRIBUTES (first 20) ===");
  const houseResp = await fetch("https://clerk.house.gov/evs/2025/roll362.xml", {
    headers: { "User-Agent": "debug" }
  });
  const xml = await houseResp.text();
  const data = await parseStringPromise(xml, { explicitArray: false });
  const doc = data["rollcall-vote"] as Record<string, unknown>;
  const voteData = doc["vote-data"] as Record<string, unknown>;
  const members = voteData["recorded-vote"] as unknown[];

  for (const m of (members as Record<string, unknown>[]).slice(0, 20)) {
    const leg = m.legislator as Record<string, unknown>;
    const attrs = leg?.$ as Record<string, string>;
    console.log(`  state=${attrs?.state} district=${attrs?.district} name=${attrs?.["unaccented-name"] ?? attrs?.["sort-field"]}`);
  }
}

main().catch(console.error);
