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
import { extractText, computeCongressSession, buildBillUrl, selectRecentSenateVotes } from "./voteCalculations.js";

const USER_AGENT = "votes-actually (educational project)";

/** How many recent votes per chamber to pull on each run. */
export const VOTES_TO_SHOW = 5;

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

export async function fetchSenateVotes(congressNum: number, senateSession: number): Promise<RawVote[]> {
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
  const recentVotes = selectRecentSenateVotes(voteArray, VOTES_TO_SHOW);

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

export async function fetchHouseVotes(houseYear: number): Promise<RawVote[]> {
  console.log(`\n🏠  Fetching House votes (${houseYear})...`);
  console.log(`    Finding latest roll call number...`);

  const latestRoll = await findLatestHouseRollNumber(houseYear);
  console.log(`    Latest House roll call: #${latestRoll}`);

  const results: RawVote[] = [];

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

export async function fetchAllVotes(): Promise<RawVote[]> {
  const { congress, session } = await detectCongressSession();
  const houseYear = await detectHouseYear();

  let senateVotes: RawVote[] = [];
  try {
    senateVotes = await fetchSenateVotes(congress, session);
    console.log(`✅ Retrieved ${senateVotes.length} Senate votes.\n`);
  } catch (err) {
    console.error("❌ Senate fetch failed:", err);
  }

  let houseVotes: RawVote[] = [];
  try {
    houseVotes = await fetchHouseVotes(houseYear);
    console.log(`✅ Retrieved ${houseVotes.length} House votes.\n`);
  } catch (err) {
    console.error("❌ House fetch failed:", err);
  }

  return [...senateVotes, ...houseVotes];
}
