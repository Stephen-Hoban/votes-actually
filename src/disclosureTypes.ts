/**
 * disclosureTypes.ts
 *
 * The contract between the two chamber scrapers (disclosureHouse.ts,
 * disclosureSenate.ts) and the code that joins their output to the vote data.
 *
 * The chambers publish in completely different formats — the House in per-filer
 * PDFs behind an annual ZIP index, the Senate in HTML behind a session/CSRF
 * flow — but both boil down to the same thing: a named person, in a known
 * state (and district, for the House), with a bracketed pile of assets and a
 * bracketed pile of liabilities, for one report year. Everything downstream
 * works off this shape and knows nothing about PDFs or CSRF tokens.
 */

import type { Bracket } from "./disclosureBrackets.js";

/** One member's annual financial disclosure, reduced to summed ranges. */
export interface RawDisclosure {
  chamber: "House" | "Senate";

  /** Family name as filed, e.g. "Pelosi". Used for the name→BioGuide join. */
  last: string;
  /** Given name as filed, e.g. "Nancy". May include a middle initial. */
  first: string;
  /** Generational suffix as filed, e.g. "Jr." — "" when absent. */
  suffix: string;

  /** Two-letter state abbreviation, e.g. "CA". */
  state: string;
  /** Zero-padded district number for House filers, e.g. "11". "" for senators. */
  district: string;

  /** Calendar year the report covers (not the year it was filed). */
  reportYear: number;
  /** Filing date as published, e.g. "2026-05-15". "" when not exposed. */
  filedDate: string;
  /** Canonical URL of the filing this was parsed from — the provenance record. */
  sourceUrl: string;

  /** Summed Schedule A / Part 3 asset ranges. Includes spouse and joint holdings. */
  assets: Bracket;
  /** Summed Schedule D / Part 7 liability ranges. Includes spouse and joint debts. */
  liabilities: Bracket;

  /**
   * Rows whose value cell could not be parsed into a bracket. Non-zero means
   * this filer's totals are incomplete and the caller should say so rather
   * than treat the sum as authoritative.
   */
  unparsedRows: number;
}

/**
 * What a chamber scraper returns: the disclosures it could parse, plus enough
 * bookkeeping for the refresh script to report honestly on what it missed.
 */
export interface DisclosureFetchResult {
  disclosures: RawDisclosure[];
  /** Report year the scraper targeted. */
  reportYear: number;
  /** Filers listed in the index but skipped (no annual report, unreadable filing, fetch failure). */
  skipped: Array<{ name: string; reason: string }>;
}
