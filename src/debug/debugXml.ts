/**
 * debugXml.ts
 * Temporary script to inspect the raw parsed XML structure from senate.gov and clerk.house.gov
 * Run with: npx tsx src/debugXml.ts
 */

import { parseStringPromise } from "xml2js";

async function debugSenate() {
  console.log("=== SENATE VOTE #1 RAW XML STRUCTURE ===\n");
  const url = "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00001.xml";
  const resp = await fetch(url, { headers: { "User-Agent": "votes-actually-debug" } });
  const xml = await resp.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const rc = parsed.roll_call_vote;

  console.log("Top-level keys:", Object.keys(rc));
  console.log("\nvote_tally:", JSON.stringify(rc.vote_tally, null, 2));
  console.log("\nvote_date:", rc.vote_date);
  console.log("\nvote_result:", rc.vote_result);
  console.log("\nvote_question:", rc.vote_question);
  console.log("\nvote_title:", rc.vote_title);

  // Show first member to check structure
  const members = Array.isArray(rc.members.member) ? rc.members.member : [rc.members.member];
  console.log("\nFirst member:", JSON.stringify(members[0], null, 2));
}

async function debugHouse() {
  console.log("\n=== HOUSE ROLL #362 RAW XML STRUCTURE ===\n");
  const url = "https://clerk.house.gov/evs/2025/roll362.xml";
  const resp = await fetch(url, { headers: { "User-Agent": "votes-actually-debug" } });

  if (!resp.ok) {
    console.log(`HTTP error: ${resp.status} — trying roll360 instead`);
    const resp2 = await fetch("https://clerk.house.gov/evs/2025/roll360.xml", {
      headers: { "User-Agent": "votes-actually-debug" }
    });
    const xml2 = await resp2.text();
    const parsed2 = await parseStringPromise(xml2, { explicitArray: false });
    console.log("Top-level keys:", Object.keys(parsed2));
    const topKey = Object.keys(parsed2)[0];
    const doc = parsed2[topKey];
    console.log("Second-level keys:", Object.keys(doc));
    return;
  }

  const xml = await resp.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });

  console.log("Top-level keys:", Object.keys(parsed));
  const topKey = Object.keys(parsed)[0];
  const doc = parsed[topKey];
  console.log("Second-level keys:", Object.keys(doc));

  // Try to find vote_metadata at various levels
  if (doc.vote_metadata) {
    console.log("\nvote_metadata keys:", Object.keys(doc.vote_metadata));
    console.log("\nvote_metadata sample:", JSON.stringify(doc.vote_metadata, null, 2).slice(0, 800));
  } else {
    console.log("\nNo vote_metadata at top level — full structure:");
    console.log(JSON.stringify(doc, null, 2).slice(0, 1500));
  }

  // Show first recorded vote
  const voteData = doc.vote_data || doc.votes;
  if (voteData) {
    const recorded = voteData.recorded_vote || voteData.vote;
    const first = Array.isArray(recorded) ? recorded[0] : recorded;
    console.log("\nFirst recorded vote:", JSON.stringify(first, null, 2));
  }
}

async function main() {
  try { await debugSenate(); } catch (e) { console.error("Senate debug error:", e); }
  try { await debugHouse(); } catch (e) { console.error("House debug error:", e); }
}

main();
