/**
 * fetchVotes.ts
 *
 * The population bot: fetches the latest congressional votes and calculates the
 * US population represented by each side of the vote.
 *
 * Vote fetching itself lives in voteSources.ts, shared with the other bots.
 * This file only adds the population-specific analysis and post formatting.
 *
 * Loads slow-changing reference data from local cache files.
 * Run `npm run refresh-cache` to populate or update the cache.
 *
 * Usage:
 *   npm run fetch-votes
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { postToBluesky } from "./bluesky.js";
import { claimVote, releaseVote, highestSeenNumber } from "./seenVotes.js";
import { RawVote, fetchAllVotes } from "./voteSources.js";
import {
  StatePop,
  DistrictPop,
  MemberDistrict,
  VoteResult,
  calculateSenatePopulation,
  calculateHousePopulation,
  formatPop,
  formatPct,
  buildPopulationPost,
  graphemeLength,
  orderForPosting,
} from "./voteCalculations.js";

dotenv.config();

const SHOULD_POST = process.argv.includes("--post");
const SHOULD_WATCH = process.argv.includes("--watch");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MINUTES ?? 15) * 60 * 1000;

const BOT_ID = "population";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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
// Population analysis
//
// Senate: each senator represents their whole state, so the denominator is
// 2 × total US population. House: each member represents one district, so the
// denominator is the total US population.
// ---------------------------------------------------------------------------

function analyzeVote(
  vote: RawVote,
  statePops: Map<string, StatePop>,
  districtPops: Map<string, DistrictPop>,
  memberDistricts: Map<string, MemberDistrict>,
  totalPop: number
): VoteResult {
  let popYea: number;
  let popNay: number;
  let denominator: number;

  if (vote.chamber === "Senate") {
    ({ popYea, popNay } = calculateSenatePopulation(vote.members, statePops));
    denominator = totalPop * 2;
  } else {
    const result = calculateHousePopulation(vote.members, memberDistricts, districtPops);
    popYea = result.popYea;
    popNay = result.popNay;
    denominator = totalPop;
    if (result.unmatched > 0) {
      console.warn(
        `  ⚠️  ${vote.id}: ${result.matched} matched, ${result.unmatched} unmatched (likely delegates).`
      );
    }
  }

  return {
    ...vote,
    populationYea: popYea,
    populationNay: popNay,
    totalUsPopulation: totalPop,
    pctYea: popYea / denominator,
    pctNay: popNay / denominator,
  };
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
  let postedCount = 0;
  let skippedCount = 0;

  // Oldest-first: a partly-completed batch must leave the unposted votes ABOVE
  // the bot's high-water mark so the next run still finds them. See
  // orderForPosting() in voteCalculations.ts.
  for (const v of orderForPosting(allVotes)) {
    // Claim first, post second. The seen_votes primary key — not this loop — is
    // what guarantees a vote is never posted twice, even if two scheduled runs
    // overlap. claimVote throws if Supabase is unreachable, which aborts the
    // cycle rather than posting blind.
    if (!(await claimVote(BOT_ID, v.id))) {
      skippedCount++;
      continue;
    }
    try {
      const post = buildPopulationPost(v);
      await postToBluesky(BOT_ID, post.text, post.facets);
      postedCount++;
      console.log(`  ✅ Posted ${v.chamber} vote #${v.voteNumber} to Bluesky.`);
    } catch (err) {
      console.error(`  ❌ Failed to post ${v.chamber} vote #${v.voteNumber}:`, err);
      await releaseVote(BOT_ID, v.id);
    }
  }

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
  console.log("  Population Bot — Fetch Latest Votes");
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

  // Reach back past the newest few votes to anything published while no run
  // happened to fire. Only when posting: a plain fetch run must keep working
  // with no Supabase credentials, and baselining deliberately wants the
  // narrow window. See catchUpStart() in voteCalculations.ts.
  const rawVotes = await fetchAllVotes(
    SHOULD_POST ? (prefix) => highestSeenNumber(BOT_ID, prefix) : undefined
  );

  if (rawVotes.length === 0) {
    console.log("No votes retrieved. Check network connection and congress/session numbers.");
    return;
  }

  const totalPop = [...statePops.values()].reduce((sum, s) => sum + s.population, 0);
  const allVotes = rawVotes.map((v) =>
    analyzeVote(v, statePops, districtPops, memberDistricts, totalPop)
  );

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
