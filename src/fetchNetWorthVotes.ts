/**
 * fetchNetWorthVotes.ts
 *
 * The net worth bot: fetches the latest congressional votes and calculates the
 * average estimated net worth of the members who voted yea vs. nay.
 *
 * Vote fetching itself lives in voteSources.ts, shared with the population and
 * age bots. This file only adds the net worth-specific analysis and posting.
 *
 * Net worth figures come from data/member-networth.json, built from the annual
 * House/Senate financial disclosures. Run `npm run refresh-networth` to
 * populate or update the cache. Unlike ages, these cannot self-heal at run
 * time — a stale entry needs a new disclosure — so this script warns loudly
 * when the cache is past its re-check date instead of silently posting old
 * numbers.
 *
 * Usage:
 *   npm run fetch-networth      — fetch and print, no posting
 *   npm run post-networth       — fetch and post new votes to Bluesky
 *   npm run watch-networth      — same, looping on POLL_INTERVAL_MINUTES
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { postToBluesky } from "./bluesky.js";
import { claimVote, releaseVote } from "./seenVotes.js";
import { RawVote, fetchAllVotes } from "./voteSources.js";
import { graphemeLength } from "./voteCalculations.js";
import {
  MemberNetWorth,
  MemberNetWorthIndex,
  NetWorthVoteResult,
  buildMemberNetWorthIndex,
  calculateNetWorthBreakdown,
  findStaleNetWorths,
  hasSufficientCoverage,
  formatNetWorth,
  buildNetWorthPost,
  MIN_COVERAGE,
} from "./netWorthCalculations.js";

dotenv.config();

const SHOULD_POST = process.argv.includes("--post");
const SHOULD_WATCH = process.argv.includes("--watch");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MINUTES ?? 15) * 60 * 1000;

const BOT_ID = "networth";

const DATA_DIR = path.join(process.cwd(), "data");
const MEMBER_NET_WORTH_FILE = path.join(DATA_DIR, "member-networth.json");

interface MemberNetWorthCache {
  fetchedAt: string;
  source: string;
  disclosureYear: number;
  members: MemberNetWorth[];
}

// ---------------------------------------------------------------------------
// Net worth cache: load, then report anything past its re-check date
// ---------------------------------------------------------------------------

function loadMemberNetWorths(): MemberNetWorth[] {
  if (!fs.existsSync(MEMBER_NET_WORTH_FILE)) {
    throw new Error(
      `Cache file not found: ${MEMBER_NET_WORTH_FILE}\n` +
      `Run "npm run refresh-networth" to populate the cache first.`
    );
  }

  const cache = JSON.parse(fs.readFileSync(MEMBER_NET_WORTH_FILE, "utf-8")) as MemberNetWorthCache;
  const ageDays = Math.round(
    (Date.now() - new Date(cache.fetchedAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  console.log(
    `📦 Loaded ${cache.members.length} member net worths from cache ` +
    `(${ageDays} day(s) old, ${cache.disclosureYear} disclosures)`
  );
  return cache.members;
}

// A stale age can be recomputed from the birthday already on disk; a stale net
// worth can't be recomputed from anything — it needs a new disclosure. So this
// only reports, and deliberately does NOT block the run: a quarter-old figure
// is still the most recent one that exists, and silently going dark would be
// worse than posting it. The warning is what prompts `npm run refresh-networth`.
function warnIfStale(members: MemberNetWorth[]): void {
  const stale = findStaleNetWorths(members, new Date());
  if (stale.length === 0) return;

  console.warn(
    `  ⚠️  ${stale.length} of ${members.length} net worth figure(s) are past their re-check date ` +
    `(earliest: ${stale.map((m) => m.validUntil).sort()[0]}).`
  );
  console.warn(`     Run "npm run refresh-networth" to pull the latest financial disclosures.`);
}

// ---------------------------------------------------------------------------
// Net worth analysis
// ---------------------------------------------------------------------------

function analyzeVote(vote: RawVote, netWorths: MemberNetWorthIndex): NetWorthVoteResult {
  const breakdown = calculateNetWorthBreakdown(vote.members, netWorths);

  if (breakdown.unmatched > 0) {
    console.warn(
      `  ⚠️  ${vote.id}: ${breakdown.matched} matched, ${breakdown.unmatched} with no disclosure on file ` +
      `(${(breakdown.coverage * 100).toFixed(1)}% coverage).`
    );
  }

  return { ...vote, ...breakdown };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function printVoteResult(v: NetWorthVoteResult): void {
  console.log("─".repeat(60));
  console.log(`${v.chamber.toUpperCase()} VOTE #${v.voteNumber}  |  ${v.date}`);
  console.log(`📋 ${v.question}`);
  if (v.description) console.log(`   ${v.description}`);
  console.log(`🗳️  Result: ${v.result}  (Yeas: ${v.yeas} | Nays: ${v.nays})`);
  console.log();
  console.log(`💰 Net worth (avg | median):`);
  console.log(`   ✅ YES: ${formatNetWorth(v.avgNetWorthYea, v.medianNetWorthYea, v.countYea)}`);
  console.log(`   ❌  NO: ${formatNetWorth(v.avgNetWorthNay, v.medianNetWorthNay, v.countNay)}`);
  console.log();

  if (!hasSufficientCoverage(v)) {
    console.log(
      `⏭️  Would not post: only ${(v.coverage * 100).toFixed(1)}% of voters have a disclosure ` +
      `on file (minimum ${(MIN_COVERAGE * 100).toFixed(0)}%).`
    );
    console.log();
    return;
  }

  const post = buildNetWorthPost(v);
  console.log(`📱 Sample Bluesky post (${graphemeLength(post.text)} graphemes):`);
  console.log(post.text);
  if (post.facets.length > 0) console.log(`   🔗 links to: ${post.facets[0].uri}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Posting (dedupe against already-seen votes)
// ---------------------------------------------------------------------------

async function postNewVotes(allVotes: NetWorthVoteResult[]): Promise<void> {
  let postedCount = 0;
  let skippedCount = 0;
  let lowCoverageCount = 0;

  for (const v of allVotes) {
    // An average taken over too few of the voters isn't the number this bot
    // claims to publish. Bail before claiming the vote, so a later run with a
    // refreshed cache can still post it.
    if (!hasSufficientCoverage(v)) {
      lowCoverageCount++;
      console.warn(
        `  ⏭️  Skipping ${v.chamber} vote #${v.voteNumber}: only ${(v.coverage * 100).toFixed(1)}% ` +
        `of voters have a net worth on file (minimum ${(MIN_COVERAGE * 100).toFixed(0)}%).`
      );
      continue;
    }

    // Claim first, post second — see the identical comment in fetchVotes.ts.
    if (!(await claimVote(BOT_ID, v.id))) {
      skippedCount++;
      continue;
    }
    try {
      const post = buildNetWorthPost(v);
      await postToBluesky(BOT_ID, post.text, post.facets);
      postedCount++;
      console.log(`  ✅ Posted ${v.chamber} vote #${v.voteNumber} to Bluesky.`);
    } catch (err) {
      console.error(`  ❌ Failed to post ${v.chamber} vote #${v.voteNumber}:`, err);
      await releaseVote(BOT_ID, v.id);
    }
  }

  console.log(
    `\n📬 Posting summary: ${postedCount} new, ${skippedCount} already posted before, ` +
    `${lowCoverageCount} skipped for low coverage.\n`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Net Worth Bot — Fetch Latest Votes");
  console.log("=".repeat(60));
  console.log();

  let memberNetWorths: MemberNetWorth[];
  try {
    memberNetWorths = loadMemberNetWorths();
    warnIfStale(memberNetWorths);
  } catch (err) {
    console.error("\n❌", (err as Error).message);
    process.exit(1);
  }

  const netWorths = buildMemberNetWorthIndex(memberNetWorths);
  console.log();

  const rawVotes = await fetchAllVotes();

  if (rawVotes.length === 0) {
    console.log("No votes retrieved. Check network connection and congress/session numbers.");
    return;
  }

  const allVotes = rawVotes.map((v) => analyzeVote(v, netWorths));

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
