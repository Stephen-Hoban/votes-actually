/**
 * voteSources.ts
 *
 * Shared vote-fetching layer: pulls raw roll call votes from senate.gov and
 * clerk.house.gov and returns them as chamber-agnostic `RawVote` records.
 *
 * This is deliberately free of any per-bot analysis. Each bot (population, age,
 * …) takes the same `RawVote` list and computes its own numbers from
 * `vote.members`, so a fix to XML parsing or vote detection benefits every bot
 * instead of being duplicated per persona.
 *
 * Data sources (no API key needed for either):
 *   - Senate votes:  senate.gov XML feeds
 *   - House votes:   clerk.house.gov XML feeds
 */

import { parseStringPromise } from "xml2js";
import {
  extractText,
  computeCongressSession,
  buildBillUrl,
  selectRecentSenateVotes,
  catchUpStart,
} from "./voteCalculations.js";

const USER_AGENT = "votes-actually (educational project)";

/** How many recent votes per chamber to pull on each run, regardless of history. */
export const VOTES_TO_SHOW = 5;

/**
 * Ceiling on votes fetched per chamber in one run when catching up.
 *
 * Sized to cover the worst run gap actually observed (~2.5 hours) at the
 * fastest rate a chamber votes (~7 roll calls in 38 minutes), with headroom.
 * The cost of a large window is only XML fetches; the cost of too small a
 * window is a vote that never gets posted.
 *
 * It exists so a bot that has been down for days doesn't wake up and dump a
 * week of stale votes onto Bluesky. When the cap bites, the newest votes win
 * and the shortfall is logged loudly — the older ones fall below the bot's
 * high-water mark once these post, so they are gone for good.
 */
export const MAX_CATCH_UP = 30;

/**
 * Resolves the newest vote number a caller has already handled for a chamber,
 * given a vote-ID prefix ("house-2026-", "senate-119-2-"); 0 means no history.
 *
 * Passed in rather than imported so this module stays free of any per-bot
 * concern — each bot supplies its own, backed by seenVotes.highestSeenNumber.
 * Omit it (baselining, or a dev run with no Supabase credentials) to get the
 * plain newest-VOTES_TO_SHOW window.
 */
export type HighWaterFn = (idPrefix: string) => Promise<number>;

// Shared by both chambers: work out the oldest vote number to fetch, and say so
// when the cap is what decided it.
async function resolveStart(
  latest: number,
  idPrefix: string,
  chamber: string,
  highWater?: HighWaterFn
): Promise<number> {
  const mark = highWater ? await highWater(idPrefix) : 0;
  const start = catchUpStart(latest, mark, VOTES_TO_SHOW, MAX_CATCH_UP);

  if (mark > 0 && start > mark + 1) {
    console.warn(
      `  ⚠️  ${chamber}: ${start - mark - 1} vote(s) between #${mark + 1} and #${start - 1} ` +
        `are older than the ${MAX_CATCH_UP}-vote catch-up cap and will NOT be posted.`
    );
  } else if (start < latest - VOTES_TO_SHOW + 1) {
    console.log(`    Catching up from #${start} (last handled #${mark}).`);
  }

  return start;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One member's vote, with every identifier the chambers expose — different
 * bots key off different ones (population uses state/bioguide, age uses
 * bioguide/lisId). Fields the source chamber doesn't provide are "".
 */
export interface RawMemberVote {
  /** BioGuide ID — House only (`name-id` attr); "" for Senate. */
  bioguide: string;
  /** LIS member ID — Senate only (`lis_member_id`); "" for House. */
  lisId: string;
  /** Two-letter state abbreviation. */
  state: string;
  /** Raw, un-normalized vote code: "Yea"/"Nay"/"Aye"/"No"/"Present"/"Not Voting". */
  voteCast: string;
}

/** A roll call vote as published, before any bot-specific analysis. */
export interface RawVote {
  id: string;
  chamber: "Senate" | "House";
  voteNumber: string;
  date: string;
  question: string;
  description: string;
  result: string;
  yeas: number;
  nays: number;
  url: string;
  /** congress.gov URL for the underlying bill/resolution, or "" (e.g. nominations). */
  billUrl: string;
  members: RawMemberVote[];
}

// ---------------------------------------------------------------------------
// Auto-detection: Congress number, Senate session, House year
// ---------------------------------------------------------------------------

async function urlExists(url: string): Promise<boolean> {
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  return resp.ok;
}

// The Senate doesn't publish a session's vote_menu XML until that session's first
// vote happens (e.g. early January before floor activity starts). Fall back to the
// previous session if the calendar-derived one has no data yet.
export async function detectCongressSession(): Promise<{ congress: number; session: number }> {
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
export async function detectHouseYear(): Promise<number> {
  const currentYear = new Date().getFullYear();
  const url = `https://clerk.house.gov/evs/${currentYear}/roll001.xml`;

  if (await urlExists(url)) return currentYear;

  console.warn(`  ⚠️  No House vote data yet for ${currentYear}. Falling back to ${currentYear - 1}.`);
  return currentYear - 1;
}

// ---------------------------------------------------------------------------
// Senate votes
// ---------------------------------------------------------------------------

export async function fetchSenateVotes(
  congressNum: number,
  senateSession: number,
  highWater?: HighWaterFn
): Promise<RawVote[]> {
  console.log(`\n🏛️  Fetching Senate votes (${congressNum}th Congress, Session ${senateSession})...`);

  const listUrl =
    `https://www.senate.gov/legislative/LIS/roll_call_lists/` +
    `vote_menu_${congressNum}_${senateSession}.xml`;

  const listResp = await fetch(listUrl, { headers: { "User-Agent": USER_AGENT } });
  if (!listResp.ok) throw new Error(`Senate list error: ${listResp.status}`);

  const listXml = await listResp.text();
  const listData = await parseStringPromise(listXml, { explicitArray: false });

  const allVotes = listData.vote_summary.votes.vote;
  const voteArray: unknown[] = Array.isArray(allVotes) ? allVotes : [allVotes];

  // The feed is newest-first, so the first entry is the latest vote number and
  // the count to take from the front is the distance back to `start`.
  const latestNum = parseInt(String((voteArray[0] as Record<string, unknown>)?.vote_number), 10) || 0;
  const idPrefix = `senate-${congressNum}-${senateSession}-`;
  const start = await resolveStart(latestNum, idPrefix, "Senate", highWater);
  const recentVotes = selectRecentSenateVotes(voteArray, Math.max(1, latestNum - start + 1));

  const results: RawVote[] = [];

  for (const vote of recentVotes) {
    const v = vote as Record<string, unknown>;
    const voteNum = String(v.vote_number).padStart(5, "0");

    const detailUrl =
      `https://www.senate.gov/legislative/LIS/roll_call_votes/` +
      `vote${congressNum}${senateSession}/` +
      `vote_${congressNum}_${senateSession}_${voteNum}.xml`;

    const detailResp = await fetch(detailUrl, { headers: { "User-Agent": USER_AGENT } });
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

    const memberVotes: RawMemberVote[] = members.map((m) => {
      const member = m as Record<string, unknown>;
      return {
        bioguide: "",
        lisId: extractText(member.lis_member_id),
        state: extractText(member.state),
        voteCast: extractText(member.vote_cast),
      };
    });

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
      url:
        `https://www.senate.gov/legislative/LIS/roll_call_lists/` +
        `roll_call_vote_cfm.cfm?congress=${congressNum}&session=${senateSession}` +
        `&vote=${v.vote_number}`,
      billUrl,
      members: memberVotes,
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

export async function fetchHouseVotes(houseYear: number, highWater?: HighWaterFn): Promise<RawVote[]> {
  console.log(`\n🏠  Fetching House votes (${houseYear})...`);
  console.log(`    Finding latest roll call number...`);

  const latestRoll = await findLatestHouseRollNumber(houseYear);
  console.log(`    Latest House roll call: #${latestRoll}`);

  const start = await resolveStart(latestRoll, `house-${houseYear}-`, "House", highWater);

  const results: RawVote[] = [];

  // Newest-first, to match the Senate feed's order.
  for (let rollNum = latestRoll; rollNum >= start; rollNum--) {
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

    const memberVotes: RawMemberVote[] = members.map((m) => {
      const member = m as Record<string, unknown>;
      const leg = member.legislator as Record<string, unknown>;
      const attrs = leg?.$ as Record<string, string> | undefined;
      return {
        bioguide: attrs?.["name-id"] ?? "",
        lisId: "",
        state: attrs?.["state"] ?? "",
        voteCast: extractText(member.vote),
      };
    });

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
      url: `https://clerk.house.gov/Votes/${houseYear}${paddedNum}`,
      billUrl,
      members: memberVotes,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Convenience: fetch both chambers, tolerating a failure in either
// ---------------------------------------------------------------------------

export async function fetchAllVotes(highWater?: HighWaterFn): Promise<RawVote[]> {
  const { congress, session } = await detectCongressSession();
  const houseYear = await detectHouseYear();

  let senateVotes: RawVote[] = [];
  try {
    senateVotes = await fetchSenateVotes(congress, session, highWater);
    console.log(`✅ Retrieved ${senateVotes.length} Senate votes.\n`);
  } catch (err) {
    console.error("❌ Senate fetch failed:", err);
  }

  let houseVotes: RawVote[] = [];
  try {
    houseVotes = await fetchHouseVotes(houseYear, highWater);
    console.log(`✅ Retrieved ${houseVotes.length} House votes.\n`);
  } catch (err) {
    console.error("❌ House fetch failed:", err);
  }

  return [...senateVotes, ...houseVotes];
}
