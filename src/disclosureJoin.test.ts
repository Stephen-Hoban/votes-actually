import { describe, it, expect } from "vitest";
import {
  normalizeNamePart,
  normalizeSurname,
  surnameKey,
  firstNameToken,
  splitRosterName,
  surnamesAgree,
  joinDisclosures,
  type RosterMember,
} from "./disclosureJoin.js";
import type { RawDisclosure } from "./disclosureTypes.js";
import { ZERO_BRACKET } from "./disclosureBrackets.js";

function makeRoster(overrides: Partial<RosterMember>): RosterMember {
  return {
    bioguide: "X000001",
    lisId: "",
    name: "Test Member",
    state: "NC",
    district: "01",
    party: "Democrat",
    chamber: "House",
    ...overrides,
  };
}

function makeDisclosure(overrides: Partial<RawDisclosure>): RawDisclosure {
  return {
    chamber: "House",
    last: "Member",
    first: "Test",
    suffix: "",
    state: "NC",
    district: "01",
    reportYear: 2025,
    filedDate: "2026-05-15",
    sourceUrl: "https://example.gov/filing",
    assets: { low: 1_000_000, high: 5_000_000 },
    liabilities: { ...ZERO_BRACKET },
    unparsedRows: 0,
    ...overrides,
  };
}

describe("normalizeNamePart", () => {
  it("folds accents so the two sources' spellings agree", () => {
    // congress-legislators writes "Velázquez"; the House index writes "Velazquez".
    expect(normalizeNamePart("Velázquez")).toBe("velazquez");
  });

  it("drops apostrophes", () => {
    expect(normalizeNamePart("O'Halleran")).toBe("ohalleran");
  });

  it("turns hyphens into spaces so compound names tokenize consistently", () => {
    expect(normalizeNamePart("Garcia-Perez")).toBe("garcia perez");
  });

  it("strips generational suffixes", () => {
    expect(normalizeNamePart("Connolly Jr.")).toBe("connolly");
    expect(normalizeNamePart("Rogers III")).toBe("rogers");
  });

  it("strips honorifics the House index puts in its Prefix field", () => {
    expect(normalizeNamePart("Hon. Nancy Pelosi")).toBe("nancy pelosi");
  });

  it("collapses repeated whitespace", () => {
    expect(normalizeNamePart("  Nancy   Pelosi  ")).toBe("nancy pelosi");
  });

  it("returns an empty string for an empty input", () => {
    expect(normalizeNamePart("")).toBe("");
  });
});

describe("surnameKey", () => {
  it("uses the final token of a compound surname", () => {
    // The roster says "Wasserman Schultz"; a filing may say only "Schultz".
    expect(surnameKey("Wasserman Schultz")).toBe("schultz");
  });

  it("is unchanged for a simple surname", () => {
    expect(surnameKey("Pelosi")).toBe("pelosi");
  });

  it("handles a particle surname", () => {
    expect(surnameKey("Van Hollen")).toBe("hollen");
  });

  it("returns an empty string for an empty surname", () => {
    expect(surnameKey("")).toBe("");
  });
});

describe("firstNameToken", () => {
  it("takes only the first token so middle names can't cause a mismatch", () => {
    expect(firstNameToken("Nancy Patricia")).toBe("nancy");
    expect(firstNameToken("Nancy P.")).toBe("nancy");
  });

  it("returns an empty string when there is no given name", () => {
    expect(firstNameToken("")).toBe("");
  });
});

describe("splitRosterName", () => {
  it("splits a plain two-part name", () => {
    expect(splitRosterName("Nancy Pelosi")).toEqual({ first: "nancy", last: "pelosi" });
  });

  it("treats the last token as the surname when a middle initial is present", () => {
    expect(splitRosterName("Nydia M. Velázquez")).toEqual({ first: "nydia", last: "velazquez" });
  });

  it("handles a single-token name", () => {
    expect(splitRosterName("Cher")).toEqual({ first: "", last: "cher" });
  });

  it("handles an empty name", () => {
    expect(splitRosterName("")).toEqual({ first: "", last: "" });
  });
});

describe("surnamesAgree", () => {
  it("matches identical surnames", () => {
    expect(surnamesAgree("Pelosi", "Pelosi")).toBe(true);
  });

  it("matches across accent differences", () => {
    expect(surnamesAgree("Velázquez", "Velazquez")).toBe(true);
  });

  it("matches a compound surname against its truncated form", () => {
    expect(surnamesAgree("Wasserman Schultz", "Schultz")).toBe(true);
  });

  it("does not match two different surnames", () => {
    expect(surnamesAgree("Pelosi", "Schumer")).toBe(false);
  });

  it("does not treat a one-character typo as a match", () => {
    // Deliberately strict: near-misses are not evidence of identity, and a
    // false positive here posts one member's wealth under another's vote.
    expect(surnamesAgree("Miller", "Milller")).toBe(false);
  });

  it("does not match when either side is empty", () => {
    expect(surnamesAgree("", "Pelosi")).toBe(false);
    expect(surnamesAgree("Pelosi", "")).toBe(false);
  });
});

describe("joinDisclosures — House", () => {
  const pelosi = makeRoster({
    bioguide: "P000197",
    name: "Nancy Pelosi",
    state: "CA",
    district: "11",
  });

  it("matches a House filing by state and district", () => {
    const d = makeDisclosure({ last: "Pelosi", first: "Nancy", state: "CA", district: "11" });
    const result = joinDisclosures([d], [pelosi]);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].member.bioguide).toBe("P000197");
    expect(result.unmatched).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("matches an at-large district recorded as 00", () => {
    const atLarge = makeRoster({ bioguide: "A000001", name: "Mary Peltola", state: "AK", district: "00" });
    const d = makeDisclosure({ last: "Peltola", first: "Mary", state: "AK", district: "00" });

    expect(joinDisclosures([d], [atLarge]).matched).toHaveLength(1);
  });

  it("tolerates an unpadded district number from the filing index", () => {
    const d = makeDisclosure({ last: "Peltola", first: "Mary", state: "AK", district: "0" });
    const atLarge = makeRoster({ bioguide: "A000001", name: "Mary Peltola", state: "AK", district: "00" });

    expect(joinDisclosures([d], [atLarge]).matched).toHaveLength(1);
  });

  it("rejects a filing whose surname disagrees with the seat's current occupant", () => {
    // A special election happened: this is the former member's disclosure.
    const d = makeDisclosure({ last: "Predecessor", first: "Former", state: "CA", district: "11" });
    const result = joinDisclosures([d], [pelosi]);

    expect(result.matched).toEqual([]);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0].reason).toContain("now held by Nancy Pelosi");
    expect(result.missing).toEqual([pelosi]);
  });

  it("reports a filing for a district nobody currently holds", () => {
    const d = makeDisclosure({ last: "Ghost", first: "Vacant", state: "WY", district: "01" });
    const result = joinDisclosures([d], [pelosi]);

    expect(result.matched).toEqual([]);
    expect(result.unmatched[0].reason).toContain("no sitting member for WY-01");
  });

  it("lists sitting members with no filing at all as missing", () => {
    const other = makeRoster({ bioguide: "Z000999", name: "No Filing", state: "TX", district: "07" });
    const d = makeDisclosure({ last: "Pelosi", first: "Nancy", state: "CA", district: "11" });

    const result = joinDisclosures([d], [pelosi, other]);
    expect(result.missing.map((m) => m.bioguide)).toEqual(["Z000999"]);
  });

  it("keeps only the first filing when the same member appears twice", () => {
    const first = makeDisclosure({ last: "Pelosi", first: "Nancy", state: "CA", district: "11", sourceUrl: "a" });
    const second = makeDisclosure({ last: "Pelosi", first: "Nancy", state: "CA", district: "11", sourceUrl: "b" });

    const result = joinDisclosures([first, second], [pelosi]);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].disclosure.sourceUrl).toBe("a");
    expect(result.unmatched[0].reason).toContain("duplicate filing");
  });
});

describe("joinDisclosures — Senate", () => {
  const warner = makeRoster({
    bioguide: "W000805",
    lisId: "S1827",
    name: "Mark R. Warner",
    state: "VA",
    district: "",
    chamber: "Senate",
  });
  const warren = makeRoster({
    bioguide: "W000817",
    lisId: "S1170",
    name: "Elizabeth Warren",
    state: "MA",
    district: "",
    chamber: "Senate",
  });

  function senateDisclosure(overrides: Partial<RawDisclosure>): RawDisclosure {
    return makeDisclosure({ chamber: "Senate", state: "", district: "", ...overrides });
  }

  it("matches a senator by surname when it is unique", () => {
    const d = senateDisclosure({ last: "Warner", first: "Mark" });
    const result = joinDisclosures([d], [warner, warren]);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].member.lisId).toBe("S1827");
  });

  it("matches with no state on the filing, which the Senate search often omits", () => {
    const d = senateDisclosure({ last: "Warren", first: "Elizabeth", state: "" });
    expect(joinDisclosures([d], [warner, warren]).matched[0].member.bioguide).toBe("W000817");
  });

  it("disambiguates two senators sharing a surname by given name", () => {
    const johnsonA = makeRoster({ bioguide: "J000001", name: "Ron Johnson", state: "WI", district: "", chamber: "Senate" });
    const johnsonB = makeRoster({ bioguide: "J000002", name: "Mike Johnson", state: "LA", district: "", chamber: "Senate" });
    const d = senateDisclosure({ last: "Johnson", first: "Ron" });

    const result = joinDisclosures([d], [johnsonA, johnsonB]);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].member.bioguide).toBe("J000001");
  });

  it("falls back to state when the given name does not separate them", () => {
    const smithA = makeRoster({ bioguide: "S000001", name: "Tina Smith", state: "MN", district: "", chamber: "Senate" });
    const smithB = makeRoster({ bioguide: "S000002", name: "Tina Smith", state: "OR", district: "", chamber: "Senate" });
    const d = senateDisclosure({ last: "Smith", first: "Tina", state: "OR" });

    expect(joinDisclosures([d], [smithA, smithB]).matched[0].member.bioguide).toBe("S000002");
  });

  it("refuses to guess when two senators remain indistinguishable", () => {
    // Reporting an ambiguity lowers coverage, which is visible. Guessing
    // would publish one senator's wealth under the other's vote.
    const smithA = makeRoster({ bioguide: "S000001", name: "Tina Smith", state: "MN", district: "", chamber: "Senate" });
    const smithB = makeRoster({ bioguide: "S000002", name: "Tina Smith", state: "OR", district: "", chamber: "Senate" });
    const d = senateDisclosure({ last: "Smith", first: "Tina", state: "" });

    const result = joinDisclosures([d], [smithA, smithB]);
    expect(result.matched).toEqual([]);
    expect(result.unmatched[0].reason).toContain("ambiguous");
  });

  it("matches a compound surname recorded whole in the roster but truncated in the filing", () => {
    const cortez = makeRoster({
      bioguide: "C000001",
      name: "Catherine Cortez Masto",
      state: "NV",
      district: "",
      chamber: "Senate",
    });
    const d = senateDisclosure({ last: "Masto", first: "Catherine" });

    expect(joinDisclosures([d], [cortez]).matched).toHaveLength(1);
  });

  it("reports a filing from a senator who is no longer sitting", () => {
    const d = senateDisclosure({ last: "Departed", first: "Former" });
    const result = joinDisclosures([d], [warner, warren]);

    expect(result.matched).toEqual([]);
    expect(result.unmatched[0].reason).toContain("no sitting senator named Departed");
  });
});

describe("joinDisclosures — both chambers together", () => {
  it("keeps House and Senate matching independent", () => {
    const rep = makeRoster({ bioguide: "H000001", name: "Alice Rep", state: "CA", district: "11" });
    const sen = makeRoster({
      bioguide: "S000001",
      lisId: "S999",
      name: "Alice Rep",
      state: "TX",
      district: "",
      chamber: "Senate",
    });

    // Same name in both chambers — the House filing must resolve by district
    // and the Senate filing by name, with no crossover.
    const houseFiling = makeDisclosure({ last: "Rep", first: "Alice", state: "CA", district: "11" });
    const senateFiling = makeDisclosure({ chamber: "Senate", last: "Rep", first: "Alice", state: "TX", district: "" });

    const result = joinDisclosures([houseFiling, senateFiling], [rep, sen]);
    expect(result.matched).toHaveLength(2);
    expect(result.matched.map((m) => m.member.bioguide).sort()).toEqual(["H000001", "S000001"]);
    expect(result.missing).toEqual([]);
  });
});
