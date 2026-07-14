/**
 * debugDistricts2.ts — inspect the raw legislator XML element structure
 */
import * as dotenv from "dotenv";
import { parseStringPromise } from "xml2js";
dotenv.config();

async function main() {
  const resp = await fetch("https://clerk.house.gov/evs/2025/roll362.xml", {
    headers: { "User-Agent": "debug" }
  });
  const xml = await resp.text();

  // Print the raw XML for the first 3 recorded-vote entries
  // so we can see exactly what the legislator element looks like
  const start = xml.indexOf("<recorded-vote>");
  const snippet = xml.slice(start, start + 2000);
  console.log("=== RAW XML (first ~2000 chars of vote-data) ===\n");
  console.log(snippet);

  // Also parse and show the full first member object
  const data = await parseStringPromise(xml, { explicitArray: false });
  const doc = data["rollcall-vote"] as Record<string, unknown>;
  const voteData = doc["vote-data"] as Record<string, unknown>;
  const members = voteData["recorded-vote"] as Record<string, unknown>[];
  
  console.log("\n=== PARSED FIRST MEMBER (full object) ===\n");
  console.log(JSON.stringify(members[0], null, 2));
  
  console.log("\n=== PARSED SECOND MEMBER (full object) ===\n");
  console.log(JSON.stringify(members[1], null, 2));
}

main().catch(console.error);
