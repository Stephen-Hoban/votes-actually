/**
 * fetchTenureVotes.ts
 *
 * The tenure bot: fetches the latest congressional votes and calculates the
 * average time in office of the members who voted yea vs. nay.
 *
 * Vote fetching itself lives in voteSources.ts, shared with the population bot.
 * This file only adds the tenure-specific analysis and post formatting.
 *
 * Tenure comes from data/member-tenure.json (congressional terms via
 * congress-legislators). Run `npm run refresh-tenure` to populate or update the
 * cache. Cached tenures self-heal on each run as members pass service
 * anniversaries — a full refresh is only needed when the roster changes (new
 * Congress, special elections).
 *
 * Usage:
 *   npm run fetch-tenure        — fetch and print, no posting
 *   npm run post-tenure         — fetch and post new votes to Bluesky
 *   npm run watch-tenure        — same, looping on POLL_INTERVAL_MINUTES
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { postToBluesky } from "./bluesky.js";
import { claimVote, releaseVote, highestSeenNumber } from "./seenVotes.js";
import { RawVote, fetchAllVotes } from "./voteSources.js";
import { billLine, graphemeLength, orderForPosting } from "./voteCalculations.js";
import {
  MemberTenure,
  MemberTenureIndex,
  TenureVoteResult,
  buildMemberTenureIndex,
  calculateAverageTenures,
  refreshStaleTenures,
  formatTenure,
  buildTenurePost,
} from "./tenureCalculations.js";

dotenv.config();

const SHOULD_POST = process.argv.includes("--post");
const SHOULD_WATCH = process.argv.includes("--watch");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MINUTES ?? 15) * 60 * 1000;

const BOT_ID = "tenure";

const DATA_DIR = path.join(process.cwd(), "data");
const MEMBER_TENURE_FILE = path.join(DATA_DIR, "member-tenure.json");

interface MemberTenureCache {
  fetchedAt: string;
  members: MemberTenure[];
}

// ---------------------------------------------------------------------------
// Tenure cache: load, then bring any anniversary-expired tenures up to date
// ---------------------------------------------------------------------------

function loadMemberTenures(): MemberTenure[] {
  if (!fs.existsSync(MEMBER_TENURE_FILE)) {
    throw new Error(
      `Cache file not found: ${MEMBER_TENURE_FILE}\n` +
      `Run "npm run refresh-tenure" to populate the cache first.`
    );
  }

  const cache = JSON.parse(fs.readFileSync(MEMBER_TENURE_FILE, "utf-8")) as MemberTenureCache;
  const ageDays = Math.round(
    (Date.now() - new Date(cache.fetchedAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  console.log(`📦 Loaded ${cache.members.length} member tenures from cache (${ageDays} day(s) old)`);
  return cache.members;
}

// A cached tenure only goes stale on one predictable date — the member's next
// service anniversary — so instead of refetching the roster, recompute just
// those entries from the term dates we already have and write them back.
function applyAnniversaries(members: MemberTenure[]): void {
  const refreshed = refreshStaleTenures(members, new Date());
  if (refreshed.length === 0) return;

  for (const m of refreshed) {
    console.log(`  ⏳ ${m.name} has now served ${m.tenureYears} year(s).`);
  }

  // Writing back is an optimization, not a requirement: `members` is already
  // corrected in memory for this run, and a scheduled Actions container throws
  // its filesystem away anyway. So a failed write must not abort the run — it
  // just means the next run recomputes the same anniversaries.
  try {
    const cache = JSON.parse(fs.readFileSync(MEMBER_TENURE_FILE, "utf-8")) as MemberTenureCache;
    cache.members = members;
    fs.writeFileSync(MEMBER_TENURE_FILE, JSON.stringify(cache, null, 2));
    console.log(`  ✅ Updated ${refreshed.length} cached tenure(s).`);
  } catch (err) {
    console.warn(`  ⚠️  Could not write updated tenures back to cache: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Tenure analysis
// ---------------------------------------------------------------------------

function analyzeVote(vote: RawVote, tenures: MemberTenureIndex): TenureVoteResult {
  const breakdown = calculateAverageTenures(vote.members, tenures);

  if (breakdown.unmatched > 0) {
    console.warn(
      `  ⚠️  ${vote.id}: ${breakdown.matched} matched, ${breakdown.unmatched} with no service record on file.`
    );
  }

  return { ...vote, ...breakdown };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function printVoteResult(v: TenureVoteResult): void {
  console.log("─".repeat(60));
  console.log(`${v.chamber.toUpperCase()} VOTE #${v.voteNumber}  |  ${v.date}`);
  console.log(`📋 ${v.question}`);
  const bill = billLine(v);
  if (bill) console.log(`   ${bill}`);
  console.log(`🗳️  Result: ${v.result}  (Yeas: ${v.yeas} | Nays: ${v.nays})`);
  console.log();
  console.log(`⏳ Average time in office:`);
  console.log(`   ✅ YES: ${formatTenure(v.avgTenureYea, v.countYea)}`);
  console.log(`   ❌  NO: ${formatTenure(v.avgTenureNay, v.countNay)}`);
  console.log();

  const post = buildTenurePost(v);
  console.log(`📱 Sample Bluesky post (${graphemeLength(post.text)} graphemes):`);
  console.log(post.text);
  if (post.facets.length > 0) console.log(`   🔗 links to: ${post.facets[0].uri}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Posting (dedupe against already-seen votes)
// ---------------------------------------------------------------------------

async function postNewVotes(allVotes: TenureVoteResult[]): Promise<void> {
  let postedCount = 0;
  let skippedCount = 0;

  // Oldest-first: a partly-completed batch must leave the unposted votes ABOVE
  // the bot's high-water mark so the next run still finds them. See
  // orderForPosting() in voteCalculations.ts.
  for (const v of orderForPosting(allVotes)) {
    // Claim first, post second — see the identical comment in fetchVotes.ts.
    if (!(await claimVote(BOT_ID, v.id))) {
      skippedCount++;
      continue;
    }
    try {
      const post = buildTenurePost(v);
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
  console.log("  Tenure Bot — Fetch Latest Votes");
  console.log("=".repeat(60));
  console.log();

  let memberTenures: MemberTenure[];
  try {
    memberTenures = loadMemberTenures();
    applyAnniversaries(memberTenures);
  } catch (err) {
    console.error("\n❌", (err as Error).message);
    process.exit(1);
  }

  const tenures = buildMemberTenureIndex(memberTenures);
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

  const allVotes = rawVotes.map((v) => analyzeVote(v, tenures));

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
