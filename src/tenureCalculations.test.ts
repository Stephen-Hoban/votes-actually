import { describe, it, expect } from "vitest";
import {
  parseUtcDate,
  daysBetween,
  addDays,
  summarizeService,
  serviceDays,
  tenureYearsFromDays,
  nextTenureAnniversary,
  buildMemberTenure,
  isTenureStale,
  refreshStaleTenures,
  buildMemberTenureIndex,
  lookupMemberTenure,
  calculateAverageTenures,
  formatTenure,
  buildTenurePost,
  MemberTenure,
  TenureMemberVote,
  TenureVoteResult,
  ServiceTerm,
} from "./tenureCalculations.js";
import { graphemeLength, MAX_POST_LENGTH } from "./voteCalculations.js";

// Decodes a facet's byte range back into the substring of `text` it covers,
// so tests can assert on readable text instead of raw byte offsets.
function facetText(text: string, facet: { byteStart: number; byteEnd: number }): string {
  return Buffer.from(text, "utf-8").slice(facet.byteStart, facet.byteEnd).toString("utf-8");
}

// Fills in the fields tests don't care about so each fixture only needs to
// state what's relevant to the case at hand.
function makeMember(overrides: Partial<MemberTenure>): MemberTenure {
  return {
    bioguide: "",
    lisId: "",
    name: "Test Member",
    state: "NC",
    party: "D",
    chamber: "House",
    priorServiceDays: 0,
    currentTermStart: "2020-01-03",
    tenureYears: 0,
    tenureValidUntil: "2099-01-01",
    ...overrides,
  };
}

describe("parseUtcDate", () => {
  it("parses a YYYY-MM-DD string as a UTC timestamp", () => {
    expect(parseUtcDate("2026-01-05")).toBe(Date.UTC(2026, 0, 5));
  });

  it("returns NaN for an empty string", () => {
    expect(Number.isNaN(parseUtcDate(""))).toBe(true);
  });

  it("returns NaN for unparseable input", () => {
    expect(Number.isNaN(parseUtcDate("not-a-date"))).toBe(true);
  });
});

describe("daysBetween", () => {
  it("counts whole days between two dates", () => {
    expect(daysBetween("2026-01-01", "2026-01-11")).toBe(10);
  });

  it("counts an extra day across a leap-year February", () => {
    expect(daysBetween("2024-02-01", "2024-03-01")).toBe(29);
  });

  it("counts one fewer day across a non-leap-year February", () => {
    expect(daysBetween("2023-02-01", "2023-03-01")).toBe(28);
  });

  it("is negative when the range is reversed", () => {
    expect(daysBetween("2026-01-11", "2026-01-01")).toBe(-10);
  });

  it("returns 0 for malformed input rather than NaN", () => {
    expect(daysBetween("garbage", "2026-01-01")).toBe(0);
    expect(daysBetween("2026-01-01", "garbage")).toBe(0);
  });
});

describe("addDays", () => {
  it("adds positive days", () => {
    expect(addDays("2026-01-01", 10)).toBe("2026-01-11");
  });

  it("subtracts for negative days", () => {
    expect(addDays("2026-01-11", -10)).toBe("2026-01-01");
  });

  it("rolls across a leap day correctly", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("returns the input unchanged for malformed input", () => {
    expect(addDays("garbage", 5)).toBe("garbage");
  });
});

describe("summarizeService", () => {
  it("returns the current term's start with no prior service for a single current term", () => {
    const terms: ServiceTerm[] = [{ start: "2020-01-03", end: "2027-01-03" }];
    expect(summarizeService(terms, new Date("2026-09-03T00:00:00Z"))).toEqual({
      priorServiceDays: 0,
      currentTermStart: "2020-01-03",
    });
  });

  it("sums multiple consecutive completed terms plus a current one", () => {
    const terms: ServiceTerm[] = [
      { start: "2005-01-03", end: "2007-01-03" },
      { start: "2007-01-03", end: "2009-01-03" },
      { start: "2009-01-03", end: "2011-01-03" },
      { start: "2011-01-03", end: "2027-01-03" }, // current: scheduled end still in the future
    ];
    expect(summarizeService(terms, new Date("2026-09-03T00:00:00Z"))).toEqual({
      priorServiceDays: 2191, // three completed 2-year terms
      currentTermStart: "2011-01-03",
    });
  });

  it("excludes a gap between service stretches (left and came back)", () => {
    const terms: ServiceTerm[] = [
      { start: "2010-01-03", end: "2014-01-03" }, // served, then left
      // gap: 2014-01-03 -> 2020-01-03 not in office, must not be counted
      { start: "2020-01-03", end: "2027-01-03" }, // returned, currently serving
    ];
    const result = summarizeService(terms, new Date("2026-09-03T00:00:00Z"));
    expect(result).toEqual({
      priorServiceDays: 1461, // exactly the first (served) term's days
      currentTermStart: "2020-01-03",
    });
    // Sanity check: the gap itself is not folded in anywhere.
    expect(result!.priorServiceDays).toBe(daysBetween("2010-01-03", "2014-01-03"));
  });

  it("ignores terms that start in the future", () => {
    const terms: ServiceTerm[] = [{ start: "2030-01-03", end: "2032-01-03" }];
    expect(summarizeService(terms, new Date("2026-09-03T00:00:00Z"))).toBeNull();
  });

  it("ignores a future term even when past terms exist, still returning null with no current term", () => {
    const terms: ServiceTerm[] = [
      { start: "2005-01-03", end: "2007-01-03" },
      { start: "2011-01-03", end: "2013-01-03" },
      { start: "2030-01-03", end: "2032-01-03" }, // future, ignored entirely
    ];
    expect(summarizeService(terms, new Date("2026-09-03T00:00:00Z"))).toBeNull();
  });

  it("returns null when no term contains asOf", () => {
    const terms: ServiceTerm[] = [{ start: "2005-01-03", end: "2007-01-03" }];
    expect(summarizeService(terms, new Date("2026-09-03T00:00:00Z"))).toBeNull();
  });

  it("treats a term whose end is still in the future as the current term", () => {
    const terms: ServiceTerm[] = [{ start: "2023-01-03", end: "2029-01-03" }];
    const result = summarizeService(terms, new Date("2026-09-03T00:00:00Z"));
    expect(result).toEqual({ priorServiceDays: 0, currentTermStart: "2023-01-03" });
  });

  it("picks the earliest of overlapping/duplicated current terms", () => {
    const terms: ServiceTerm[] = [
      { start: "2015-01-03", end: "2027-01-03" },
      { start: "2011-01-03", end: "2027-01-03" },
    ];
    expect(summarizeService(terms, new Date("2026-09-03T00:00:00Z"))).toEqual({
      priorServiceDays: 0,
      currentTermStart: "2011-01-03",
    });
  });
});

describe("serviceDays", () => {
  it("adds prior service to days elapsed in the current term", () => {
    const service = { priorServiceDays: 500, currentTermStart: "2020-01-03" };
    expect(serviceDays(service, new Date("2026-09-03T00:00:00Z"))).toBe(2935); // 500 + 2435
  });

  it("clamps elapsed current-term days to 0 rather than going negative", () => {
    // asOf before currentTermStart shouldn't happen in practice, but the
    // function must not let a negative elapsed count reduce priorServiceDays.
    const service = { priorServiceDays: 100, currentTermStart: "2027-01-03" };
    expect(serviceDays(service, new Date("2026-09-03T00:00:00Z"))).toBe(100);
  });
});

describe("tenureYearsFromDays", () => {
  it("is still 0 years at 365 days", () => {
    expect(tenureYearsFromDays(365)).toBe(0);
  });

  it("ticks over to 1 year at 366 days", () => {
    expect(tenureYearsFromDays(366)).toBe(1);
  });

  it("is still 1 year at 730 days", () => {
    expect(tenureYearsFromDays(730)).toBe(1);
  });

  it("ticks over to 2 years at 731 days", () => {
    expect(tenureYearsFromDays(731)).toBe(2);
  });

  it("clamps negative days to 0 years", () => {
    expect(tenureYearsFromDays(-100)).toBe(0);
  });
});

describe("nextTenureAnniversary / buildMemberTenure", () => {
  it("derives tenureYears and tenureValidUntil consistently, with no prior service", () => {
    const member = buildMemberTenure(
      {
        bioguide: "H2",
        lisId: "",
        name: "Test Member",
        state: "NC",
        party: "D",
        chamber: "House",
        priorServiceDays: 0,
        currentTermStart: "2021-01-03",
      },
      new Date("2026-09-03T00:00:00Z")
    );

    expect(member.tenureYears).toBe(5);
    expect(member.tenureValidUntil).toBe("2027-01-04");

    const service = { priorServiceDays: 0, currentTermStart: "2021-01-03" };
    const dayBefore = new Date(`${addDays(member.tenureValidUntil, -1)}T00:00:00Z`);
    const onTheDay = new Date(`${member.tenureValidUntil}T00:00:00Z`);

    // The day before the anniversary, the whole-year figure hasn't moved yet.
    expect(tenureYearsFromDays(serviceDays(service, dayBefore))).toBe(member.tenureYears);
    // On the anniversary itself, it's incremented by exactly 1.
    expect(tenureYearsFromDays(serviceDays(service, onTheDay))).toBe(member.tenureYears + 1);
  });

  it("derives tenureYears and tenureValidUntil consistently, with non-zero prior service", () => {
    const member = buildMemberTenure(
      {
        bioguide: "H1",
        lisId: "",
        name: "Test Member",
        state: "NC",
        party: "D",
        chamber: "House",
        priorServiceDays: 500,
        currentTermStart: "2020-01-03",
      },
      new Date("2026-09-03T00:00:00Z")
    );

    expect(member.tenureYears).toBe(8);
    expect(member.tenureValidUntil).toBe("2027-08-22");

    const service = { priorServiceDays: 500, currentTermStart: "2020-01-03" };
    const dayBefore = new Date(`${addDays(member.tenureValidUntil, -1)}T00:00:00Z`);
    const onTheDay = new Date(`${member.tenureValidUntil}T00:00:00Z`);

    expect(tenureYearsFromDays(serviceDays(service, dayBefore))).toBe(member.tenureYears);
    expect(tenureYearsFromDays(serviceDays(service, onTheDay))).toBe(member.tenureYears + 1);
  });

  it("preserves every other field untouched", () => {
    const member = buildMemberTenure(
      {
        bioguide: "H1",
        lisId: "",
        name: "Test Member",
        state: "NC",
        party: "D",
        chamber: "House",
        priorServiceDays: 500,
        currentTermStart: "2020-01-03",
      },
      new Date("2026-09-03T00:00:00Z")
    );

    expect(member).toEqual({
      bioguide: "H1",
      lisId: "",
      name: "Test Member",
      state: "NC",
      party: "D",
      chamber: "House",
      priorServiceDays: 500,
      currentTermStart: "2020-01-03",
      tenureYears: 8,
      tenureValidUntil: "2027-08-22",
    });
  });
});

describe("isTenureStale", () => {
  const member = makeMember({ tenureValidUntil: "2026-08-01" });

  it("is false before tenureValidUntil", () => {
    expect(isTenureStale(member, new Date("2026-07-28T00:00:00Z"))).toBe(false);
  });

  it("is true exactly on tenureValidUntil — that's the day the figure changes", () => {
    expect(isTenureStale(member, new Date("2026-08-01T00:00:00Z"))).toBe(true);
  });

  it("is true after tenureValidUntil", () => {
    expect(isTenureStale(member, new Date("2026-08-02T00:00:00Z"))).toBe(true);
  });
});

describe("refreshStaleTenures", () => {
  it("updates stale entries in place and leaves fresh ones untouched", () => {
    const staleMember = makeMember({
      bioguide: "H1",
      name: "Stale Person",
      priorServiceDays: 0,
      currentTermStart: "2020-01-03",
      tenureYears: 999, // deliberately wrong, to prove it gets recomputed rather than left alone
      tenureValidUntil: "2020-01-01", // long past asOf below
    });
    const freshMember = makeMember({
      bioguide: "H2",
      name: "Fresh Person",
      priorServiceDays: 0,
      currentTermStart: "1990-01-01",
      tenureYears: 42,
      tenureValidUntil: "2027-01-01", // still in the future relative to asOf below
    });
    const members = [staleMember, freshMember];
    const asOf = new Date("2026-07-28T00:00:00Z");

    const updated = refreshStaleTenures(members, asOf);

    // Returns exactly the members that were updated.
    expect(updated).toEqual([
      { ...staleMember, tenureYears: 6, tenureValidUntil: "2027-01-03" },
    ]);

    // The original array's objects were mutated in place, not replaced.
    expect(members[0]).toBe(staleMember);
    expect(members[1]).toBe(freshMember);
    expect(staleMember.tenureYears).toBe(6);
    expect(staleMember.tenureValidUntil).toBe("2027-01-03");

    // The fresh member's cached values are untouched.
    expect(freshMember.tenureYears).toBe(42);
    expect(freshMember.tenureValidUntil).toBe("2027-01-01");
  });
});

describe("buildMemberTenureIndex / lookupMemberTenure", () => {
  const houseMembers = [
    makeMember({ bioguide: "H1", lisId: "", chamber: "House", tenureYears: 3 }),
    makeMember({ bioguide: "H2", lisId: "", chamber: "House", tenureYears: 4 }),
  ];
  const senator = makeMember({ bioguide: "", lisId: "S1", chamber: "Senate", tenureYears: 17 });
  const index = buildMemberTenureIndex([...houseMembers, senator]);

  it("finds a House member by bioguide", () => {
    expect(lookupMemberTenure(index, { bioguide: "H1", lisId: "", voteCast: "Yea" })).toBe(houseMembers[0]);
  });

  it("finds a senator by LIS id", () => {
    expect(lookupMemberTenure(index, { bioguide: "", lisId: "S1", voteCast: "Yea" })).toBe(senator);
  });

  it("prefers bioguide when both a bioguide and an LIS id match", () => {
    const both = makeMember({ bioguide: "H3", lisId: "S3", chamber: "House", tenureYears: 9 });
    const bothIndex = buildMemberTenureIndex([...houseMembers, senator, both]);
    expect(lookupMemberTenure(bothIndex, { bioguide: "H3", lisId: "S3", voteCast: "Yea" })).toBe(both);
  });

  it("does not index members with an empty id under the empty string", () => {
    // Both House members share lisId "" — if that were indexed naively, the
    // second one would clobber the first under the "" key.
    expect(index.byLis.has("")).toBe(false);
    // Likewise the senator has no bioguide.
    expect(index.byBioguide.has("")).toBe(false);
  });

  it("returns undefined when neither identifier matches", () => {
    expect(lookupMemberTenure(index, { bioguide: "ZZZ999", lisId: "", voteCast: "Yea" })).toBeUndefined();
    expect(lookupMemberTenure(index, { bioguide: "", lisId: "", voteCast: "Yea" })).toBeUndefined();
  });
});

describe("calculateAverageTenures", () => {
  const houseMembers = [
    makeMember({ bioguide: "H1", lisId: "", chamber: "House", tenureYears: 2 }),
    makeMember({ bioguide: "H2", lisId: "", chamber: "House", tenureYears: 4 }),
    makeMember({ bioguide: "H3", lisId: "", chamber: "House", tenureYears: 10 }),
    makeMember({ bioguide: "H4", lisId: "", chamber: "House", tenureYears: 20 }),
  ];
  const senators = [
    makeMember({ bioguide: "", lisId: "S1", chamber: "Senate", tenureYears: 12 }),
    makeMember({ bioguide: "", lisId: "S2", chamber: "Senate", tenureYears: 24 }),
  ];
  const index = buildMemberTenureIndex([...houseMembers, ...senators]);

  function vote(bioguide: string, lisId: string, voteCast: string): TenureMemberVote {
    return { bioguide, lisId, voteCast };
  }

  it("computes a correct simple average for each side", () => {
    const result = calculateAverageTenures(
      [vote("H1", "", "Yea"), vote("H2", "", "Yea"), vote("H3", "", "Nay"), vote("H4", "", "Nay")],
      index
    );
    expect(result.avgTenureYea).toBe(3); // (2+4)/2
    expect(result.avgTenureNay).toBe(15); // (10+20)/2
    expect(result.countYea).toBe(2);
    expect(result.countNay).toBe(2);
  });

  it("counts House Aye/No resolution codes the same as Yea/Nay", () => {
    // Regression test: the House XML uses Aye/No on resolution votes instead
    // of Yea/Nay. `normalizeHouseVote` folds these together; this test locks
    // in that calculateAverageTenures relies on it.
    const result = calculateAverageTenures(
      [vote("H1", "", "Yea"), vote("H2", "", "Aye"), vote("H3", "", "Nay"), vote("H4", "", "No")],
      index
    );
    expect(result.avgTenureYea).toBe(3); // (2+4)/2, Yea and Aye both counted
    expect(result.avgTenureNay).toBe(15); // (10+20)/2, Nay and No both counted
    expect(result.countYea).toBe(2);
    expect(result.countNay).toBe(2);
    expect(result.matched).toBe(4);
  });

  it("excludes Present and Not Voting from both averages and the counts", () => {
    const result = calculateAverageTenures(
      [vote("H1", "", "Yea"), vote("H2", "", "Present"), vote("H3", "", "Not Voting")],
      index
    );
    expect(result.avgTenureYea).toBe(2);
    expect(result.countYea).toBe(1);
    expect(result.countNay).toBe(0);
    expect(result.matched).toBe(1);
    // Present/Not Voting members are filtered out before the lookup even
    // happens, so they must not be counted as unmatched either.
    expect(result.unmatched).toBe(0);
  });

  it("counts members missing from the index as unmatched and excludes them from the averages", () => {
    const result = calculateAverageTenures([vote("H1", "", "Yea"), vote("ZZZ999", "", "Yea")], index);
    expect(result.avgTenureYea).toBe(2); // only H1 counted
    expect(result.countYea).toBe(1);
    expect(result.unmatched).toBe(1);
  });

  it("yields avgTenure 0 and count 0 (not NaN) for a side with zero voters", () => {
    // A unanimous vote: nobody voted Nay at all.
    const result = calculateAverageTenures([vote("H1", "", "Yea"), vote("H2", "", "Yea")], index);
    expect(result.countNay).toBe(0);
    expect(result.avgTenureNay).toBe(0);
    expect(Number.isNaN(result.avgTenureNay)).toBe(false);
  });

  it("resolves a mix of Senate (lisId) and House (bioguide) members correctly", () => {
    const result = calculateAverageTenures(
      [vote("H1", "", "Yea"), vote("", "S1", "Yea"), vote("H3", "", "Nay"), vote("", "S2", "Nay")],
      index
    );
    expect(result.avgTenureYea).toBe(7); // (2 [H1] + 12 [S1]) / 2
    expect(result.avgTenureNay).toBe(17); // (10 [H3] + 24 [S2]) / 2
    expect(result.countYea).toBe(2);
    expect(result.countNay).toBe(2);
  });
});

describe("formatTenure", () => {
  it("formats with one decimal place", () => {
    expect(formatTenure(12.666, 4)).toBe("12.7 yrs (4 members)");
  });

  it("returns n/a when count is 0", () => {
    expect(formatTenure(0, 0)).toBe("n/a");
  });

  it("uses singular 'member' for a count of 1", () => {
    expect(formatTenure(9, 1)).toBe("9.0 yrs (1 member)");
  });

  it("uses plural 'members' for a count greater than 1", () => {
    expect(formatTenure(9, 2)).toBe("9.0 yrs (2 members)");
  });
});

describe("buildTenurePost", () => {
  const senateVote: TenureVoteResult = {
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
    billDesignation: "S. 100",
    billTitle: "Thing Reauthorization Act of 2026",
    avgTenureYea: 8.3,
    avgTenureNay: 12.5,
    countYea: 60,
    countNay: 40,
    matched: 100,
    unmatched: 0,
  };

  const houseVote: TenureVoteResult = {
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
    billDesignation: "H.Res. 250",
    billTitle: "",
    avgTenureYea: 5.7,
    avgTenureNay: 9.1,
    countYea: 218,
    countNay: 200,
    matched: 418,
    unmatched: 0,
  };

  it("builds the exact full post for a representative Senate vote", () => {
    const post = buildTenurePost(senateVote);
    expect(post.text).toBe(
      "Senate Vote: On Passage of the Bill\n" +
        "S. 100: Thing Reauthorization Act of 2026\n" +
        "Result: Passed (60-40)\n\n" +
        "⏳ Average time in office:\n" +
        "✅ YES: 8.3 yrs (60 members)\n" +
        "❌  NO: 12.5 yrs (40 members)"
    );
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_POST_LENGTH);
  });

  it("builds the exact full post for a representative House vote, falling back to the description with no bill title", () => {
    const post = buildTenurePost(houseVote);
    expect(post.text).toBe(
      "House Vote: On Agreeing to the Resolution\n" +
        "Providing for consideration of H.R. 1234\n" +
        "Result: Agreed to (218-200)\n\n" +
        "⏳ Average time in office:\n" +
        "✅ YES: 5.7 yrs (218 members)\n" +
        "❌  NO: 9.1 yrs (200 members)"
    );
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_POST_LENGTH);
  });

  it("links the bill line to congress.gov when billUrl is set", () => {
    const post = buildTenurePost(senateVote);
    expect(post.text).not.toContain(senateVote.billUrl); // link is a facet, not visible text
    expect(post.facets).toHaveLength(1);
    expect(post.facets[0].uri).toBe(senateVote.billUrl);
    expect(facetText(post.text, post.facets[0])).toBe("S. 100: Thing Reauthorization Act of 2026");
  });

  it("shortens an absurdly long bill title instead of cutting off the Result/tenure lines", () => {
    const absurdTitle =
      "An Extraordinarily and Unnecessarily Verbose Act to Reauthorize, Expand, Rename, " +
      "Restructure, and Otherwise Comprehensively Overhaul Every Program, Office, Bureau, " +
      "Committee, and Advisory Board Touching Upon the Subject Matter Herein Described, " +
      "Together With Such Further Provisions as May Be Necessary and Proper to Effectuate " +
      "the Purposes of This Act, of 2026";
    const vote: TenureVoteResult = {
      ...senateVote,
      id: "senate-2026-101",
      voteNumber: "101",
      billTitle: absurdTitle,
    };

    const post = buildTenurePost(vote);

    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_POST_LENGTH);
    // The Result and tenure lines must survive intact, not get sliced.
    expect(post.text).toContain("Result: Passed (60-40)");
    expect(post.text).toContain("⏳ Average time in office:");
    expect(post.text).toContain("✅ YES: 8.3 yrs (60 members)");
    expect(post.text).toContain("❌  NO: 12.5 yrs (40 members)");
    // The bill title was shortened...
    expect(post.text).toContain("…");
    expect(post.text).not.toContain(vote.billUrl);
    // ...and the shortened bill line (ellipsis included) still links to the bill.
    expect(post.facets).toHaveLength(1);
    expect(post.facets[0].uri).toBe(vote.billUrl);
    const linkedText = facetText(post.text, post.facets[0]);
    expect(linkedText.endsWith("…")).toBe(true);
    expect(`${vote.billDesignation}: ${absurdTitle}`.startsWith(linkedText.slice(0, -1))).toBe(true);
  });

  it("omits the bill line and facet when there's no billTitle and no description", () => {
    const post = buildTenurePost({ ...houseVote, description: "", billTitle: "" });
    expect(post.text).not.toContain("Providing for consideration");
    expect(post.text.startsWith("House Vote: On Agreeing to the Resolution\nResult: Agreed to (218-200)")).toBe(
      true
    );
    expect(post.facets).toEqual([]);
  });
});
