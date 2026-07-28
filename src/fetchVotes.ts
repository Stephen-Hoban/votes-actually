/**
 * fetchVotes.ts
 *
 * Fetches the latest congressional votes and calculates the US population
 * represented by each side of the vote.
 *
 * Loads slow-changing reference data from local cache files.
 * Run `npm run refresh-cache` to populate or update the cache.
 *
 * Data sources:
 *   - Senate votes:  senate.gov XML feeds (no API key needed)
 *   - House votes:   clerk.house.gov XML feeds (no API key needed)
 *   - Cache files:   data/ directory (populated by refreshCache.ts)
 *
 * Usage:
 *   npm run fetch-votes
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { parseStringPromise } from "xml2js";
import { postToBluesky } from "./bluesky.js";
import { loadSeenVotes, saveSeenVotes } from "./seenVotes.js";
import {
  StatePop,
  DistrictPop,
  MemberDistrict,
  VoteResult,
  extractText,
  computeCongressSession,
  calculateSenatePopulation,
  calculateHousePopulation,
  formatPop,
  formatPct,
  buildPopulationPost,
  buildBillUrl,
  graphemeLength,
  selectRecentSenateVotes,
} from "./voteCalculations.js";

dotenv.config();

const SHOULD_POST = process.argv.includes("--post");
const SHOULD_WATCH = process.argv.includes("--watch");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MINUTES ?? 15) * 60 * 1000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const VOTES_TO_SHOW = 5;

const DATA_DIR = path.join(process.cwd(), "data");
const DISTRICT_POP_FILE = path.join(DATA_DIR, "district-populations.json");
const MEMBER_DISTRICT_FILE = path.join(DATA_DIR, "member-districts.json");
const STATE_POP_FILE = path.join(DATA_DIR, "state-populations.json");

// ---------------------------------------------------------------------------
// Cache loading
// ---------------------------------------------------------------------------

function loadCache<T>(filePath: string, label: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Cache file not found: ${filePath}\n` +
      `Run "npm run refresh-cache" to populate the cache first.`
    );
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    fetchedAt: string;
  } & T;

  const ageDays = Math.round(
    (Date.now() - new Date(data.fetchedAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  console.log(`📦 Loaded ${label} from cache (${ageDays} day(s) old)`);
  return data as T;
}

function loadStatePops(): Map<string, StatePop> {
  const cache = loadCache<{ states: Record<string, StatePop> }>(
    STATE_POP_FILE,
    "state populations"
  );
  return new Map(Object.entries(cache.states));
}

function loadDistrictPops(): Map<string, DistrictPop> {
  const cache = loadCache<{ districts: Record<string, DistrictPop> }>(
    DISTRICT_POP_FILE,
    "district populations"
  );
  return new Map(Object.entries(cache.districts));
}

function loadMemberDistricts(): Map<string, MemberDistrict> {
  const cache = loadCache<{ members: Record<string, MemberDistrict> }>(
    MEMBER_DISTRICT_FILE,
    "member→district map"
  );
  return new Map(Object.entries(cache.members));
}

// ---------------------------------------------------------------------------
// Auto-detection: House year (Congress/session detection is in voteCalculations.ts)
// ---------------------------------------------------------------------------

async function urlExists(url: string): Promise<boolean> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "votes-actually (educational project)" },
  });
  return resp.ok;
}

// The Senate doesn't publish a session's vote_menu XML until that session's first
// vote happens (e.g. early January before floor activity starts). Fall back to the
// previous session if the calendar-derived one has no data yet.
async function detectCongressSession(): Promise<{ congress: number; session: number }> {
  let { congress, session } = computeCongressSession(new Date());

  const menuUrl = (c: number, s: number) =>
    `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${c}_${s}.xml`;

  if (await urlExists(menuUrl(congress, session))) return { congress, session };

  console.warn(
    `  ⚠️  No Senate vote data yet for ${congress}th Congress, Session ${session}. Falling back to previous session.`
  );
  if (session === 1) {
    congress -= 1;
    session = 2;
  } else {
    session = 1;
  }
  return { congress, session };
}

// The House rolls its vote numbering over on Jan 1 each calendar year. Fall back to
// the previous year if the new year has no roll call votes published yet.
async function detectHouseYear(): Promise<number> {
  const currentYear = new Date().getFullYear();
  const url = `https://clerk.house.gov/evs/${currentYear}/roll001.xml`;

  if (await urlExists(url)) return currentYear;

  console.warn(`  ⚠️  No House vote data yet for ${currentYear}. Falling back to ${currentYear - 1}.`);
  return currentYear - 1;
}

// ---------------------------------------------------------------------------
// Senate votes
// ---------------------------------------------------------------------------

async function fetchSenateVotes(
  statePops: Map<string, StatePop>,
  congressNum: number,
  senateSession: number
): Promise<VoteResult[]> {
  console.log(`\n🏛️  Fetching Senate votes (${congressNum}th Congress, Session ${senateSession})...`);

  const listUrl =
    `https://www.senate.gov/legislative/LIS/roll_call_lists/` +
    `vote_menu_${congressNum}_${senateSession}.xml`;

  const listResp = await fetch(listUrl, {
    headers: { "User-Agent": "votes-actually (educational project)" },
  });
  if (!listResp.ok) throw new Error(`Senate list error: ${listResp.status}`);

  const listXml = await listResp.text();
  const listData = await parseStringPromise(listXml, { explicitArray: false });

  const allVotes = listData.vote_summary.votes.vote;
  const voteArray: unknown[] = Array.isArray(allVotes) ? allVotes : [allVotes];
  const recentVotes = selectRecentSenateVotes(voteArray, VOTES_TO_SHOW);

  const totalPop = [...statePops.values()].reduce((sum, s) => sum + s.population, 0);
  const results: VoteResult[] = [];

  for (const vote of recentVotes) {
    const v = vote as Record<string, unknown>;
    const voteNum = String(v.vote_number).padStart(5, "0");

    const detailUrl =
      `https://www.senate.gov/legislative/LIS/roll_call_votes/` +
      `vote${congressNum}${senateSession}/` +
      `vote_${congressNum}_${senateSession}_${voteNum}.xml`;

    const detailResp = await fetch(detailUrl, {
      headers: { "User-Agent": "votes-actually (educational project)" },
    });
    if (!detailResp.ok) {
      console.warn(`  ⚠️  Could not fetch Senate vote #${voteNum}, skipping.`);
      continue;
    }

    const detailXml = await detailResp.text();
    const detail = await parseStringPromise(detailXml, { explicitArray: false });
    const rc = detail.roll_call_vote as Record<string, unknown>;

    const count = rc.count as Record<string, unknown> | undefined;
    const yeas = parseInt(extractText(count?.yeas), 10) || 0;
    const nays = parseInt(extractText(count?.nays), 10) || 0;

    const question = extractText(rc.vote_question_text) || extractText(v.question) || "Unknown";
    const description = extractText(rc.vote_title) || "";

    // Prefer the vote's own bill/resolution; for amendment votes (document_number
    // is blank) fall back to the bill/resolution the amendment applies to.
    const document = rc.document as Record<string, unknown> | undefined;
    const documentType = extractText(document?.document_type);
    const documentNumber = extractText(document?.document_number);
    const amendment = rc.amendment as Record<string, unknown> | undefined;
    const amendmentToDocument = extractText(amendment?.amendment_to_document_number);
    const billDesignation = documentNumber ? `${documentType} ${documentNumber}` : amendmentToDocument;
    const billUrl = billDesignation ? buildBillUrl(congressNum, billDesignation) : "";

    const membersRaw = (rc.members as Record<string, unknown>)?.member;
    const members: unknown[] = Array.isArray(membersRaw) ? membersRaw : [membersRaw];

    const memberVotes = members.map((m) => {
      const member = m as Record<string, unknown>;
      return {
        state: extractText(member.state),
        voteCast: extractText(member.vote_cast),
      };
    });

    const { popYea, popNay } = calculateSenatePopulation(memberVotes, statePops);

    results.push({
      id: `senate-${congressNum}-${senateSession}-${voteNum}`,
      chamber: "Senate",
      voteNumber: String(v.vote_number),
      date: extractText(rc.vote_date),
      question,
      description,
      result: extractText(rc.vote_result),
      yeas,
      nays,
      populationYea: popYea,
      populationNay: popNay,
      totalUsPopulation: totalPop,
      pctYea: popYea / (totalPop * 2),
      pctNay: popNay / (totalPop * 2),
      url:
        `https://www.senate.gov/legislative/LIS/roll_call_lists/` +
        `roll_call_vote_cfm.cfm?congress=${congressNum}&session=${senateSession}` +
        `&vote=${v.vote_number}`,
      billUrl,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// House votes
// ---------------------------------------------------------------------------

async function findLatestHouseRollNumber(houseYear: number): Promise<number> {
  const CEILING = 600;
  let lo = 1, hi = CEILING, latest = 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const url = `https://clerk.house.gov/evs/${houseYear}/roll${String(mid).padStart(3, "0")}.xml`;
    const resp = await fetch(url, { headers: { "User-Agent": "votes-actually" } });
    if (resp.ok) { latest = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return latest;
}

async function fetchHouseVotes(
  memberDistricts: Map<string, MemberDistrict>,
  districtPops: Map<string, DistrictPop>,
  statePops: Map<string, StatePop>,
  houseYear: number
): Promise<VoteResult[]> {
  console.log(`\n🏠  Fetching House votes (${houseYear})...`);
  console.log(`    Finding latest roll call number...`);

  const latestRoll = await findLatestHouseRollNumber(houseYear);
  console.log(`    Latest House roll call: #${latestRoll}`);

  const totalPop = [...statePops.values()].reduce((sum, s) => sum + s.population, 0);
  const results: VoteResult[] = [];

  for (let i = 0; i < VOTES_TO_SHOW; i++) {
    const rollNum = latestRoll - i;
    if (rollNum < 1) break;

    const paddedNum = String(rollNum).padStart(3, "0");
    const url = `https://clerk.house.gov/evs/${houseYear}/roll${paddedNum}.xml`;

    const resp = await fetch(url, { headers: { "User-Agent": "votes-actually" } });
    if (!resp.ok) {
      console.warn(`  ⚠️  Could not fetch House roll #${rollNum}, skipping.`);
      continue;
    }

    const xml = await resp.text();
    const data = await parseStringPromise(xml, { explicitArray: false });
    const doc = data["rollcall-vote"] as Record<string, unknown>;
    const meta = doc["vote-metadata"] as Record<string, unknown>;
    const voteData = doc["vote-data"] as Record<string, unknown>;

    const voteTotals = meta["vote-totals"] as Record<string, unknown>;
    const byVote = voteTotals["totals-by-vote"] as Record<string, unknown>;
    const yeas = parseInt(extractText(byVote["yea-total"]), 10) || 0;
    const nays = parseInt(extractText(byVote["nay-total"]), 10) || 0;

    const legisNum = extractText(meta["legis-num"]);
    const voteCongress = parseInt(extractText(meta["congress"]), 10);
    const billUrl = legisNum && voteCongress ? buildBillUrl(voteCongress, legisNum) : "";

    const recordedRaw = voteData["recorded-vote"];
    const members: unknown[] = Array.isArray(recordedRaw) ? recordedRaw : [recordedRaw];

    const memberVotes = members.map((m) => {
      const member = m as Record<string, unknown>;
      const leg = member.legislator as Record<string, unknown>;
      const attrs = leg?.$ as Record<string, string> | undefined;
      return {
        bioguide: attrs?.["name-id"] ?? "",
        voteCast: extractText(member.vote),
      };
    });

    const { popYea, popNay, matched, unmatched } = calculateHousePopulation(
      memberVotes,
      memberDistricts,
      districtPops
    );

    if (unmatched > 0) {
      console.warn(`  ⚠️  Roll #${rollNum}: ${matched} matched, ${unmatched} unmatched (likely delegates).`);
    }

    results.push({
      id: `house-${houseYear}-${paddedNum}`,
      chamber: "House",
      voteNumber: extractText(meta["rollcall-num"]),
      date: extractText(meta["action-date"]),
      question: extractText(meta["vote-question"]),
      description: extractText(meta["vote-desc"]),
      result: extractText(meta["vote-result"]),
      yeas,
      nays,
      populationYea: popYea,
      populationNay: popNay,
      totalUsPopulation: totalPop,
      pctYea: popYea / totalPop,
      pctNay: popNay / totalPop,
      url: `https://clerk.house.gov/Votes/${houseYear}${paddedNum}`,
      billUrl,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function printVoteResult(v: VoteResult): void {
  console.log("─".repeat(60));
  console.log(`${v.chamber.toUpperCase()} VOTE #${v.voteNumber}  |  ${v.date}`);
  console.log(`📋 ${v.question}`);
  if (v.description) console.log(`   ${v.description}`);
  console.log(`🗳️  Result: ${v.result}  (Yeas: ${v.yeas} | Nays: ${v.nays})`);
  console.log();
  console.log(`🇺🇸 Population represented:`);
  console.log(`   ✅ YES: ${formatPop(v.populationYea)} people (${formatPct(v.pctYea)} of US pop)`);
  console.log(`   ❌  NO: ${formatPop(v.populationNay)} people (${formatPct(v.pctNay)} of US pop)`);
  console.log();

  const post = buildPopulationPost(v);
  console.log(`📱 Sample Bluesky post (${graphemeLength(post.text)} graphemes):`);
  console.log(post.text);
  if (post.facets.length > 0) console.log(`   🔗 links to: ${post.facets[0].uri}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Posting (dedupe against already-seen votes)
// ---------------------------------------------------------------------------

async function postNewVotes(allVotes: VoteResult[]): Promise<void> {
  const botId = "population";
  const seen = loadSeenVotes(botId);
  let postedCount = 0;
  let skippedCount = 0;

  for (const v of allVotes) {
    if (seen.has(v.id)) {
      skippedCount++;
      continue;
    }
    try {
      const post = buildPopulationPost(v);
      await postToBluesky(botId, post.text, post.facets);
      seen.add(v.id);
      postedCount++;
      console.log(`  ✅ Posted ${v.chamber} vote #${v.voteNumber} to Bluesky.`);
    } catch (err) {
      console.error(`  ❌ Failed to post ${v.chamber} vote #${v.voteNumber}:`, err);
    }
  }

  saveSeenVotes(botId, seen);
  console.log(`\n📬 Posting summary: ${postedCount} new, ${skippedCount} already posted before.\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Congress Vote Bots — Fetch Latest Votes");
  console.log("=".repeat(60));
  console.log();

  // Load all reference data from cache (fast — no network calls)
  let statePops: Map<string, StatePop>;
  let districtPops: Map<string, DistrictPop>;
  let memberDistricts: Map<string, MemberDistrict>;

  try {
    statePops = loadStatePops();
    districtPops = loadDistrictPops();
    memberDistricts = loadMemberDistricts();
  } catch (err) {
    console.error("\n❌", (err as Error).message);
    process.exit(1);
  }

  console.log();

  // Auto-detect current Congress/session/year from the live calendar and site data
  const { congress: congressNum, session: senateSession } = await detectCongressSession();
  const houseYear = await detectHouseYear();

  // Fetch live vote data (always fresh)
  let senateVotes: VoteResult[] = [];
  try {
    senateVotes = await fetchSenateVotes(statePops, congressNum, senateSession);
    console.log(`✅ Retrieved ${senateVotes.length} Senate votes.\n`);
  } catch (err) {
    console.error("❌ Senate fetch failed:", err);
  }

  let houseVotes: VoteResult[] = [];
  try {
    houseVotes = await fetchHouseVotes(memberDistricts, districtPops, statePops, houseYear);
    console.log(`✅ Retrieved ${houseVotes.length} House votes.\n`);
  } catch (err) {
    console.error("❌ House fetch failed:", err);
  }

  const allVotes = [...senateVotes, ...houseVotes];

  if (allVotes.length === 0) {
    console.log("No votes retrieved. Check network connection and congress/session numbers.");
    return;
  }

  console.log("\n" + "=".repeat(60));
  console.log("  RESULTS");
  console.log("=".repeat(60) + "\n");

  for (const v of allVotes) {
    printVoteResult(v);
  }

  if (SHOULD_POST) {
    await postNewVotes(allVotes);
  }

  console.log("=".repeat(60));
  console.log(`  Done. Processed ${allVotes.length} votes.`);
  console.log("=".repeat(60));
}

async function main(): Promise<void> {
  await runOnce();

  if (SHOULD_WATCH) {
    const minutes = POLL_INTERVAL_MS / 60000;
    console.log(`\n👀 Watching for new votes every ${minutes} minute(s). Press Ctrl+C to stop.\n`);
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      await runOnce();
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
