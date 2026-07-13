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
  StatePop,
  DistrictPop,
  MemberDistrict,
  VoteResult,
} from "./voteCalculations.js";

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
  };

  it("builds the full post with description", () => {
    expect(buildPopulationPost(baseVote)).toBe(
      "House Vote: On Passage\n" +
        "To reauthorize the thing\n" +
        "Result: Passed (220-210)\n\n" +
        "🇺🇸 Population represented:\n" +
        "✅ YES: 150.0M (45.3%)\n" +
        "❌  NO: 140.0M (42.3%)"
    );
  });

  it("omits the description line when there is no description", () => {
    const post = buildPopulationPost({ ...baseVote, description: "" });
    expect(post).not.toContain("To reauthorize the thing");
    expect(post.startsWith("House Vote: On Passage\nResult: Passed (220-210)")).toBe(true);
  });
});
