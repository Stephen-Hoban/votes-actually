/**
 * disclosureBrackets.ts
 *
 * The one thing the House and Senate financial disclosure formats have in
 * common: neither publishes a dollar figure. The Ethics in Government Act only
 * requires members to report each asset and liability in a *bracket*
 * ("$1,000,001 - $5,000,000"), so every net worth number this project produces
 * is a derived range, never a fact.
 *
 * This module is the shared vocabulary for that: parsing a bracket string into
 * a numeric range, summing ranges, and subtracting liabilities from assets.
 * Both chamber scrapers (disclosureHouse.ts, disclosureSenate.ts) depend on it,
 * and it's pure so it can be unit tested without network access.
 *
 * Methodology decisions baked in here (see BRIEF.md for the reasoning):
 *   - An open-ended top bracket ("Over $50,000,000") is treated as the point
 *     value one dollar above the threshold ($50,000,001). It is the *low* end
 *     of what the member could be worth, so every figure derived from it is a
 *     floor, not an estimate of the middle.
 *   - Ranges are kept as low/high pairs all the way through. Collapsing to a
 *     midpoint happens once, at the very end, in netWorthCalculations.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An inclusive dollar range. `low === high` for an exact or point-collapsed value. */
export interface Bracket {
  low: number;
  high: number;
}

/** The additive identity — summing no brackets yields a zero range. */
export const ZERO_BRACKET: Bracket = { low: 0, high: 0 };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * "$226,776.00" → 226776.
 *
 * Cents are accepted and rounded away. Exact figures with a decimal are how
 * House Schedule D renders a precisely-known liability (a mortgage payoff
 * amount, say) rather than a bracket, and rejecting them silently dropped real
 * six-figure debts — one filer lost eight rows totalling ~$3.67M before this
 * was fixed. Whole dollars are all this project ever reports, so the fraction
 * is discarded rather than carried.
 */
function parseDollars(text: string): number | null {
  const digits = text.replace(/[$,\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(digits)) return null;
  return Math.round(Number(digits));
}

/**
 * Parses a disclosure bracket string into a numeric range.
 *
 * Handles every form the two chambers actually emit:
 *   "$1,000,001 - $5,000,000"  → { low: 1000001, high: 5000000 }
 *   "$1,000,001 – $5,000,000"  → same (Senate HTML uses an en dash)
 *   "Over $50,000,000"         → { low: 50000001, high: 50000001 }
 *   "$50,000,001 -"            → same (House PDFs render the open top bracket
 *                                this way when the upper cell is blank)
 *   "None" / "" / "$0"         → { low: 0, high: 0 }
 *
 * Returns null for anything unrecognized, so callers can count and report
 * unparsed rows instead of silently treating them as zero — an asset that
 * quietly becomes $0 is exactly the kind of invisible error this project's
 * test suite exists to prevent.
 */
export function parseBracket(raw: string): Bracket | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { ...ZERO_BRACKET };

  // Explicit "nothing here" values used by both chambers.
  //
  // A bare dash is included because the Senate renders parent/grouping rows
  // (a holding company or trust whose components are itemized beneath it) with
  // "--" in the value column. That is structural, not a missing value: the
  // worth lives in the child rows, so counting the parent as zero is what
  // avoids double-counting it.
  if (/^(none|n\/a|undetermined|\$0|-{1,2}|–|—)$/i.test(text)) return { ...ZERO_BRACKET };

  // "Less than $1,001" — the Senate's floor category, which it writes as
  // "None (or less than $1,001)". Every mutual fund and ETF holding below the
  // reporting threshold uses it, so it is extremely common. Treated as the
  // real range it describes rather than collapsed to zero: with hundreds of
  // such rows on a single filing, rounding each one down is a systematic
  // understatement, not a rounding error.
  const lessThan = text.match(/^(?:none\s*\(or\s*)?less than\s+(\$[\d,]+(?:\.\d+)?)\)?$/i);
  if (lessThan) {
    const ceiling = parseDollars(lessThan[1]);
    if (ceiling === null) return null;
    return { low: 0, high: Math.max(0, ceiling - 1) };
  }

  // Open-ended top bracket: "Over $50,000,000", "$50,000,000+", "More than $1,000,000".
  const openEnded = text.match(/^(?:over|more than|greater than)\s+(\$[\d,]+(?:\.\d+)?)$/i)
    ?? text.match(/^(\$[\d,]+(?:\.\d+)?)\s*\+$/);
  if (openEnded) {
    const threshold = parseDollars(openEnded[1]);
    if (threshold === null) return null;
    // One dollar above the threshold: the least the member could be worth.
    return { low: threshold + 1, high: threshold + 1 };
  }

  // Normal two-sided bracket. Accepts hyphen, en dash, em dash, or "to".
  const twoSided = text.match(/^(\$[\d,]+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\$[\d,]+(?:\.\d+)?)$/i);
  if (twoSided) {
    const low = parseDollars(twoSided[1]);
    const high = parseDollars(twoSided[2]);
    if (low === null || high === null) return null;
    // Guard against a transposed range rather than trusting column order.
    return low <= high ? { low, high } : { low: high, high: low };
  }

  // Trailing-dash form: the House PDF's open top bracket with an empty upper cell.
  const trailingDash = text.match(/^(\$[\d,]+(?:\.\d+)?)\s*(?:-|–|—)$/);
  if (trailingDash) {
    const low = parseDollars(trailingDash[1]);
    if (low === null) return null;
    return { low, high: low };
  }

  // A bare single value, e.g. a liability reported as an exact figure.
  const single = parseDollars(text);
  if (single !== null) return { low: single, high: single };

  return null;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** Adds ranges: lows with lows, highs with highs. */
export function sumBrackets(brackets: Bracket[]): Bracket {
  let low = 0;
  let high = 0;
  for (const b of brackets) {
    low += b.low;
    high += b.high;
  }
  return { low, high };
}

/**
 * Net worth range from disclosed assets and liabilities.
 *
 * The bounds cross over: the *lowest* a member could be worth is their smallest
 * possible assets minus their largest possible debts, and vice versa. Pairing
 * low-with-low would understate the width of the range and make the estimate
 * look more precise than the source data supports.
 */
export function netWorthRange(assets: Bracket, liabilities: Bracket): Bracket {
  return {
    low: assets.low - liabilities.high,
    high: assets.high - liabilities.low,
  };
}
