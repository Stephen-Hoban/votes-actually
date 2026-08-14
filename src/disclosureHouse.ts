/**
 * disclosureHouse.ts
 *
 * Scrapes annual financial disclosures for sitting US House members and
 * reduces each filer to summed asset/liability brackets, matching the
 * `RawDisclosure` contract in disclosureTypes.ts (see that file for the shape
 * shared with the Senate scraper, and disclosureBrackets.ts for the
 * bracket-parsing primitives this file builds on rather than reimplements).
 *
 * The access flow (no API key, no account — verified working 2026-08-11)
 * ------------------------------------------------------------------------
 *   1. GET  https://disclosures-clerk.house.gov/public_disc/financial-pdfs/
 *           {reportYear}FD.zip
 *      → a ZIP containing {reportYear}FD.xml, one <Member> element per filing
 *        made that report year (every filer, every filing type — candidates,
 *        extensions, PTRs, terminations, the lot). `<Year>` is the REPORT
 *        year; `FilingDate` is typically the following May.
 *   2. GET  https://disclosures-clerk.house.gov/public_disc/financial-pdfs/
 *           {reportYear}/{DocID}.pdf
 *      → the individual filing, real extractable text (not a scanned image).
 *
 * No dependency was added for either step: the ZIP is unpacked with a small
 * hand-rolled central-directory reader + Node's built-in `zlib.inflateRawSync`
 * (confirmed empirically the entries are plain DEFLATE, method 8, not
 * Zip64), and the PDF is read with `pdfjs-dist`, already a project
 * dependency.
 *
 * Which filings to use
 * ---------------------
 * Only `FilingType` `O` (annual original) and `A` (amendment) carry a real
 * holdings picture — `C` (candidate), `X` (extension), `P` (periodic
 * transaction report — individual trades, not a holdings snapshot), `D`,
 * `T`, `W`, `G`, `E`, `H`, `B` are all excluded. When a filer has more than
 * one O/A in a report year, only the one with the latest `FilingDate` is
 * kept (an amendment supersedes the original; it does not add to it) — keyed
 * on Last|First|StateDst since that's all the index exposes.
 *
 * This module does its own name/state/district bookkeeping only as far as
 * splitting `StateDst` ("CA11" → state "CA", district "11"); the actual
 * name→BioGuide join lives in disclosureJoin.ts and is out of scope here.
 *
 * PDF layout — the part that actually took the empirical work
 * -------------------------------------------------------------
 * Every Schedule A row carries TWO dollar ranges side by side — the asset's
 * "Value of Asset" and the "Income" it produced — plus Schedule B
 * (transactions), C (earned income), D (liabilities) and others also use
 * "$X - $Y"-shaped text. A flat text dump can't tell any of these apart, so
 * this module reads `pdf.js` text items *with position* (`item.transform[4]`
 * = x, `[5]` = y) and does two things a flat dump can't:
 *
 *   1. Section scoping. The mangled small-caps section headings ("SCHEDULE
 *      A: ASSETS...") extract with literal NUL bytes standing in for the
 *      small-caps glyphs — e.g. "S\0\0\0\0\0\0\0 A: A\0\0\0\0\0 ..." for
 *      "Schedule A: Assets...". Verified empirically (Pelosi 2025, Amata
 *      2025) that after stripping NULs, EVERY schedule heading A through I
 *      reduces cleanly to `^S\s*[A-Z]\s*:` with the schedule letter as the
 *      only capital before the colon, and nothing else in either filing ever
 *      matches that shape (checked against "Status:", "Filing Type:", and
 *      the "D: <description>" notes that appear *inside* Schedule A rows,
 *      none of which collide). That single regex is used to track which
 *      schedule is currently active; only 'A' and 'D' accumulate anything.
 *
 *   2. Column assignment by position, not order. On every page the header
 *      row repeats (e.g. "Value of Asset" at one x, "Income" at another),
 *      and those x's are re-read per page and per document rather than
 *      hardcoded — two real filings sampled while building this had
 *      "Value of Asset" at x=280.3 and x=284.8 respectively, a small but
 *      real per-document drift. The header is located by its distinctive,
 *      collision-free label text ("Value of Asset" for Schedule A;
 *      "Creditor" paired with "Amount of" for Schedule D — plain "Income" by
 *      itself is NOT distinctive, since a wrapped "Partnership Income"
 *      Income-Type cell also renders a bare "Income" line at a different x;
 *      guarding on same-row y before trusting it as the header avoids that
 *      trap). A data cell counts toward a column only if it's within
 *      `COLUMN_TOLERANCE` points of that column's x — small enough that
 *      neighboring columns (e.g. "Owner" only ~39pt from "Value of Asset")
 *      never bleed in, per the 280/445 defaults noted in the constants
 *      below as the documented House-PDF fallback if a page's own header
 *      can't be found.
 *
 *   3. Rejoining split brackets. A single bracket is very often split across
 *      two lines at the same x — "$5,000,001 -" then "$25,000,000" on the
 *      next line, 10.5pt below (confirmed: every real inter-entry gap
 *      observed was 21pt or more, so a 15pt merge threshold cleanly tells
 *      "next line of the same cell" from "next row"). Handing the dangling
 *      first line to `parseBracket` alone would silently produce a WRONG
 *      point value via its documented open-ended-bracket rule (that rule
 *      exists for genuine "$50,000,001 -" opens with nothing following, not
 *      for wrapped text) — so a line ending in a dash is only accepted
 *      standalone if the very next item in that column, on the same page,
 *      within 15pt, is NOT a bare "$digits" continuation.
 *
 * Any value cell that survives merging but still doesn't parse increments
 * `unparsedRows` for that filer rather than being silently treated as zero.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";
import * as zlib from "zlib";

import type { Bracket } from "./disclosureBrackets.js";
import { parseBracket, sumBrackets, ZERO_BRACKET } from "./disclosureBrackets.js";
import type { DisclosureFetchResult, RawDisclosure } from "./disclosureTypes.js";

const USER_AGENT = "votes-actually (educational project)";
const CLERK_BASE = "https://disclosures-clerk.house.gov/public_disc/financial-pdfs";

/** How many PDFs to fetch/parse in parallel. ~440 filings, one government server. */
const CONCURRENCY = 6;
/** Extra attempts after the first for a single fetch (ZIP or PDF). */
const MAX_RETRIES = 2;
/** Base backoff between retries, doubled each attempt. */
const RETRY_BACKOFF_MS = 750;
/** Log a progress line every this many filers processed. */
const PROGRESS_INTERVAL = 50;

/**
 * Column-match tolerance in PDF points. Generous enough to absorb the small
 * per-document x drift observed empirically (~4.5pt between two real
 * filings), nowhere near enough to reach a neighboring column (the closest
 * neighbor, "Owner", sits ~39pt from "Value of Asset").
 */
const COLUMN_TOLERANCE = 20;

/**
 * Fallback column x-coordinates, used only if a page's own header row can't
 * be located (see file header). 280/445 are the values the task brief
 * documented for the asset-value/income columns; 495 for the liability
 * column is this module's own empirical observation (both sample filings'
 * "Amount of [Liability]" header landed at x≈495.5) — there was no brief
 * value to fall back to, so it's noted here rather than hardcoded silently.
 */
const DEFAULT_ASSET_VALUE_X = 280;
const DEFAULT_INCOME_X = 445;
const DEFAULT_LIABILITY_X = 495;

/** Max y-gap (PDF points) between two same-column items to treat them as one wrapped cell. */
const MERGE_Y_GAP_MAX = 15;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn` with limited concurrency, preserving input order in the output. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Fetches a URL as a Buffer, retrying transient failures with backoff. */
async function fetchBufferWithRetry(url: string): Promise<Buffer> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const arrayBuffer = await resp.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** "5/15/2026" → epoch ms, for "which filing is latest" comparisons. Returns 0 if unparseable. */
function usDateToComparable(mdyyyy: string): number {
  const m = mdyyyy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  const [, mm, dd, yyyy] = m;
  return Date.parse(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T00:00:00Z`) || 0;
}

/** "5/15/2026" → "2026-05-15". Returns "" if the input isn't that shape. */
function usDateToIso(mdyyyy: string): string {
  const m = mdyyyy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// ZIP: minimal central-directory reader (no dependency added for this)
// ---------------------------------------------------------------------------

/**
 * Extracts one entry from a non-Zip64 ZIP archive by exact filename.
 * Supports the two compression methods any tool actually emits for a small
 * text-file archive like this one: 0 (stored) and 8 (deflate). Confirmed via
 * `python3 -c "import zipfile; ..."` against a real {reportYear}FD.zip that
 * both entries use method 8.
 */
function extractZipEntry(buf: Buffer, fileName: string): Buffer {
  const EOCD_SIG = 0x06054b50;
  const minSearch = Math.max(0, buf.length - 22 - 65536);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minSearch; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error("Not a valid ZIP file: End Of Central Directory record not found.");
  }

  const cdEntryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const CD_SIG = 0x02014b50;
  let ptr = cdOffset;
  for (let i = 0; i < cdEntryCount; i++) {
    if (buf.readUInt32LE(ptr) !== CD_SIG) {
      throw new Error(`Malformed ZIP central directory entry at offset ${ptr}.`);
    }
    const compressionMethod = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf-8", ptr + 46, ptr + 46 + nameLen);

    if (name === fileName) {
      const LFH_SIG = 0x04034b50;
      if (buf.readUInt32LE(localHeaderOffset) !== LFH_SIG) {
        throw new Error(`Malformed ZIP local file header for ${fileName}.`);
      }
      const lfNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lfExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lfNameLen + lfExtraLen;
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) return Buffer.from(compressed);
      if (compressionMethod === 8) return zlib.inflateRawSync(compressed);
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${fileName}.`);
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error(`Entry "${fileName}" not found in ZIP archive.`);
}

// ---------------------------------------------------------------------------
// Index XML: which filers exist, and which one filing per filer to fetch
// ---------------------------------------------------------------------------

interface IndexFiler {
  last: string;
  first: string;
  suffix: string;
  filingType: string;
  stateDst: string;
  filingDate: string; // as filed, e.g. "5/15/2026"
  docId: string;
}

/** Hand-rolled rather than xml2js: the index is ~2700 identically-shaped flat
 * `<Member>` records with no attributes or nesting, so a simple per-tag
 * regex extraction is both simpler and faster than building the full xml2js
 * object graph for a file this repetitive and this size. */
function parseIndexXml(xml: string): IndexFiler[] {
  const filers: IndexFiler[] = [];
  const memberRe = /<Member>([\s\S]*?)<\/Member>/g;

  const field = (block: string, tag: string): string => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block);
    return m ? m[1].trim() : "";
  };

  let match: RegExpExecArray | null;
  while ((match = memberRe.exec(xml)) !== null) {
    const block = match[1];
    filers.push({
      last: field(block, "Last"),
      first: field(block, "First"),
      suffix: field(block, "Suffix"),
      filingType: field(block, "FilingType"),
      stateDst: field(block, "StateDst"),
      filingDate: field(block, "FilingDate"),
      docId: field(block, "DocID"),
    });
  }
  return filers;
}

/**
 * Keeps only annual originals (O) and amendments (A), and within those keeps
 * a single filing per filer — the one with the latest FilingDate — keyed on
 * Last|First|StateDst, the only identity the index exposes. An amendment
 * supersedes the original; it does not add to it.
 */
function chooseLatestPerFiler(filers: IndexFiler[]): IndexFiler[] {
  const relevant = filers.filter((f) => f.filingType === "O" || f.filingType === "A");

  const groups = new Map<string, IndexFiler[]>();
  for (const f of relevant) {
    const key = `${f.last.toUpperCase()}|${f.first.toUpperCase()}|${f.stateDst.toUpperCase()}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  }

  const chosen: IndexFiler[] = [];
  for (const bucket of groups.values()) {
    chosen.push(
      bucket.reduce((best, f) => (usDateToComparable(f.filingDate) > usDateToComparable(best.filingDate) ? f : best))
    );
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// PDF: positioned text extraction
// ---------------------------------------------------------------------------

interface PosItem {
  /** x-coordinate in PDF points; item.transform[4]. */
  x: number;
  /** y-coordinate in PDF points; item.transform[5]. */
  y: number;
  /** 1-based page number, for the "don't merge across a page break" guard. */
  page: number;
  /** Raw extracted string — may contain literal NUL bytes for small-caps glyphs. */
  text: string;
}

function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
  return "str" in item;
}

/** Reads every non-blank text item in a PDF, with position, in document order. */
async function extractPositionedItems(pdfBytes: Uint8Array): Promise<PosItem[]> {
  const doc = await getDocument({ data: pdfBytes, verbosity: 0 }).promise;
  const items: PosItem[] = [];

  try {
    for (let page = 1; page <= doc.numPages; page++) {
      const pdfPage = await doc.getPage(page);
      const content = await pdfPage.getTextContent();
      for (const raw of content.items) {
        if (!isTextItem(raw)) continue;
        if (raw.str.trim() === "") continue;
        items.push({ x: raw.transform[4], y: raw.transform[5], page, text: raw.str });
      }
    }
  } finally {
    await doc.destroy();
  }

  return items;
}

// ---------------------------------------------------------------------------
// PDF: section scoping + column assignment
// ---------------------------------------------------------------------------

/** Matches a mangled schedule heading after NUL-stripping, e.g. "S A: A..." → "A". */
const HEADING_RE = /^S\s*([A-Z])\s*:/;

/**
 * Header/label text that must never be treated as a data cell, beyond the
 * "Value of Asset" / "Income" / "Creditor" / "Amount of" / "Liability"
 * labels already handled specially above (those also update column x's).
 * Needed because a page's OWN header row can transiently sit within
 * COLUMN_TOLERANCE of a *stale* column x — e.g. confirmed on Adams 2025,
 * whose "Owner" header lands at x=281.8, just 1.8pt from the still-default
 * assetValueX=280 at the moment "Owner" is read (it appears in the stream
 * BEFORE "Value of Asset" on the same row, which is what corrects
 * assetValueX to this page's real x=320.8). Skipping every known label
 * string outright is more robust than reordering the single forward pass.
 */
const NON_DATA_LABELS = new Set(["Asset", "Owner", "Income Type(s)", "Tx. >", "$1,000?", "Date Incurred", "Type", "Source"]);

/**
 * True for text that could plausibly be part of a bracket value cell: a
 * dollar amount (whole or a wrapped fragment of one), a "None"/"N/A"/
 * "Undetermined" no-value marker, or an owner-code-like prefix ending in
 * "Over" (see mergeSplitCells / normalizeHouseValueText for why that last
 * one is real, not noise). Column-x proximity alone isn't a reliable enough
 * gate — confirmed empirically that the page footer ("Filing ID #...") and
 * the asset-type-codes footnote URL both land within COLUMN_TOLERANCE of a
 * real value column on at least one sampled filing each.
 */
function looksLikeValueFragment(s: string): boolean {
  if (s.startsWith("$")) return true;
  if (/^(none|n\/a|undetermined)$/i.test(s)) return true;
  if (/\bover\s*$/i.test(s)) return true;
  return false;
}

interface ColumnCell {
  text: string;
  y: number;
  page: number;
}

/**
 * Walks a filing's positioned text once, tracking which schedule is active
 * and which column each dollar-bearing cell in Schedule A / Schedule D
 * belongs to. Returns the raw (unmerged, unparsed) cell text for each of the
 * two columns this project cares about — merging split brackets and calling
 * parseBracket happens afterward, in `sumColumn`.
 */
function collectScheduleCells(items: PosItem[]): { assetCells: ColumnCell[]; liabilityCells: ColumnCell[] } {
  let section = "";
  let assetValueX = DEFAULT_ASSET_VALUE_X;
  let incomeX = DEFAULT_INCOME_X;
  let liabilityX = DEFAULT_LIABILITY_X;

  // Tracks the y of the most recently seen "Value of Asset" / "Creditor"
  // header label, so a same-row "Income" / "Amount of" can be confirmed as
  // its paired column header rather than mistaken for row data that happens
  // to share the label's text (see file header: a wrapped "Partnership
  // Income" Income-Type cell also renders a bare "Income" line).
  let pendingAssetHeaderY: number | null = null;
  let pendingCreditorHeaderY: number | null = null;

  const assetCells: ColumnCell[] = [];
  const liabilityCells: ColumnCell[] = [];

  for (const item of items) {
    const clean = item.text.replace(/\0/g, "").trim();
    if (clean === "") continue;

    const heading = clean.match(HEADING_RE);
    if (heading) {
      section = heading[1];
      continue;
    }

    if (NON_DATA_LABELS.has(clean)) continue;

    if (clean === "Value of Asset") {
      assetValueX = item.x;
      pendingAssetHeaderY = item.y;
      continue;
    }
    if (clean === "Income" && pendingAssetHeaderY !== null && Math.abs(item.y - pendingAssetHeaderY) < 1) {
      incomeX = item.x;
      continue;
    }
    if (clean === "Creditor") {
      pendingCreditorHeaderY = item.y;
      continue;
    }
    if (clean === "Amount of" && pendingCreditorHeaderY !== null && Math.abs(item.y - pendingCreditorHeaderY) < 1) {
      liabilityX = item.x;
      continue;
    }
    // The second line of Schedule D's wrapped "Amount of" / "Liability"
    // header. Its x coincides with the liability column, so without this
    // exclusion it would be miscounted as an unparseable data cell.
    if (clean === "Liability") continue;

    // Page furniture — the "* For the complete list... " footnote URL and
    // the per-page "Filing ID #..." stamp — both land, on at least one
    // sampled filing each (Amodei 2025, Balderson 2025), within
    // COLUMN_TOLERANCE of that document's real asset-value/liability x.
    // Gating on column x alone isn't enough; a cell must also *look* like a
    // value fragment to be considered data. This also covers the
    // "Spouse/DC Over" style continuation prefix (no leading "$", but ends
    // in "Over" — see mergeSplitCells) without needing every stray string
    // enumerated by hand.
    if (!looksLikeValueFragment(clean)) continue;

    if (section === "A") {
      const distAsset = Math.abs(item.x - assetValueX);
      const distIncome = Math.abs(item.x - incomeX);
      if (distAsset <= COLUMN_TOLERANCE && distAsset <= distIncome) {
        assetCells.push({ text: clean, y: item.y, page: item.page });
      }
      // distIncome nearest: deliberately discarded — this is the whole
      // point of scoping by column instead of by order.
    } else if (section === "D") {
      const distLiability = Math.abs(item.x - liabilityX);
      if (distLiability <= COLUMN_TOLERANCE) {
        liabilityCells.push({ text: clean, y: item.y, page: item.page });
      }
    }
  }

  return { assetCells, liabilityCells };
}

/**
 * Rejoins a bracket split across two lines at the same column x — e.g.
 * "$5,000,001 -" then "$25,000,000" 10.5pt below it — before any of it
 * reaches `parseBracket`. See file header for why this is necessary: the
 * unmerged first line alone parses "successfully" but silently wrong, via
 * parseBracket's (correct, for genuinely open-ended values) trailing-dash
 * rule.
 *
 * The split also happens across a PAGE break, not just a line break —
 * confirmed empirically on Pelosi 2025's Schedule D, where a Heritage Bank
 * liability's "$250,001 -" is the last line of page 9 and "$500,000" is the
 * first line of page 10, nowhere near 15pt apart in y (y resets per page).
 * Since `sorted` is ordered by (page, y desc), two adjacent array entries on
 * different pages are, by construction, the last matching cell on the
 * earlier page and the first matching cell on the next — nothing else in
 * this column comes between them — so a page change alone (no y-gap check,
 * which wouldn't even be meaningful across pages) is treated as the same
 * cluster.
 *
 * A trailing dash isn't the only continuation marker: the "Spouse/DC Over"
 * style prefix (see `normalizeHouseValueText`) ends in the word "Over"
 * instead, with the dollar amount itself wrapped to the next line — same
 * two-line split, different trailing token.
 */
function mergeSplitCells(cells: ColumnCell[]): string[] {
  const sorted = [...cells].sort((a, b) => a.page - b.page || b.y - a.y);
  const merged: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const isContinuationPrefix = /[-–—]\s*$/.test(cur.text) || /\bover\s*$/i.test(cur.text);
    const next = sorted[i + 1];

    if (isContinuationPrefix && next) {
      const gap = cur.y - next.y;
      const sameCluster = next.page === cur.page ? gap > 0 && gap <= MERGE_Y_GAP_MAX : next.page > cur.page;
      const nextIsBareContinuation = /^\$[\d,]+$/.test(next.text);
      if (sameCluster && nextIsBareContinuation) {
        merged.push(`${cur.text} ${next.text}`);
        i++; // consume the continuation line
        continue;
      }
    }

    merged.push(cur.text);
  }

  return merged;
}

/**
 * Normalizes one House-PDF-specific value phrasing that disclosureBrackets.ts
 * deliberately doesn't know about, since it's specific to how this chamber's
 * PDF renders certain rows, not a general bracket grammar (mirrors
 * disclosureSenate.ts's own normalizeSenateValueText for the same reason).
 * Restricted-stock / employee-benefit rows can render their Value-of-Asset
 * cell with an owner-code-like prefix glued onto an otherwise-standard
 * open-ended bracket — confirmed empirically on Auchincloss 2025 (State
 * Street restricted stock): "Spouse/DC Over $1,000,000". Reducing to the
 * trailing "Over $N" hands parseBracket the canonical form it already
 * understands.
 */
function normalizeHouseValueText(raw: string): string {
  const overSuffix = raw.match(/(over\s+\$[\d,]+)\s*$/i);
  return overSuffix ? overSuffix[1] : raw;
}

/**
 * Merges, parses, and sums one column's cells; collects anything that still
 * won't parse.
 *
 * The offending text is returned, not just a count. A bare tally ("1 unparsed
 * row") appears on almost every filing and is impossible to act on — it could
 * equally be a harmless header artifact or a real six-figure asset being
 * dropped, and those need very different responses. Carrying the text up to
 * the log line makes the distinction obvious at a glance.
 */
function sumColumn(cells: ColumnCell[]): { bracket: Bracket; unparsedRows: number; unparsedTexts: string[] } {
  const brackets: Bracket[] = [];
  const unparsedTexts: string[] = [];

  for (const text of mergeSplitCells(cells)) {
    const bracket = parseBracket(normalizeHouseValueText(text));
    if (bracket === null) {
      unparsedTexts.push(text);
      continue;
    }
    brackets.push(bracket);
  }

  const unparsedRows = unparsedTexts.length;

  return { bracket: brackets.length > 0 ? sumBrackets(brackets) : { ...ZERO_BRACKET }, unparsedRows, unparsedTexts };
}

/** Parses one filing PDF into summed Schedule A assets and Schedule D liabilities. */
async function parseFilingPdf(
  pdfBytes: Uint8Array
): Promise<{ assets: Bracket; liabilities: Bracket; unparsedRows: number; unparsedTexts: string[] }> {
  const items = await extractPositionedItems(pdfBytes);

  // A filing with no extractable text at all is a SCANNED filing — some
  // members still submit on paper, and the Clerk publishes the scan as-is
  // (these carry a distinctive older DocID range, e.g. 9116162). There is
  // nothing to parse, and reporting $0 would be a lie that quietly drags every
  // average this bot publishes downward: 33 such filings were being counted as
  // genuinely-broke members before this check existed.
  //
  // Note this is NOT the same as a member who really disclosed nothing. Those
  // filings have text — the schedules read "None disclosed." — and correctly
  // sum to zero. The distinction is text vs. no text, not zero vs. non-zero.
  if (items.length === 0) {
    throw new Error("no extractable text — scanned/paper filing, cannot be parsed");
  }

  const { assetCells, liabilityCells } = collectScheduleCells(items);

  const assets = sumColumn(assetCells);
  const liabilities = sumColumn(liabilityCells);

  return {
    assets: assets.bracket,
    liabilities: liabilities.bracket,
    unparsedRows: assets.unparsedRows + liabilities.unparsedRows,
    unparsedTexts: [...assets.unparsedTexts, ...liabilities.unparsedTexts],
  };
}

/**
 * Internals exposed only for src/debug/diagHouse.ts, which dumps the exact
 * cell text behind a nonzero `unparsedRows` for a single filing so a
 * systematic layout miss can be told apart from genuine one-off noise. Not
 * part of the module's real contract — `fetchHouseDisclosures` is.
 */
export const __debug__ = {
  extractPositionedItems,
  collectScheduleCells,
  mergeSplitCells,
  normalizeHouseValueText,
  parseFilingPdf,
};

// ---------------------------------------------------------------------------
// StateDst splitting
// ---------------------------------------------------------------------------

const STATE_DST_RE = /^([A-Z]{2})(\d{2})$/;

function splitStateDst(stateDst: string): { state: string; district: string } | null {
  const m = STATE_DST_RE.exec(stateDst.trim().toUpperCase());
  if (!m) return null;
  return { state: m[1], district: m[2] };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Scrapes US House annual financial disclosures for `reportYear` and returns
 * summed asset/liability brackets per member.
 *
 * Never throws for a single filer's failure — a PDF that can't be fetched or
 * parsed after retries goes in `skipped` so one bad filing can't take down a
 * ~440-filer run. It DOES throw if the annual index itself can't be fetched
 * and unpacked, since nothing downstream is trustworthy without that.
 */
export async function fetchHouseDisclosures(reportYear: number): Promise<DisclosureFetchResult> {
  console.log(`\n🏛️  Fetching House financial disclosures for CY ${reportYear}...`);

  const zipUrl = `${CLERK_BASE}/${reportYear}FD.zip`;
  console.log(`📥 Downloading annual index: ${zipUrl}`);
  const zipBuf = await fetchBufferWithRetry(zipUrl);
  const xmlBuf = extractZipEntry(zipBuf, `${reportYear}FD.xml`);
  const allFilers = parseIndexXml(xmlBuf.toString("utf-8"));
  console.log(`   Index lists ${allFilers.length} filing(s) of all types for ${reportYear}.`);

  const chosen = chooseLatestPerFiler(allFilers);
  console.log(`📄 ${chosen.length} filer(s) have a kept annual original or amendment (O/A) for ${reportYear}.`);

  const skipped: Array<{ name: string; reason: string }> = [];
  const disclosures: RawDisclosure[] = [];

  let completed = 0;
  await mapWithConcurrency(chosen, CONCURRENCY, async (filer) => {
    const name = `${filer.first} ${filer.last}`.trim();

    try {
      const location = splitStateDst(filer.stateDst);
      if (!location) {
        skipped.push({ name, reason: `unrecognized StateDst "${filer.stateDst}"` });
        return;
      }

      const pdfUrl = `${CLERK_BASE}/${reportYear}/${filer.docId}.pdf`;
      const pdfBuf = await fetchBufferWithRetry(pdfUrl);
      const { assets, liabilities, unparsedRows, unparsedTexts } = await parseFilingPdf(new Uint8Array(pdfBuf));

      disclosures.push({
        chamber: "House",
        last: filer.last,
        first: filer.first,
        suffix: filer.suffix,
        state: location.state,
        district: location.district,
        reportYear,
        filedDate: usDateToIso(filer.filingDate),
        sourceUrl: pdfUrl,
        assets,
        liabilities,
        unparsedRows,
      });

      if (unparsedRows > 0) {
        console.warn(
          `  ⚠️  ${name}: ${unparsedRows} unparsed value row(s), totals are incomplete: ` +
            unparsedTexts.map((t) => JSON.stringify(t)).join(", ")
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push({ name, reason: `fetch/parse failed after retries: ${message}` });
      console.warn(`  ⚠️  Skipping ${name}: ${message}`);
    } finally {
      completed++;
      if (completed % PROGRESS_INTERVAL === 0) {
        console.log(`   ...${completed}/${chosen.length} House filings processed.`);
      }
    }
  });

  console.log(`✅ House disclosures done: ${disclosures.length} parsed, ${skipped.length} skipped.`);

  return { disclosures, reportYear, skipped };
}
