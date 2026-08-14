import { describe, it, expect } from "vitest";
import {
  addDays,
  estimateNetWorth,
  buildMemberNetWorth,
  isNetWorthStale,
  findStaleNetWorths,
  buildMemberNetWorthIndex,
  lookupMemberNetWorth,
  calculateNetWorthBreakdown,
  mean,
  median,
  hasSufficientCoverage,
  formatMoney,
  formatNetWorth,
  buildNetWorthPost,
  NET_WORTH_REFRESH_DAYS,
  MIN_COVERAGE,
  MemberNetWorth,
  NetWorthMemberVote,
  NetWorthVoteResult,
} from "./netWorthCalculations.js";
import { graphemeLength, MAX_POST_LENGTH } from "./voteCalculations.js";

// Decodes a facet's byte range back into the substring of `text` it covers,
// so tests can assert on readable text instead of raw byte offsets.
function facetText(text: string, facet: { byteStart: number; byteEnd: number }): string {
  return Buffer.from(text, "utf-8").slice(facet.byteStart, facet.byteEnd).toString("utf-8");
}

// Fills in the fields tests don't care about so each fixture only needs to
// state what's relevant to the case at hand.
function makeMember(overrides: Partial<MemberNetWorth>): MemberNetWorth {
  return {
    bioguide: "",
    lisId: "",
    name: "Test Member",
    state: "NC",
    party: "Democrat",
    chamber: "House",
    netWorth: 0,
    netWorthLow: 0,
    netWorthHigh: 0,
    disclosureYear: 2025,
    validUntil: "2099-01-01",
    ...overrides,
  };
}

describe("addDays", () => {
  it("advances a date by the given number of days", () => {
    expect(addDays(new Date("2026-08-05T00:00:00Z"), 90)).toBe("2026-11-03");
  });

  it("rolls over a year boundary", () => {
    expect(addDays(new Date("2026-12-20T00:00:00Z"), 30)).toBe("2027-01-19");
  });

  it("handles February in a leap year", () => {
    expect(addDays(new Date("2024-02-27T00:00:00Z"), 3)).toBe("2024-03-01");
  });

  it("is timezone-independent because the result is formatted in UTC", () => {
    // A late-evening UTC timestamp is the case a local-timezone formatter would
    // shift to the previous or next day depending on where the machine is.
    expect(addDays(new Date("2026-08-05T23:30:00Z"), 1)).toBe("2026-08-06");
  });
});

describe("estimateNetWorth", () => {
  it("takes the midpoint of a disclosed range", () => {
    expect(estimateNetWorth(1_000_000, 5_000_000)).toBe(3_000_000);
  });

  it("returns the value itself when the range is a single point", () => {
    expect(estimateNetWorth(250_000, 250_000)).toBe(250_000);
  });

  it("returns a negative midpoint when liabilities outweigh assets", () => {
    // Real and common: a member whose mortgages exceed their disclosed assets.
    expect(estimateNetWorth(-2_000_000, -500_000)).toBe(-1_250_000);
  });

  it("can straddle zero", () => {
    expect(estimateNetWorth(-1_000_000, 1_000_000)).toBe(0);
  });
});

describe("buildMemberNetWorth", () => {
  it("derives netWorth from the range and validUntil from the refresh cadence", () => {
    const member = buildMemberNetWorth(
      {
        bioguide: "H0001",
        lisId: "",
        name: "Test Member",
        state: "NC",
        party: "Democrat",
        chamber: "House",
        netWorthLow: 1_000_000,
        netWorthHigh: 3_000_000,
        disclosureYear: 2025,
      },
      new Date("2026-08-05T00:00:00Z")
    );

    expect(member.netWorth).toBe(2_000_000);
    expect(member.validUntil).toBe(addDays(new Date("2026-08-05T00:00:00Z"), NET_WORTH_REFRESH_DAYS));
  });

  it("preserves every field it doesn't derive", () => {
    const member = buildMemberNetWorth(
      {
        bioguide: "S0001",
        lisId: "S123",
        name: "Real Name",
        state: "WA",
        party: "Republican",
        chamber: "Senate",
        netWorthLow: 0,
        netWorthHigh: 0,
        disclosureYear: 2024,
      },
      new Date("2026-08-05T00:00:00Z")
    );

    expect(member.bioguide).toBe("S0001");
    expect(member.lisId).toBe("S123");
    expect(member.name).toBe("Real Name");
    expect(member.state).toBe("WA");
    expect(member.party).toBe("Republican");
    expect(member.chamber).toBe("Senate");
    expect(member.disclosureYear).toBe(2024);
  });

  it("honours an explicit refresh cadence over the default", () => {
    const member = buildMemberNetWorth(
      {
        bioguide: "H0002",
        lisId: "",
        name: "Test Member",
        state: "NC",
        party: "Democrat",
        chamber: "House",
        netWorthLow: 0,
        netWorthHigh: 0,
        disclosureYear: 2025,
      },
      new Date("2026-08-05T00:00:00Z"),
      30
    );

    expect(member.validUntil).toBe("2026-09-04");
  });
});

describe("isNetWorthStale", () => {
  const member = makeMember({ validUntil: "2026-11-03" });

  it("is fresh the day before the re-check date", () => {
    expect(isNetWorthStale(member, new Date("2026-11-02T00:00:00Z"))).toBe(false);
  });

  it("is stale on the re-check date itself", () => {
    expect(isNetWorthStale(member, new Date("2026-11-03T00:00:00Z"))).toBe(true);
  });

  it("is stale after the re-check date", () => {
    expect(isNetWorthStale(member, new Date("2027-01-01T00:00:00Z"))).toBe(true);
  });
});

describe("findStaleNetWorths", () => {
  it("returns only the entries whose re-check date has arrived", () => {
    const members = [
      makeMember({ bioguide: "A", validUntil: "2026-01-01" }),
      makeMember({ bioguide: "B", validUntil: "2027-01-01" }),
      makeMember({ bioguide: "C", validUntil: "2026-08-05" }),
    ];

    const stale = findStaleNetWorths(members, new Date("2026-08-05T00:00:00Z"));
    expect(stale.map((m) => m.bioguide)).toEqual(["A", "C"]);
  });

  it("returns an empty array when every entry is current", () => {
    const members = [makeMember({ validUntil: "2099-01-01" })];
    expect(findStaleNetWorths(members, new Date("2026-08-05T00:00:00Z"))).toEqual([]);
  });

  it("does not mutate the entries it inspects — net worth cannot self-heal", () => {
    // The whole difference from the age cache: a stale age is recomputed in
    // place from the birthday on disk, but a stale net worth needs a new
    // disclosure, so this must only report.
    const member = makeMember({ bioguide: "A", netWorth: 5_000_000, validUntil: "2026-01-01" });
    findStaleNetWorths([member], new Date("2026-08-05T00:00:00Z"));
    expect(member.netWorth).toBe(5_000_000);
    expect(member.validUntil).toBe("2026-01-01");
  });
});

describe("buildMemberNetWorthIndex / lookupMemberNetWorth", () => {
  const house = makeMember({ bioguide: "H1", name: "House Member", netWorth: 1_000_000 });
  const senate = makeMember({
    bioguide: "S1",
    lisId: "S001",
    name: "Senate Member",
    chamber: "Senate",
    netWorth: 9_000_000,
  });
  const index = buildMemberNetWorthIndex([house, senate]);

  it("indexes senators under both their BioGuide and LIS IDs", () => {
    expect(index.byBioguide.get("S1")).toBe(senate);
    expect(index.byLis.get("S001")).toBe(senate);
  });

  it("does not index an empty LIS ID", () => {
    expect(index.byLis.has("")).toBe(false);
  });

  it("finds a House member by BioGuide ID, which is all the House XML carries", () => {
    expect(lookupMemberNetWorth(index, { bioguide: "H1", lisId: "", voteCast: "Yea" })).toBe(house);
  });

  it("finds a senator by LIS ID, which is all the Senate XML carries", () => {
    expect(lookupMemberNetWorth(index, { bioguide: "", lisId: "S001", voteCast: "Yea" })).toBe(senate);
  });

  it("falls back to the LIS ID when the BioGuide ID is present but unknown", () => {
    expect(lookupMemberNetWorth(index, { bioguide: "NOPE", lisId: "S001", voteCast: "Yea" })).toBe(senate);
  });

  it("returns undefined when neither identifier matches", () => {
    expect(lookupMemberNetWorth(index, { bioguide: "ZZZ", lisId: "S999", voteCast: "Yea" })).toBeUndefined();
  });

  it("returns undefined when the vote carries no identifiers at all", () => {
    expect(lookupMemberNetWorth(index, { bioguide: "", lisId: "", voteCast: "Yea" })).toBeUndefined();
  });
});

describe("calculateNetWorthBreakdown", () => {
  const index = buildMemberNetWorthIndex([
    makeMember({ bioguide: "H1", netWorth: 1_000_000 }),
    makeMember({ bioguide: "H2", netWorth: 3_000_000 }),
    makeMember({ bioguide: "H3", netWorth: 5_000_000 }),
    makeMember({ bioguide: "S1", lisId: "S001", netWorth: 11_000_000, chamber: "Senate" }),
    makeMember({ bioguide: "S2", lisId: "S002", netWorth: -1_000_000, chamber: "Senate" }),
  ]);

  function vote(bioguide: string, lisId: string, voteCast: string): NetWorthMemberVote {
    return { bioguide, lisId, voteCast };
  }

  it("averages each side separately", () => {
    const result = calculateNetWorthBreakdown(
      [vote("H1", "", "Yea"), vote("H2", "", "Yea"), vote("H3", "", "Nay")],
      index
    );
    expect(result.avgNetWorthYea).toBe(2_000_000); // (1M + 3M) / 2
    expect(result.avgNetWorthNay).toBe(5_000_000);
    expect(result.countYea).toBe(2);
    expect(result.countNay).toBe(1);
  });

  it("reports the median of each side alongside the average", () => {
    const result = calculateNetWorthBreakdown(
      [vote("H1", "", "Yea"), vote("H2", "", "Yea"), vote("H3", "", "Yea"), vote("", "S001", "Nay")],
      index
    );
    // Yea side is 1M, 3M, 5M: mean 3M, median 3M.
    expect(result.avgNetWorthYea).toBe(3_000_000);
    expect(result.medianNetWorthYea).toBe(3_000_000);
    // Single nay voter: mean and median are both that member.
    expect(result.medianNetWorthNay).toBe(11_000_000);
  });

  it("separates median from average when one member dominates a side", () => {
    // S001 is worth 11M against three members near 1-5M: the mean is dragged
    // well above the median, which is exactly the skew the post exposes.
    const result = calculateNetWorthBreakdown(
      [vote("H1", "", "Yea"), vote("H2", "", "Yea"), vote("H3", "", "Yea"), vote("", "S001", "Yea")],
      index
    );
    expect(result.avgNetWorthYea).toBe(5_000_000); // (1 + 3 + 5 + 11) / 4
    expect(result.medianNetWorthYea).toBe(4_000_000); // (3 + 5) / 2
  });

  it("yields median 0 (not NaN) for a side with zero voters", () => {
    const result = calculateNetWorthBreakdown([vote("H1", "", "Yea")], index);
    expect(result.medianNetWorthNay).toBe(0);
    expect(Number.isNaN(result.medianNetWorthNay)).toBe(false);
  });

  it("treats House resolution codes Aye/No the same as Yea/Nay", () => {
    // The bug that once silently zeroed the population bot on resolution votes.
    const result = calculateNetWorthBreakdown(
      [vote("H1", "", "Aye"), vote("H2", "", "Aye"), vote("H3", "", "No")],
      index
    );
    expect(result.avgNetWorthYea).toBe(2_000_000);
    expect(result.avgNetWorthNay).toBe(5_000_000);
  });

  it("excludes Present and Not Voting members from both averages", () => {
    const result = calculateNetWorthBreakdown(
      [vote("H1", "", "Yea"), vote("H2", "", "Present"), vote("H3", "", "Not Voting")],
      index
    );
    expect(result.avgNetWorthYea).toBe(1_000_000);
    expect(result.countYea).toBe(1);
    expect(result.countNay).toBe(0);
    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(0);
  });

  it("counts a member with no net worth on file as unmatched rather than as $0", () => {
    // Counting a missing filing as zero would drag the average down silently —
    // the exact class of error the coverage guard exists to catch.
    const result = calculateNetWorthBreakdown([vote("H1", "", "Yea"), vote("ZZZ999", "", "Yea")], index);
    expect(result.avgNetWorthYea).toBe(1_000_000); // only H1 counted
    expect(result.countYea).toBe(1);
    expect(result.unmatched).toBe(1);
  });

  it("averages a negative net worth without special-casing it", () => {
    const result = calculateNetWorthBreakdown([vote("", "S001", "Yea"), vote("", "S002", "Yea")], index);
    expect(result.avgNetWorthYea).toBe(5_000_000); // (11M + -1M) / 2
  });

  it("yields avgNetWorth 0 and count 0 (not NaN) for a side with zero voters", () => {
    const result = calculateNetWorthBreakdown([vote("H1", "", "Yea"), vote("H2", "", "Yea")], index);
    expect(result.countNay).toBe(0);
    expect(result.avgNetWorthNay).toBe(0);
    expect(Number.isNaN(result.avgNetWorthNay)).toBe(false);
  });

  it("resolves a mix of Senate (lisId) and House (bioguide) members correctly", () => {
    const result = calculateNetWorthBreakdown(
      [vote("H1", "", "Yea"), vote("", "S001", "Yea"), vote("H3", "", "Nay"), vote("", "S002", "Nay")],
      index
    );
    expect(result.avgNetWorthYea).toBe(6_000_000); // (1M [H1] + 11M [S001]) / 2
    expect(result.avgNetWorthNay).toBe(2_000_000); // (5M [H3] + -1M [S002]) / 2
  });

  it("reports coverage as the matched share of the members who took a side", () => {
    const result = calculateNetWorthBreakdown(
      [vote("H1", "", "Yea"), vote("ZZZ1", "", "Yea"), vote("ZZZ2", "", "Nay"), vote("H3", "", "Nay")],
      index
    );
    expect(result.coverage).toBe(0.5);
  });

  it("reports full coverage when nobody took a side, so an empty vote isn't treated as a data failure", () => {
    const result = calculateNetWorthBreakdown([vote("H1", "", "Present")], index);
    expect(result.coverage).toBe(1);
    expect(Number.isNaN(result.coverage)).toBe(false);
  });
});

describe("mean / median", () => {
  it("returns 0 rather than NaN for an empty set", () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(Number.isNaN(mean([]))).toBe(false);
    expect(Number.isNaN(median([]))).toBe(false);
  });

  it("returns the value itself for a single-element set", () => {
    expect(mean([7])).toBe(7);
    expect(median([7])).toBe(7);
  });

  it("takes the middle value of an odd-sized set", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("averages the two middle values of an even-sized set", () => {
    expect(median([1, 3, 5, 9])).toBe(4);
  });

  it("sorts numerically, not lexicographically", () => {
    // The default Array.sort() would order these as 10, 100, 9 and return 100.
    expect(median([9, 10, 100])).toBe(10);
  });

  it("does not mutate the array it is given", () => {
    const values = [5, 1, 3];
    median(values);
    expect(values).toEqual([5, 1, 3]);
  });

  it("handles negative values", () => {
    expect(median([-5, -1, -3])).toBe(-3);
    expect(mean([-4, 2])).toBe(-1);
  });

  it("diverges sharply from the mean when one member dominates — the reason both are posted", () => {
    // Nine members around $500K and one billionaire.
    const values = [400_000, 450_000, 500_000, 500_000, 520_000, 550_000, 600_000, 700_000, 800_000, 1_000_000_000];
    expect(median(values)).toBe(535_000);
    expect(mean(values)).toBeGreaterThan(100_000_000);
  });
});

describe("hasSufficientCoverage", () => {
  function breakdownWith(coverage: number) {
    return {
      avgNetWorthYea: 0,
      avgNetWorthNay: 0,
      medianNetWorthYea: 0,
      medianNetWorthNay: 0,
      countYea: 0,
      countNay: 0,
      matched: 0,
      unmatched: 0,
      coverage,
    };
  }

  it("accepts coverage exactly at the threshold", () => {
    expect(hasSufficientCoverage(breakdownWith(MIN_COVERAGE))).toBe(true);
  });

  it("rejects coverage just below the threshold", () => {
    expect(hasSufficientCoverage(breakdownWith(MIN_COVERAGE - 0.01))).toBe(false);
  });

  it("accepts full coverage", () => {
    expect(hasSufficientCoverage(breakdownWith(1))).toBe(true);
  });

  it("rejects a vote where nothing matched at all", () => {
    expect(hasSufficientCoverage(breakdownWith(0))).toBe(false);
  });
});

describe("formatMoney", () => {
  it("formats billions with one decimal place", () => {
    expect(formatMoney(1_250_000_000)).toBe("$1.3B");
  });

  it("formats millions with one decimal place", () => {
    expect(formatMoney(6_240_000)).toBe("$6.2M");
  });

  it("formats thousands with no decimal place", () => {
    expect(formatMoney(450_400)).toBe("$450K");
  });

  it("formats sub-thousand amounts as whole dollars", () => {
    expect(formatMoney(820.4)).toBe("$820");
  });

  it("formats zero", () => {
    expect(formatMoney(0)).toBe("$0");
  });

  it("puts the minus sign before the dollar sign", () => {
    expect(formatMoney(-1_200_000)).toBe("-$1.2M");
  });

  it("formats a small negative amount", () => {
    expect(formatMoney(-500)).toBe("-$500");
  });

  it("uses the millions unit at exactly one million", () => {
    expect(formatMoney(1_000_000)).toBe("$1.0M");
  });

  it("uses the thousands unit just below one million", () => {
    expect(formatMoney(999_999)).toBe("$1000K");
  });
});

describe("formatNetWorth", () => {
  it("shows average and median separated by a pipe, with the member count", () => {
    expect(formatNetWorth(6_240_000, 1_100_000, 218)).toBe("$6.2M | $1.1M (218 members)");
  });

  it("returns n/a when count is 0", () => {
    expect(formatNetWorth(0, 0, 0)).toBe("n/a");
  });

  it("uses singular 'member' for a count of 1", () => {
    expect(formatNetWorth(3_000_000, 3_000_000, 1)).toBe("$3.0M | $3.0M (1 member)");
  });

  it("uses plural 'members' for a count greater than 1", () => {
    expect(formatNetWorth(3_000_000, 2_000_000, 2)).toBe("$3.0M | $2.0M (2 members)");
  });

  it("keeps a median far below the average visible — the skew is the point", () => {
    // One billionaire among modest members: the mean says $50M, the median
    // says $400K, and a post showing only the mean would be misleading.
    expect(formatNetWorth(50_000_000, 400_000, 20)).toBe("$50.0M | $400K (20 members)");
  });
});

describe("buildNetWorthPost", () => {
  const senateVote: NetWorthVoteResult = {
    id: "senate-2026-100",
    chamber: "Senate",
    voteNumber: "100",
    date: "2026-03-01",
    question: "On Passage of the Bill",
    description: "A bill to reauthorize the thing",
    result: "Passed",
    yeas: 60,
    nays: 40,
    url: "https://example.com",
    billUrl: "https://www.congress.gov/bill/119th-congress/senate-bill/100",
    avgNetWorthYea: 6_240_000,
    avgNetWorthNay: 4_100_000,
    medianNetWorthYea: 1_100_000,
    medianNetWorthNay: 950_000,
    countYea: 60,
    countNay: 40,
    matched: 100,
    unmatched: 0,
    coverage: 1,
  };

  const houseVote: NetWorthVoteResult = {
    id: "house-2026-250",
    chamber: "House",
    voteNumber: "250",
    date: "2026-05-14",
    question: "On Agreeing to the Resolution",
    description: "Providing for consideration of H.R. 1234",
    result: "Agreed to",
    yeas: 218,
    nays: 200,
    url: "https://clerk.house.gov/Votes/2026250",
    billUrl: "https://www.congress.gov/bill/119th-congress/house-resolution/250",
    avgNetWorthYea: 2_700_000,
    avgNetWorthNay: 5_900_000,
    medianNetWorthYea: 820_000,
    medianNetWorthNay: 1_400_000,
    countYea: 218,
    countNay: 200,
    matched: 418,
    unmatched: 0,
    coverage: 1,
  };

  it("builds the exact full post for a representative Senate vote", () => {
    const post = buildNetWorthPost(senateVote);
    expect(post.text).toBe(
      "Senate Vote: On Passage of the Bill\n" +
        "A bill to reauthorize the thing\n" +
        "Result: Passed (60-40)\n\n" +
        "💰 Net worth (avg | median):\n" +
        "✅ YES: $6.2M | $1.1M (60 members)\n" +
        "❌  NO: $4.1M | $950K (40 members)"
    );
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_POST_LENGTH);
  });

  it("builds the exact full post for a representative House vote", () => {
    const post = buildNetWorthPost(houseVote);
    expect(post.text).toBe(
      "House Vote: On Agreeing to the Resolution\n" +
        "Providing for consideration of H.R. 1234\n" +
        "Result: Agreed to (218-200)\n\n" +
        "💰 Net worth (avg | median):\n" +
        "✅ YES: $2.7M | $820K (218 members)\n" +
        "❌  NO: $5.9M | $1.4M (200 members)"
    );
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_POST_LENGTH);
  });

  it("omits the description line when there is no description", () => {
    const post = buildNetWorthPost({ ...houseVote, description: "" });
    expect(post.text).not.toContain("Providing for consideration");
    expect(
      post.text.startsWith("House Vote: On Agreeing to the Resolution\nResult: Agreed to (218-200)")
    ).toBe(true);
    expect(post.facets).toEqual([]);
  });

  it("renders a negative average without breaking the layout", () => {
    const post = buildNetWorthPost({
      ...senateVote,
      avgNetWorthNay: -1_200_000,
      medianNetWorthNay: -300_000,
    });
    expect(post.text).toContain("❌  NO: -$1.2M | -$300K (40 members)");
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_POST_LENGTH);
  });

  it("shows n/a for a unanimous vote where one side has no voters", () => {
    const post = buildNetWorthPost({
      ...senateVote,
      avgNetWorthNay: 0,
      medianNetWorthNay: 0,
      countNay: 0,
      nays: 0,
    });
    expect(post.text).toContain("❌  NO: n/a");
  });

  it("shortens an over-length description instead of cutting off the Result/net worth lines", () => {
    const longDescription =
      "Providing for consideration of the bills (H.R. 8800, H.R. 8884, H.R. 7008, " +
      "H.R. 6955, and H.R. 9770); and providing for consideration of the concurrent " +
      "resolution (H. Con. Res. 113)";
    const vote: NetWorthVoteResult = {
      ...houseVote,
      id: "house-2026-251",
      voteNumber: "251",
      description: longDescription,
      yeas: 214,
      nays: 211,
      countYea: 214,
      countNay: 211,
      url: "https://clerk.house.gov/Votes/2026251",
      billUrl: "https://www.congress.gov/bill/119th-congress/house-resolution/113",
    };

    const post = buildNetWorthPost(vote);

    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_POST_LENGTH);
    // The Result and net worth lines must survive intact, not get sliced.
    expect(post.text).toContain("Result: Agreed to (214-211)");
    expect(post.text).toContain("💰 Net worth (avg | median):");
    expect(post.text).toContain("✅ YES: $2.7M | $820K (214 members)");
    expect(post.text).toContain("❌  NO: $5.9M | $1.4M (211 members)");
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

  it("links exactly the description text to the bill when billUrl is set", () => {
    const post = buildNetWorthPost(senateVote);
    expect(post.text).not.toContain(senateVote.billUrl); // link is a facet, not visible text
    expect(post.facets).toHaveLength(1);
    expect(post.facets[0].uri).toBe(senateVote.billUrl);
    expect(facetText(post.text, post.facets[0])).toBe("A bill to reauthorize the thing");
  });
});
