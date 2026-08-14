import { describe, it, expect } from "vitest";
import {
  extractText,
  normalizeHouseVote,
  computeCongressSession,
  calculateSenatePopulation,
  calculateHousePopulation,
  formatPop,
  formatPct,
  buildPopulationPost,
  buildBillUrl,
  graphemeLength,
  fitsInPost,
  truncateToGraphemes,
  selectRecentSenateVotes,
  catchUpStart,
  orderForPosting,
  MAX_POST_LENGTH,
  StatePop,
  DistrictPop,
  MemberDistrict,
  VoteResult,
} from "./voteCalculations.js";

// Decodes a facet's byte range back into the substring of `text` it covers,
// so tests can assert on readable text instead of raw byte offsets.
function facetText(text: string, facet: { byteStart: number; byteEnd: number }): string {
  return Buffer.from(text, "utf-8").slice(facet.byteStart, facet.byteEnd).toString("utf-8");
}

describe("normalizeHouseVote", () => {
  it("normalizes bill-vote codes", () => {
    expect(normalizeHouseVote("Yea")).toBe("Yea");
    expect(normalizeHouseVote("Nay")).toBe("Nay");
  });

  it("normalizes resolution-vote codes to the same Yea/Nay", () => {
    // The bug that motivated this test suite: resolutions use Aye/No instead
    // of Yea/Nay, and silently produced 0% population when unhandled.
    expect(normalizeHouseVote("Aye")).toBe("Yea");
    expect(normalizeHouseVote("No")).toBe("Nay");
  });

  it("returns null for non-vote codes like Present or Not Voting", () => {
    expect(normalizeHouseVote("Present")).toBeNull();
    expect(normalizeHouseVote("Not Voting")).toBeNull();
    expect(normalizeHouseVote("")).toBeNull();
  });
});

describe("selectRecentSenateVotes", () => {
  it("takes the first N entries, since the Senate feed lists votes newest-first", () => {
    // Regression test: the Senate's vote_menu XML is ordered descending by
    // vote_number (e.g. #210 first, #1 last) — the opposite of what an earlier
    // version of this code assumed. Slicing from the end grabbed the OLDEST
    // votes instead of the newest, so the bot silently reposted/skipped votes
    // #1-5 forever.
    const descendingVotes = [210, 209, 208, 207, 206, 205, 3, 2, 1].map((n) => ({
      vote_number: n,
    }));
    expect(selectRecentSenateVotes(descendingVotes, 5)).toEqual(
      [210, 209, 208, 207, 206].map((n) => ({ vote_number: n }))
    );
  });

  it("returns fewer than count if the array is shorter", () => {
    const votes = [2, 1].map((n) => ({ vote_number: n }));
    expect(selectRecentSenateVotes(votes, 5)).toEqual(votes);
  });
});

describe("orderForPosting", () => {
  it("posts oldest-first, the reverse of the newest-first fetch order", () => {
    // Not cosmetic. catchUpStart() resumes from the highest vote number already
    // posted, so if a run dies mid-batch the mark must not have jumped ahead of
    // votes the run never reached — those would fall below the window forever.
    // Posting oldest-first keeps anything unposted above the mark.
    const fetched = [283, 282, 281].map((n) => ({ voteNumber: n }));
    expect(orderForPosting(fetched)).toEqual([281, 282, 283].map((n) => ({ voteNumber: n })));
  });

  it("does not mutate the caller's array, which is still displayed newest-first", () => {
    const fetched = [3, 2, 1];
    orderForPosting(fetched);
    expect(fetched).toEqual([3, 2, 1]);
  });
});

describe("catchUpStart", () => {
  const DISPLAY = 5;
  const CAP = 30;

  it("shows just the newest window when the bot has no history", () => {
    // A brand-new bot must not read an entire session as unposted backlog.
    expect(catchUpStart(283, 0, DISPLAY, CAP)).toBe(279);
  });

  it("stays on the display window when the bot is already caught up", () => {
    // Steady state, and the recess case: nothing new, so nothing extra fetched.
    expect(catchUpStart(283, 283, DISPLAY, CAP)).toBe(279);
  });

  it("stays on the display window when fewer than DISPLAY votes are new", () => {
    expect(catchUpStart(283, 281, DISPLAY, CAP)).toBe(279);
  });

  it("reaches back past the display window to the first unhandled vote", () => {
    // The bug this exists for: 12 roll calls landed between runs, so a fixed
    // 5-vote window would have dropped #272-#278 with no error.
    expect(catchUpStart(283, 271, DISPLAY, CAP)).toBe(272);
  });

  it("caps a long backlog to the newest MAX_CATCH_UP votes", () => {
    // Bot down for days: post the 30 most recent rather than a week of stale ones.
    expect(catchUpStart(283, 100, DISPLAY, CAP)).toBe(254);
  });

  it("never reaches below vote #1", () => {
    expect(catchUpStart(3, 0, DISPLAY, CAP)).toBe(1);
    expect(catchUpStart(3, 1, DISPLAY, CAP)).toBe(1);
    expect(catchUpStart(40, 1, DISPLAY, CAP)).toBe(11);
  });

  it("treats a high-water mark ahead of the feed as caught up", () => {
    // Defensive: a stale/lagging feed must not make the window run backwards.
    expect(catchUpStart(283, 290, DISPLAY, CAP)).toBe(279);
  });
});

describe("extractText", () => {
  it("trims plain strings", () => {
    expect(extractText("  hello  ")).toBe("hello");
  });

  it("extracts xml2js underscore-text values", () => {
    expect(extractText({ _: " hello " })).toBe("hello");
  });

  it("extracts xml2js #text values", () => {
    expect(extractText({ "#text": " hello " })).toBe("hello");
  });

  it("returns empty string for null/undefined/falsy input", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
    expect(extractText("")).toBe("");
  });
});

describe("computeCongressSession", () => {
  it("maps the first year of a Congress to session 1", () => {
    expect(computeCongressSession(new Date(2025, 5, 1))).toEqual({ congress: 119, session: 1 });
  });

  it("maps the second year of a Congress to session 2", () => {
    expect(computeCongressSession(new Date(2026, 5, 1))).toEqual({ congress: 119, session: 2 });
  });

  it("rolls over to the next Congress on the next odd year", () => {
    expect(computeCongressSession(new Date(2027, 5, 1))).toEqual({ congress: 120, session: 1 });
  });
});

describe("calculateSenatePopulation", () => {
  const statePops = new Map<string, StatePop>([
    ["VT", { name: "Vermont", abbr: "VT", population: 645_000, fips: "50" }],
    ["CA", { name: "California", abbr: "CA", population: 39_000_000, fips: "06" }],
    ["TX", { name: "Texas", abbr: "TX", population: 30_000_000, fips: "48" }],
  ]);

  it("sums state population on the correct side per senator", () => {
    const { popYea, popNay } = calculateSenatePopulation(
      [
        { state: "VT", voteCast: "Yea" },
        { state: "CA", voteCast: "Nay" },
        { state: "TX", voteCast: "Yea" },
      ],
      statePops
    );
    expect(popYea).toBe(645_000 + 30_000_000);
    expect(popNay).toBe(39_000_000);
  });

  it("skips members whose state has no cached population", () => {
    const { popYea, popNay } = calculateSenatePopulation(
      [{ state: "PR", voteCast: "Yea" }],
      statePops
    );
    expect(popYea).toBe(0);
    expect(popNay).toBe(0);
  });

  it("ignores non-Yea/Nay vote casts (e.g. Present)", () => {
    const { popYea, popNay } = calculateSenatePopulation(
      [{ state: "VT", voteCast: "Present" }],
      statePops
    );
    expect(popYea).toBe(0);
    expect(popNay).toBe(0);
  });
});

describe("calculateHousePopulation", () => {
  const memberDistricts = new Map<string, MemberDistrict>([
    ["A000001", { districtKey: "NC-12", name: "Rep A", state: "NC", district: 12, party: "D" }],
    ["A000002", { districtKey: "TX-05", name: "Rep B", state: "TX", district: 5, party: "R" }],
    // A000003 intentionally absent — simulates a member missing from the map.
  ]);

  const districtPops = new Map<string, DistrictPop>([
    ["NC-12", { stateAbbr: "NC", district: "12", population: 748_052 }],
    // TX-05 intentionally absent — simulates a district missing from Census data.
  ]);

  it("handles a mix of bill (Yea/Nay) and resolution (Aye/No) codes", () => {
    const { popYea, popNay, matched, unmatched } = calculateHousePopulation(
      [
        { bioguide: "A000001", voteCast: "Yea" },
        { bioguide: "A000002", voteCast: "No" }, // resolution-style code
      ],
      memberDistricts,
      districtPops
    );
    // A000002 matches a member but has no cached district population, so it
    // counts as unmatched rather than silently contributing 0 population.
    expect(popYea).toBe(748_052);
    expect(popNay).toBe(0);
    expect(matched).toBe(1);
    expect(unmatched).toBe(1);
  });

  it("counts a member missing from the district map as unmatched", () => {
    const { matched, unmatched } = calculateHousePopulation(
      [{ bioguide: "A000003", voteCast: "Aye" }],
      memberDistricts,
      districtPops
    );
    expect(matched).toBe(0);
    expect(unmatched).toBe(1);
  });

  it("skips entries with no bioguide id or an unrecognized vote cast, without counting them as unmatched", () => {
    const { matched, unmatched, popYea, popNay } = calculateHousePopulation(
      [
        { bioguide: "", voteCast: "Yea" },
        { bioguide: "A000001", voteCast: "Present" },
      ],
      memberDistricts,
      districtPops
    );
    expect(matched).toBe(0);
    expect(unmatched).toBe(0);
    expect(popYea).toBe(0);
    expect(popNay).toBe(0);
  });
});

describe("formatPop", () => {
  it("leaves sub-1000 numbers as-is", () => {
    expect(formatPop(500)).toBe("500");
  });

  it("formats thousands with a K suffix", () => {
    expect(formatPop(3_400)).toBe("3K");
    expect(formatPop(15_000)).toBe("15K");
  });

  it("formats millions with one decimal and an M suffix", () => {
    expect(formatPop(1_000_000)).toBe("1.0M");
    expect(formatPop(2_500_000)).toBe("2.5M");
  });
});

describe("formatPct", () => {
  it("formats a fraction as a percentage with one decimal", () => {
    expect(formatPct(0.5)).toBe("50.0%");
    expect(formatPct(0.1234)).toBe("12.3%");
    expect(formatPct(0)).toBe("0.0%");
    expect(formatPct(1)).toBe("100.0%");
  });
});

describe("buildBillUrl", () => {
  it("maps a House bill", () => {
    expect(buildBillUrl(119, "H.R. 5103")).toBe("https://www.congress.gov/bill/119th-congress/house-bill/5103");
  });

  it("maps space-separated designations, as found in House legis-num fields", () => {
    expect(buildBillUrl(119, "H R 5103")).toBe("https://www.congress.gov/bill/119th-congress/house-bill/5103");
    expect(buildBillUrl(119, "H J RES 139")).toBe(
      "https://www.congress.gov/bill/119th-congress/house-joint-resolution/139"
    );
    expect(buildBillUrl(119, "H RES 1131")).toBe(
      "https://www.congress.gov/bill/119th-congress/house-resolution/1131"
    );
  });

  it("maps Senate designations", () => {
    expect(buildBillUrl(119, "S. 3627")).toBe("https://www.congress.gov/bill/119th-congress/senate-bill/3627");
    expect(buildBillUrl(119, "S.J.Res. 98")).toBe(
      "https://www.congress.gov/bill/119th-congress/senate-joint-resolution/98"
    );
    expect(buildBillUrl(119, "S.Con.Res. 33")).toBe(
      "https://www.congress.gov/bill/119th-congress/senate-concurrent-resolution/33"
    );
  });

  it("uses the correct ordinal suffix, including the 11/12/13 exception", () => {
    expect(buildBillUrl(101, "H.R. 1")).toContain("/101st-congress/");
    expect(buildBillUrl(102, "H.R. 1")).toContain("/102nd-congress/");
    expect(buildBillUrl(103, "H.R. 1")).toContain("/103rd-congress/");
    expect(buildBillUrl(111, "H.R. 1")).toContain("/111th-congress/");
    expect(buildBillUrl(112, "H.R. 1")).toContain("/112th-congress/");
    expect(buildBillUrl(113, "H.R. 1")).toContain("/113th-congress/");
  });

  it("returns an empty string for designations with no bill page, like nominations or amendments", () => {
    expect(buildBillUrl(119, "PN615-2")).toBe("");
    expect(buildBillUrl(119, "S.Amdt. 5235")).toBe("");
    expect(buildBillUrl(119, "")).toBe("");
  });
});

describe("buildPopulationPost", () => {
  const baseVote: VoteResult = {
    id: "house-2026-100",
    chamber: "House",
    voteNumber: "100",
    date: "2026-03-01",
    question: "On Passage",
    description: "To reauthorize the thing",
    result: "Passed",
    yeas: 220,
    nays: 210,
    populationYea: 150_000_000,
    populationNay: 140_000_000,
    totalUsPopulation: 331_000_000,
    pctYea: 0.4531,
    pctNay: 0.4229,
    url: "https://example.com",
    billUrl: "https://www.congress.gov/bill/119th-congress/house-bill/100",
  };

  it("builds the full post with description", () => {
    const post = buildPopulationPost(baseVote);
    expect(post.text).toBe(
      "House Vote: On Passage\n" +
        "To reauthorize the thing\n" +
        "Result: Passed (220-210)\n\n" +
        "🇺🇸 Population represented:\n" +
        "✅ YES: 150.0M (45.3%)\n" +
        "❌  NO: 140.0M (42.3%)"
    );
  });

  it("links the description text to the bill instead of appending the URL", () => {
    const post = buildPopulationPost(baseVote);
    expect(post.text).not.toContain(baseVote.billUrl); // link is a facet, not visible text
    expect(post.facets).toHaveLength(1);
    expect(post.facets[0].uri).toBe(baseVote.billUrl);
    expect(facetText(post.text, post.facets[0])).toBe("To reauthorize the thing");
  });

  it("omits facets when there's no bill URL to link to", () => {
    const post = buildPopulationPost({ ...baseVote, billUrl: "" });
    expect(post.facets).toEqual([]);
  });

  it("omits the description line when there is no description", () => {
    const post = buildPopulationPost({ ...baseVote, description: "" });
    expect(post.text).not.toContain("To reauthorize the thing");
    expect(post.text.startsWith("House Vote: On Passage\nResult: Passed (220-210)")).toBe(true);
    expect(post.facets).toEqual([]);
  });

  it("shortens an over-length description instead of cutting off the Result/Population lines", () => {
    // Regression test: a real post got cut off mid-way through the "NO" line
    // because the old truncation sliced the whole post at 300 raw chars.
    const longDescription =
      "Providing for consideration of the bills (H.R. 8800, H.R. 8884, H.R. 7008, " +
      "H.R. 6955, and H.R. 9770); and providing for consideration of the concurrent " +
      "resolution (H. Con. Res. 113)";
    const vote: VoteResult = {
      ...baseVote,
      chamber: "House",
      question: "On Agreeing to the Resolution",
      description: longDescription,
      result: "Passed",
      yeas: 214,
      nays: 211,
      url: "https://clerk.house.gov/Votes/2026100",
      billUrl: "https://www.congress.gov/bill/119th-congress/house-resolution/113",
    };

    const post = buildPopulationPost(vote);

    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_POST_LENGTH);
    expect(fitsInPost(post.text)).toBe(true);
    // The Result and Population lines must survive intact, not get sliced.
    expect(post.text).toContain("Result: Passed (214-211)");
    expect(post.text).toContain("🇺🇸 Population represented:");
    expect(post.text).toContain("✅ YES: 150.0M (45.3%)");
    expect(post.text).toContain("❌  NO: 140.0M (42.3%)");
    // The description was shortened...
    expect(post.text).toContain("…");
    expect(post.text).not.toContain(vote.billUrl);
    // ...and the shortened snippet itself (ellipsis included) links to the bill.
    expect(post.facets).toHaveLength(1);
    expect(post.facets[0].uri).toBe(vote.billUrl);
    const linkedText = facetText(post.text, post.facets[0]);
    expect(linkedText.endsWith("…")).toBe(true);
    expect(longDescription.startsWith(linkedText.slice(0, -1))).toBe(true);
  });

  it("never posts over the limit even in a pathological case (an extremely long question)", () => {
    // Real congressional "question" text is always short ("On Passage", "On
    // Agreeing to the Resolution"...) — only `description` is ever long
    // enough to need shortening. This just confirms the last-resort safety
    // net holds even if that assumption is ever wrong.
    const vote: VoteResult = { ...baseVote, question: "x".repeat(500), description: "y".repeat(500) };

    const post = buildPopulationPost(vote);
    expect(fitsInPost(post.text)).toBe(true);
    expect(post.facets).toEqual([]);
  });
});

describe("graphemeLength / fitsInPost / truncateToGraphemes", () => {
  it("counts multi-codepoint emoji as a single grapheme, unlike .length", () => {
    const flag = "🇺🇸";
    expect(flag.length).toBeGreaterThan(1); // JS UTF-16 length overcounts it
    expect(graphemeLength(flag)).toBe(1);
  });

  it("fitsInPost matches the 300-grapheme limit", () => {
    expect(fitsInPost("a".repeat(MAX_POST_LENGTH))).toBe(true);
    expect(fitsInPost("a".repeat(MAX_POST_LENGTH + 1))).toBe(false);
  });

  it("truncateToGraphemes cuts by grapheme, not UTF-16 unit", () => {
    expect(truncateToGraphemes("hello world", 5)).toBe("hello");
    expect(truncateToGraphemes("🇺🇸🇺🇸🇺🇸", 2)).toBe("🇺🇸🇺🇸");
    expect(truncateToGraphemes("short", 100)).toBe("short");
    expect(truncateToGraphemes("anything", 0)).toBe("");
  });
});
