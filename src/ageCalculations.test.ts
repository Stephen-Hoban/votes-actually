import { describe, it, expect } from "vitest";
import {
  calculateAge,
  nextBirthday,
  toIsoDate,
  buildMemberAge,
  isAgeStale,
  refreshStaleAges,
  buildMemberAgeIndex,
  lookupMemberAge,
  calculateAverageAges,
  formatAge,
  buildAgePost,
  MemberAge,
  AgeMemberVote,
  AgeVoteResult,
} from "./ageCalculations.js";
import { graphemeLength, MAX_POST_LENGTH } from "./voteCalculations.js";

// Decodes a facet's byte range back into the substring of `text` it covers,
// so tests can assert on readable text instead of raw byte offsets.
function facetText(text: string, facet: { byteStart: number; byteEnd: number }): string {
  return Buffer.from(text, "utf-8").slice(facet.byteStart, facet.byteEnd).toString("utf-8");
}

// Fills in the fields tests don't care about so each fixture only needs to
// state what's relevant to the case at hand.
function makeMember(overrides: Partial<MemberAge>): MemberAge {
  return {
    bioguide: "",
    lisId: "",
    name: "Test Member",
    state: "NC",
    party: "D",
    chamber: "House",
    birthday: "1900-01-01",
    age: 0,
    ageValidUntil: "2099-01-01",
    ...overrides,
  };
}

describe("calculateAge", () => {
  it("does not decrement when this year's birthday has already passed", () => {
    // Born Jan 15, asked about on Jul 28: birthday was months ago.
    expect(calculateAge("1960-01-15", new Date("2026-07-28T00:00:00Z"))).toBe(66);
  });

  it("decrements when this year's birthday hasn't happened yet", () => {
    // Born Dec 15, asked about on Jul 28: birthday is still months away.
    expect(calculateAge("1960-12-15", new Date("2026-07-28T00:00:00Z"))).toBe(65);
  });

  it("counts the birthday itself as the new age", () => {
    expect(calculateAge("1960-07-28", new Date("2026-07-28T00:00:00Z"))).toBe(66);
  });

  it("does not yet increment a Feb 29 birthday on Feb 28 of a non-leap year", () => {
    // 2025 has no Feb 29, so the birthday hasn't "arrived" yet on Feb 28.
    expect(calculateAge("2000-02-29", new Date("2025-02-28T00:00:00Z"))).toBe(24);
  });

  it("increments a Feb 29 birthday on Mar 1 of a non-leap year", () => {
    // The day after Feb 28 in a non-leap year is when the age finally ticks over.
    expect(calculateAge("2000-02-29", new Date("2025-03-01T00:00:00Z"))).toBe(25);
  });

  it("is timezone-independent because all math runs in UTC", () => {
    // Constructing `asOf` from a UTC ISO string (rather than a local Date)
    // and computing the age via UTC getters means the result can't shift by a
    // day depending on the machine's local timezone.
    expect(calculateAge("1990-07-28", new Date("2026-07-28T00:00:00Z"))).toBe(36);
  });
});

describe("nextBirthday", () => {
  it("returns this year's date when the birthday is still upcoming", () => {
    expect(nextBirthday("1990-12-15", new Date("2026-07-28T00:00:00Z"))).toBe("2026-12-15");
  });

  it("returns next year's date when the birthday has already passed", () => {
    expect(nextBirthday("1990-01-15", new Date("2026-07-28T00:00:00Z"))).toBe("2027-01-15");
  });

  it("returns next year's date when the birthday is exactly today", () => {
    // Today is the day the age just changed, so the *next* change is a year out.
    expect(nextBirthday("1990-07-28", new Date("2026-07-28T00:00:00Z"))).toBe("2027-07-28");
  });

  it("rolls a Feb 29 birthday to Mar 1 when the target year isn't a leap year", () => {
    expect(nextBirthday("2000-02-29", new Date("2025-01-15T00:00:00Z"))).toBe("2025-03-01");
  });

  it("keeps a Feb 29 birthday on Feb 29 when the target year is a leap year", () => {
    expect(nextBirthday("2000-02-29", new Date("2024-01-15T00:00:00Z"))).toBe("2024-02-29");
  });
});

describe("toIsoDate", () => {
  it("formats a UTC date with zero-padded month and day", () => {
    expect(toIsoDate(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
  });

  it("formats without extra padding when month/day are already two digits", () => {
    expect(toIsoDate(new Date("2026-09-03T12:00:00Z"))).toBe("2026-09-03");
  });
});

describe("buildMemberAge", () => {
  it("derives age and ageValidUntil from the birthday and preserves the rest", () => {
    const member = buildMemberAge(
      {
        bioguide: "H0001",
        lisId: "",
        name: "Test Member",
        state: "NC",
        party: "D",
        chamber: "House",
        birthday: "1980-05-10",
      },
      new Date("2026-07-28T00:00:00Z")
    );

    expect(member).toEqual({
      bioguide: "H0001",
      lisId: "",
      name: "Test Member",
      state: "NC",
      party: "D",
      chamber: "House",
      birthday: "1980-05-10",
      age: 46,
      ageValidUntil: "2027-05-10",
    });
  });
});

describe("isAgeStale", () => {
  const member = makeMember({ ageValidUntil: "2026-08-01" });

  it("is false before ageValidUntil", () => {
    expect(isAgeStale(member, new Date("2026-07-28T00:00:00Z"))).toBe(false);
  });

  it("is true exactly on ageValidUntil — that's the day the age changes", () => {
    expect(isAgeStale(member, new Date("2026-08-01T00:00:00Z"))).toBe(true);
  });

  it("is true after ageValidUntil", () => {
    expect(isAgeStale(member, new Date("2026-08-02T00:00:00Z"))).toBe(true);
  });
});

describe("refreshStaleAges", () => {
  it("updates stale entries in place and leaves fresh ones untouched", () => {
    const staleMember = makeMember({
      bioguide: "H1",
      name: "Stale Person",
      birthday: "1970-01-01",
      age: 999, // deliberately wrong, to prove it gets recomputed rather than left alone
      ageValidUntil: "2020-01-01", // long past asOf below
    });
    const freshMember = makeMember({
      bioguide: "H2",
      name: "Fresh Person",
      birthday: "1980-01-01",
      age: 42,
      ageValidUntil: "2027-01-01", // still in the future relative to asOf below
    });
    const members = [staleMember, freshMember];
    const asOf = new Date("2026-07-28T00:00:00Z");

    const updated = refreshStaleAges(members, asOf);

    // Returns exactly the members that were updated.
    expect(updated).toEqual([{ ...staleMember, age: 56, ageValidUntil: "2027-01-01" }]);

    // The original array's objects were mutated in place, not replaced.
    expect(members[0]).toBe(staleMember);
    expect(members[1]).toBe(freshMember);
    expect(staleMember.age).toBe(56);
    expect(staleMember.ageValidUntil).toBe("2027-01-01");

    // The fresh member's cached values are untouched.
    expect(freshMember.age).toBe(42);
    expect(freshMember.ageValidUntil).toBe("2027-01-01");
  });
});

describe("buildMemberAgeIndex / lookupMemberAge", () => {
  const houseMembers = [
    makeMember({ bioguide: "H1", lisId: "", chamber: "House", age: 30 }),
    makeMember({ bioguide: "H2", lisId: "", chamber: "House", age: 40 }),
  ];
  const senator = makeMember({ bioguide: "", lisId: "S1", chamber: "Senate", age: 70 });
  const index = buildMemberAgeIndex([...houseMembers, senator]);

  it("finds a House member by bioguide", () => {
    expect(lookupMemberAge(index, { bioguide: "H1", lisId: "", voteCast: "Yea" })).toBe(houseMembers[0]);
  });

  it("finds a senator by LIS id", () => {
    expect(lookupMemberAge(index, { bioguide: "", lisId: "S1", voteCast: "Yea" })).toBe(senator);
  });

  it("does not index members with an empty id under the empty string", () => {
    // Both House members share lisId "" — if that were indexed naively, the
    // second one would clobber the first under the "" key.
    expect(index.byLis.has("")).toBe(false);
    // Likewise the senator has no bioguide.
    expect(index.byBioguide.has("")).toBe(false);
  });

  it("returns undefined for an unknown member", () => {
    expect(lookupMemberAge(index, { bioguide: "ZZZ999", lisId: "", voteCast: "Yea" })).toBeUndefined();
    expect(lookupMemberAge(index, { bioguide: "", lisId: "", voteCast: "Yea" })).toBeUndefined();
  });
});

describe("calculateAverageAges", () => {
  const houseMembers = [
    makeMember({ bioguide: "H1", lisId: "", chamber: "House", age: 30 }),
    makeMember({ bioguide: "H2", lisId: "", chamber: "House", age: 40 }),
    makeMember({ bioguide: "H3", lisId: "", chamber: "House", age: 50 }),
    makeMember({ bioguide: "H4", lisId: "", chamber: "House", age: 60 }),
  ];
  const senators = [
    makeMember({ bioguide: "", lisId: "S1", chamber: "Senate", age: 70 }),
    makeMember({ bioguide: "", lisId: "S2", chamber: "Senate", age: 80 }),
  ];
  const index = buildMemberAgeIndex([...houseMembers, ...senators]);

  function vote(bioguide: string, lisId: string, voteCast: string): AgeMemberVote {
    return { bioguide, lisId, voteCast };
  }

  it("computes a correct simple average for each side", () => {
    const result = calculateAverageAges(
      [vote("H1", "", "Yea"), vote("H2", "", "Yea"), vote("H3", "", "Nay"), vote("H4", "", "Nay")],
      index
    );
    expect(result.avgAgeYea).toBe(35); // (30+40)/2
    expect(result.avgAgeNay).toBe(55); // (50+60)/2
    expect(result.countYea).toBe(2);
    expect(result.countNay).toBe(2);
  });

  it("counts House Aye/No resolution codes the same as Yea/Nay", () => {
    // Regression test: the House XML uses Aye/No on resolution votes instead
    // of Yea/Nay. An earlier version of the population bot didn't normalize
    // these, so resolution votes silently produced zeroed-out numbers — every
    // member counted as unmatched-vote-cast and excluded. `normalizeHouseVote`
    // is what fixes this; this test locks in that calculateAverageAges relies on it.
    const result = calculateAverageAges(
      [vote("H1", "", "Yea"), vote("H2", "", "Aye"), vote("H3", "", "Nay"), vote("H4", "", "No")],
      index
    );
    expect(result.avgAgeYea).toBe(35); // (30+40)/2, Yea and Aye both counted
    expect(result.avgAgeNay).toBe(55); // (50+60)/2, Nay and No both counted
    expect(result.countYea).toBe(2);
    expect(result.countNay).toBe(2);
    expect(result.matched).toBe(4);
  });

  it("excludes Present and Not Voting from both averages and the counts", () => {
    const result = calculateAverageAges(
      [vote("H1", "", "Yea"), vote("H2", "", "Present"), vote("H3", "", "Not Voting")],
      index
    );
    expect(result.avgAgeYea).toBe(30);
    expect(result.countYea).toBe(1);
    expect(result.countNay).toBe(0);
    expect(result.matched).toBe(1);
    // Present/Not Voting members are filtered out before the lookup even
    // happens, so they must not be counted as unmatched either.
    expect(result.unmatched).toBe(0);
  });

  it("counts members missing from the index as unmatched and excludes them from the averages", () => {
    const result = calculateAverageAges([vote("H1", "", "Yea"), vote("ZZZ999", "", "Yea")], index);
    expect(result.avgAgeYea).toBe(30); // only H1 counted
    expect(result.countYea).toBe(1);
    expect(result.unmatched).toBe(1);
  });

  it("yields avgAge 0 and count 0 (not NaN) for a side with zero voters", () => {
    // A unanimous vote: nobody voted Nay at all.
    const result = calculateAverageAges([vote("H1", "", "Yea"), vote("H2", "", "Yea")], index);
    expect(result.countNay).toBe(0);
    expect(result.avgAgeNay).toBe(0);
    expect(Number.isNaN(result.avgAgeNay)).toBe(false);
  });

  it("resolves a mix of Senate (lisId) and House (bioguide) members correctly", () => {
    const result = calculateAverageAges(
      [vote("H1", "", "Yea"), vote("", "S1", "Yea"), vote("H3", "", "Nay"), vote("", "S2", "Nay")],
      index
    );
    expect(result.avgAgeYea).toBe(50); // (30 [H1] + 70 [S1]) / 2
    expect(result.avgAgeNay).toBe(65); // (50 [H3] + 80 [S2]) / 2
    expect(result.countYea).toBe(2);
    expect(result.countNay).toBe(2);
  });
});

describe("formatAge", () => {
  it("formats with one decimal place", () => {
    expect(formatAge(35.666, 4)).toBe("35.7 yrs (4 members)");
  });

  it("returns n/a when count is 0", () => {
    expect(formatAge(0, 0)).toBe("n/a");
  });

  it("uses singular 'member' for a count of 1", () => {
    expect(formatAge(52, 1)).toBe("52.0 yrs (1 member)");
  });

  it("uses plural 'members' for a count greater than 1", () => {
    expect(formatAge(52, 2)).toBe("52.0 yrs (2 members)");
  });
});

describe("buildAgePost", () => {
  const senateVote: AgeVoteResult = {
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
    billTitle: "",
    avgAgeYea: 58.3,
    avgAgeNay: 62.5,
    countYea: 60,
    countNay: 40,
    matched: 100,
    unmatched: 0,
  };

  const houseVote: AgeVoteResult = {
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
    avgAgeYea: 52.7,
    avgAgeNay: 59.1,
    countYea: 218,
    countNay: 200,
    matched: 418,
    unmatched: 0,
  };

  it("builds the exact full post for a representative Senate vote", () => {
    const post = buildAgePost(senateVote);
    expect(post.text).toBe(
      "Senate Vote: On Passage of the Bill\n" +
        "A bill to reauthorize the thing\n" +
        "Result: Passed (60-40)\n\n" +
        "🎂 Average age:\n" +
        "✅ YES: 58.3 yrs (60 members)\n" +
        "❌  NO: 62.5 yrs (40 members)"
    );
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_POST_LENGTH);
  });

  it("builds the exact full post for a representative House vote", () => {
    const post = buildAgePost(houseVote);
    expect(post.text).toBe(
      "House Vote: On Agreeing to the Resolution\n" +
        "Providing for consideration of H.R. 1234\n" +
        "Result: Agreed to (218-200)\n\n" +
        "🎂 Average age:\n" +
        "✅ YES: 52.7 yrs (218 members)\n" +
        "❌  NO: 59.1 yrs (200 members)"
    );
    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_POST_LENGTH);
  });

  it("omits the description line when there is no description", () => {
    const post = buildAgePost({ ...houseVote, description: "" });
    expect(post.text).not.toContain("Providing for consideration");
    expect(post.text.startsWith("House Vote: On Agreeing to the Resolution\nResult: Agreed to (218-200)")).toBe(
      true
    );
    expect(post.facets).toEqual([]);
  });

  it("shortens an over-length description instead of cutting off the Result/age lines", () => {
    const longDescription =
      "Providing for consideration of the bills (H.R. 8800, H.R. 8884, H.R. 7008, " +
      "H.R. 6955, and H.R. 9770); and providing for consideration of the concurrent " +
      "resolution (H. Con. Res. 113)";
    const vote: AgeVoteResult = {
      ...houseVote,
      id: "house-2026-251",
      voteNumber: "251",
      description: longDescription,
      result: "Agreed to",
      yeas: 214,
      nays: 211,
      countYea: 214,
      countNay: 211,
      url: "https://clerk.house.gov/Votes/2026251",
      billUrl: "https://www.congress.gov/bill/119th-congress/house-resolution/113",
    };

    const post = buildAgePost(vote);

    expect(graphemeLength(post.text)).toBeLessThanOrEqual(MAX_POST_LENGTH);
    // The Result and age lines must survive intact, not get sliced.
    expect(post.text).toContain("Result: Agreed to (214-211)");
    expect(post.text).toContain("🎂 Average age:");
    expect(post.text).toContain("✅ YES: 52.7 yrs (214 members)");
    expect(post.text).toContain("❌  NO: 59.1 yrs (211 members)");
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
    const post = buildAgePost(senateVote);
    expect(post.text).not.toContain(senateVote.billUrl); // link is a facet, not visible text
    expect(post.facets).toHaveLength(1);
    expect(post.facets[0].uri).toBe(senateVote.billUrl);
    expect(facetText(post.text, post.facets[0])).toBe("A bill to reauthorize the thing");
  });
});
