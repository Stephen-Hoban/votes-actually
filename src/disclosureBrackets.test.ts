import { describe, it, expect } from "vitest";
import { parseBracket, sumBrackets, netWorthRange, ZERO_BRACKET } from "./disclosureBrackets.js";

describe("parseBracket", () => {
  it("parses the standard two-sided bracket the House PDFs emit", () => {
    expect(parseBracket("$1,000,001 - $5,000,000")).toEqual({ low: 1_000_001, high: 5_000_000 });
  });

  it("parses the smallest bracket in the disclosure schedule", () => {
    expect(parseBracket("$1,001 - $15,000")).toEqual({ low: 1_001, high: 15_000 });
  });

  it("parses an en dash, which the Senate HTML uses instead of a hyphen", () => {
    expect(parseBracket("$15,001 – $50,000")).toEqual({ low: 15_001, high: 50_000 });
  });

  it("parses an em dash", () => {
    expect(parseBracket("$15,001 — $50,000")).toEqual({ low: 15_001, high: 50_000 });
  });

  it("tolerates the line break the House PDF puts inside a bracket", () => {
    // The two halves of a bracket render on separate lines in the PDF and get
    // rejoined with a newline before they reach here.
    expect(parseBracket("$5,000,001 -\n$25,000,000")).toEqual({ low: 5_000_001, high: 25_000_000 });
  });

  it("collapses the open-ended top bracket to one dollar above the threshold", () => {
    // A deliberate methodology choice: "Over $50,000,000" has no midpoint, so
    // it's treated as the floor of what the member could be worth.
    expect(parseBracket("Over $50,000,000")).toEqual({ low: 50_000_001, high: 50_000_001 });
  });

  it("handles the spouse/dependent-child open-ended bracket at a lower threshold", () => {
    expect(parseBracket("Over $1,000,000")).toEqual({ low: 1_000_001, high: 1_000_001 });
  });

  it("handles 'More than' phrasing for the open top bracket", () => {
    expect(parseBracket("More than $50,000,000")).toEqual({ low: 50_000_001, high: 50_000_001 });
  });

  it("handles the trailing-plus form of the open top bracket", () => {
    expect(parseBracket("$50,000,000+")).toEqual({ low: 50_000_001, high: 50_000_001 });
  });

  it("handles the House PDF's trailing-dash form when the upper cell is blank", () => {
    expect(parseBracket("$50,000,001 -")).toEqual({ low: 50_000_001, high: 50_000_001 });
  });

  it("treats an explicit 'None' as zero", () => {
    expect(parseBracket("None")).toEqual(ZERO_BRACKET);
  });

  it("treats an empty cell as zero", () => {
    expect(parseBracket("")).toEqual(ZERO_BRACKET);
    expect(parseBracket("   ")).toEqual(ZERO_BRACKET);
  });

  it("treats $0 as zero", () => {
    expect(parseBracket("$0")).toEqual(ZERO_BRACKET);
  });

  it("parses the Senate's floor category as a real range, not zero", () => {
    // "None (or less than $1,001)" is how the Senate writes every holding
    // below the reporting threshold. Hundreds of rows on one filing use it, so
    // collapsing each to zero would systematically understate the filer.
    expect(parseBracket("None (or less than $1,001)")).toEqual({ low: 0, high: 1_000 });
  });

  it("parses a bare 'Less than' phrasing", () => {
    expect(parseBracket("Less than $1,001")).toEqual({ low: 0, high: 1_000 });
  });

  it("treats a dash as zero — a grouping row whose value lives in its children", () => {
    // Senate parent rows (holding companies, trusts) render "--" in the value
    // column. Counting them as zero is what prevents double-counting.
    expect(parseBracket("--")).toEqual(ZERO_BRACKET);
    expect(parseBracket("—")).toEqual(ZERO_BRACKET);
  });

  it("still returns null for genuinely unreadable value text", () => {
    // "Unascertainable" shows up on pension entries and is a real gap, not a
    // structural zero — it must stay visible in unparsedRows.
    expect(parseBracket("Unascertainable")).toBeNull();
  });

  it("parses a bare exact figure", () => {
    expect(parseBracket("$250,000")).toEqual({ low: 250_000, high: 250_000 });
  });

  it("parses an exact figure written with cents, rounding them away", () => {
    // House Schedule D renders a precisely-known liability this way rather
    // than as a bracket. Rejecting it silently dropped real six-figure debts.
    expect(parseBracket("$226,776.00")).toEqual({ low: 226_776, high: 226_776 });
  });

  it("rounds a fractional amount to whole dollars", () => {
    expect(parseBracket("$1,234.56")).toEqual({ low: 1_235, high: 1_235 });
  });

  it("parses a two-sided bracket whose bounds carry cents", () => {
    expect(parseBracket("$1,000.50 - $5,000.49")).toEqual({ low: 1_001, high: 5_000 });
  });

  it("normalizes surrounding and internal whitespace", () => {
    expect(parseBracket("  $1,000,001   -   $5,000,000  ")).toEqual({
      low: 1_000_001,
      high: 5_000_000,
    });
  });

  it("repairs a transposed range rather than trusting column order", () => {
    expect(parseBracket("$5,000,000 - $1,000,001")).toEqual({ low: 1_000_001, high: 5_000_000 });
  });

  it("returns null for unrecognized text so callers can count it instead of silently zeroing", () => {
    // This is the whole point of the null return: an asset that quietly
    // becomes $0 understates a member's wealth with no visible error.
    expect(parseBracket("See attached schedule")).toBeNull();
    expect(parseBracket("$1,000,001 - TBD")).toBeNull();
  });
});

describe("sumBrackets", () => {
  it("adds lows to lows and highs to highs", () => {
    const total = sumBrackets([
      { low: 1_000_001, high: 5_000_000 },
      { low: 15_001, high: 50_000 },
    ]);
    expect(total).toEqual({ low: 1_015_002, high: 5_050_000 });
  });

  it("returns zero for an empty list", () => {
    expect(sumBrackets([])).toEqual(ZERO_BRACKET);
  });

  it("sums a single bracket to itself", () => {
    expect(sumBrackets([{ low: 100, high: 200 }])).toEqual({ low: 100, high: 200 });
  });
});

describe("netWorthRange", () => {
  it("crosses the bounds: lowest assets minus highest debts, and vice versa", () => {
    // Pairing low-with-low would understate how wide the real uncertainty is.
    const range = netWorthRange({ low: 1_000_000, high: 5_000_000 }, { low: 100_000, high: 250_000 });
    expect(range).toEqual({ low: 750_000, high: 4_900_000 });
  });

  it("returns the assets unchanged when there are no liabilities", () => {
    const range = netWorthRange({ low: 1_000_000, high: 5_000_000 }, ZERO_BRACKET);
    expect(range).toEqual({ low: 1_000_000, high: 5_000_000 });
  });

  it("goes negative when disclosed debts exceed disclosed assets", () => {
    // Common and real — mortgages and student loans against a member who
    // reports few qualifying assets.
    const range = netWorthRange({ low: 15_001, high: 50_000 }, { low: 500_001, high: 1_000_000 });
    expect(range).toEqual({ low: -984_999, high: -450_001 });
  });

  it("can straddle zero when the ranges overlap", () => {
    const range = netWorthRange({ low: 100_000, high: 1_000_000 }, { low: 250_000, high: 500_000 });
    expect(range.low).toBeLessThan(0);
    expect(range.high).toBeGreaterThan(0);
  });
});
