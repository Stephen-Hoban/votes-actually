/**
 * disclosureSenate.ts
 *
 * Scrapes annual financial disclosures for sitting US Senators from
 * https://efdsearch.senate.gov/search/ and reduces each filer to summed
 * asset/liability brackets, matching the `RawDisclosure` contract in
 * disclosureTypes.ts (see that file for the shape shared with the House
 * scraper, and disclosureBrackets.ts for the bracket-parsing primitives this
 * file builds on rather than reimplements).
 *
 * LEGAL NOTE — read before reusing this code
 * -------------------------------------------
 * Title I of the Ethics in Government Act (5 U.S.C. app. §105(c)) makes it
 * UNLAWFUL to obtain or use a Senate (or House) financial disclosure report
 * for any commercial purpose, for determining or establishing credit ratings,
 * or for soliciting money for political, charitable, or other purposes. This
 * isn't a website terms-of-service niggle you can shrug off — it's a federal
 * statute with its own private right of action. This project is a
 * non-commercial, public-interest bot that reports on Congressional votes,
 * which is squarely the kind of accountability use the statute contemplates
 * and does not restrict. If you fork this code for anything that touches
 * commerce, credit, or solicitation, you are on your own legally — the
 * statute applies to *use*, not just scraping method, and it does not care
 * that the data was technically easy to fetch.
 *
 * The access flow (no API key, no account — verified working 2026-08-11)
 * ------------------------------------------------------------------------
 *   1. GET  /search/home/            → extract the CSRF token + set a csrftoken
 *                                       cookie.
 *   2. POST /search/home/            → agree to the EIGA §105(c) prohibition
 *                                       notice (`prohibition_agreement=1`).
 *                                       This is a session flag the site's own
 *                                       search form makes you set by clicking
 *                                       "I agree" — not a login, no
 *                                       credentials — and it returns a
 *                                       `sessionid` cookie that unlocks the
 *                                       search endpoints for the rest of the
 *                                       session.
 *   3. POST /search/report/data/     → the DataTables server-side endpoint
 *                                       the search page's own JS calls. Takes
 *                                       report_type/filer_type/date filters
 *                                       and returns JSON rows.
 *   4. GET  /search/view/annual/{uuid}/  → the actual annual report, as HTML
 *                                       tables.
 *
 * Every POST is CSRF-protected AND referer-checked: Django's CSRF middleware
 * on this site 403s any POST that lacks a same-origin `Referer` header, even
 * with a valid token. `fetch` never sends one on its own, so it has to be set
 * by hand on every POST below — this tripped up the very first attempt while
 * building this file.
 *
 * Cookies are not persisted by Node's `fetch` — this module carries a tiny
 * hand-rolled cookie jar (`response.headers.getSetCookie()` in,
 * `Cookie: k=v; k2=v2` out) across the whole session.
 *
 * Format quirks discovered empirically (not guessed) while building this file
 * ------------------------------------------------------------------------
 *   - The report_type checkbox value for "Annual" is 7, filer_type for
 *     "Senator" is 1. The DataTables endpoint wants them as JSON-array-shaped
 *     strings: `report_types=[7]`, `filer_types=[1]`, plus
 *     `submitted_start_date`/`submitted_end_date` as `MM/DD/YYYY HH:MM:SS`.
 *     The server caps `length` at 100 rows/page regardless of what's
 *     requested, so this module paginates.
 *   - Each row is [firstName, lastName, officeOrType, reportLinkHtml,
 *     filedDate]. `lastName` sometimes embeds a suffix after a comma
 *     ("King, Jr.", "Hagerty, IV") — split before handing it to the
 *     BioGuide-join layer, which expects a bare surname.
 *   - The link text says "Annual Report for CY 2024" (optionally
 *     "(Amendment N)") for electronic filings, which is how the target
 *     report year is actually confirmed — the *submitted* date range is only
 *     a coarse server-side filter, not proof of which calendar year a report
 *     covers.
 *   - Paper/"Blind Trust" filings (href under /search/view/paper/, scanned
 *     PDF) do NOT carry a "CY ####" in their link text at all, so their
 *     report year can't be confirmed from the listing. They're always
 *     skipped — see "Which filings to use" below.
 *   - Inside an annual report, Part 3 (Assets) and Part 7 (Liabilities) each
 *     have exactly one HTML table if the filer answered "Yes" to that part's
 *     question, and NO table at all if they answered "No" (not an empty
 *     table — the `<table>` element is simply absent). Both cases mean the
 *     same thing here: zero brackets, zero unparsed rows.
 *   - Grouping/parent rows inside Part 3 (e.g. a holding-company or trust row
 *     whose child assets carry the actual values) render their Value cell as
 *     literal "--". That's a structural placeholder, not a missing value —
 *     the worth lives in the child rows underneath. disclosureBrackets.ts's
 *     parseBracket now treats a bare dash/en dash/em dash as zero for exactly
 *     this reason, so it's passed straight through here rather than
 *     special-cased in this file.
 *   - "None (or less than $1,001)" is an extremely common Senate-specific
 *     value phrasing — every "Excepted Investment Fund" (mutual fund, ETF,
 *     some bonds) below the reporting threshold uses it. parseBracket now
 *     parses it as the real { low: 0, high: 1000 } range it describes rather
 *     than collapsing it to zero, since with hundreds of such rows on a
 *     single filing, rounding each one down would be a systematic
 *     understatement, not a rounding error. This file passes it straight
 *     through too.
 *   - One phrasing genuinely IS Senate-form-specific and is normalized here
 *     (not in the shared parser): "Over $1,000,000 and held independently by
 *     spouse or dependent child". This is a real, optional Ethics in
 *     Government Act reporting category — filers may report a spouse- or
 *     dependent-child-SOLELY-owned asset this way instead of a normal
 *     fine-grained bracket, when the filer has no financial interest in or
 *     knowledge of it. It is genuinely elective, not a hard ceiling: in the
 *     6-filer sample used to build this file, it appeared on 50 of 298
 *     Spouse-owned asset rows for one wealthy filer (Rick Scott) and on ZERO
 *     Joint/Self/Child rows anywhere, or Spouse rows for any of the other 5
 *     filers sampled — several of whom reported spouse-owned assets above
 *     $1M in ordinary, fully-granular brackets instead (e.g. Mark Warner's
 *     spouse's ETF holdings, reported as ordinary "$1,000,001 - $5,000,000"
 *     brackets, not capped). So this is a per-asset filer choice available to
 *     (as far as this file's author could confirm) both chambers under the
 *     same statute, not evidence of a Senate-only ceiling — but see this
 *     project's cross-chamber comparison notes for the asymmetry it still
 *     creates in practice. The trailing descriptive clause is stripped so
 *     the remaining "Over $1,000,000" is handed to parseBracket unchanged.
 *     "Unascertainable" (seen on a defined-benefit pension entry) is left
 *     alone deliberately — that one really is unparseable.
 */

import type { Bracket } from "./disclosureBrackets.js";
import { parseBracket, sumBrackets, ZERO_BRACKET } from "./disclosureBrackets.js";
import type { DisclosureFetchResult, RawDisclosure } from "./disclosureTypes.js";

const USER_AGENT = "votes-actually (educational project)";
const BASE_URL = "https://efdsearch.senate.gov";
const HOME_URL = `${BASE_URL}/search/home/`;
const SEARCH_URL = `${BASE_URL}/search/`;
const REPORT_DATA_URL = `${BASE_URL}/search/report/data/`;

/** Annual report (7) filed by a sitting Senator (1) — see file header. */
const REPORT_TYPE_ANNUAL = 7;
const FILER_TYPE_SENATOR = 1;

/** Rows per page the server actually returns, regardless of what's requested. */
const PAGE_SIZE = 100;

/** How many filers' report pages to fetch in parallel. ~100 filers, one government server. */
const CONCURRENCY = 4;
/** Extra attempts after the first for a single report-page fetch. */
const MAX_RETRIES = 2;
/** Base backoff between retries of the same request, doubled each attempt. */
const RETRY_BACKOFF_MS = 750;
/** Small courtesy delay before each per-filer report fetch. */
const REQUEST_DELAY_MS = 200;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "08/13/2025" → "2025-08-13". Returns "" if the input isn't that shape. */
function usDateToIso(mmddyyyy: string): string {
  const m = mmddyyyy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** For sorting "which filing is latest" — MM/DD/YYYY string sort is NOT chronological. */
function usDateToComparable(mmddyyyy: string): number {
  const iso = usDateToIso(mmddyyyy);
  return iso ? Date.parse(`${iso}T00:00:00Z`) : 0;
}

function todayAsUsDate(): string {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`;
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

// ---------------------------------------------------------------------------
// Cookie jar + session bootstrap
// ---------------------------------------------------------------------------

interface SenateSession {
  /** `name=value; name2=value2` — sent as the Cookie header on every request. */
  cookieHeader: string;
  /** The CSRF token, kept in sync with the csrftoken cookie in the jar. */
  csrfToken: string;
}

/** Merges any `Set-Cookie` headers on a response into the jar's Cookie header. */
function mergeCookies(cookieHeader: string, response: Response): string {
  const jar = new Map<string, string>();
  for (const pair of cookieHeader.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name) jar.set(name, rest.join("="));
  }
  for (const setCookie of response.headers.getSetCookie()) {
    const firstPair = setCookie.split(";")[0];
    const eq = firstPair.indexOf("=");
    if (eq === -1) continue;
    jar.set(firstPair.slice(0, eq).trim(), firstPair.slice(eq + 1).trim());
  }
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * GET /search/home/, agree to the EIGA prohibition notice, and return a
 * session (cookies + CSRF token) good for the rest of the run.
 *
 * Throws with an actionable message if the site's flow has changed — this is
 * exactly the kind of failure that must NOT be silently swallowed, since
 * every later fetch depends on it.
 */
async function bootstrapSession(): Promise<SenateSession> {
  console.log("🔐 Starting Senate EFD session (CSRF + prohibition agreement)...");

  const homeResp = await fetch(HOME_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!homeResp.ok) {
    throw new Error(
      `Senate EFD home page fetch failed: ${homeResp.status} ${homeResp.statusText}. ` +
      `The site may be down, or its URL structure may have changed.`
    );
  }
  const homeHtml = await homeResp.text();
  let cookieHeader = mergeCookies("", homeResp);

  const tokenMatch = homeHtml.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/);
  if (!tokenMatch) {
    throw new Error(
      "Could not find csrfmiddlewaretoken on the Senate EFD home page. " +
      "The site's form markup has likely changed — this scraper needs updating, not retrying."
    );
  }
  const csrfToken = tokenMatch[1];

  const agreeResp = await fetch(HOME_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: HOME_URL,
      Cookie: cookieHeader,
    },
    body: new URLSearchParams({
      csrfmiddlewaretoken: csrfToken,
      prohibition_agreement: "1",
    }),
    redirect: "manual",
  });

  // A successful agreement 302s to /search/ and sets `sessionid`. Anything
  // else means the flow didn't work the way it did when this was written.
  if (agreeResp.status !== 302) {
    throw new Error(
      `Senate EFD prohibition-agreement POST returned ${agreeResp.status}, expected 302. ` +
      `The CSRF/session flow this scraper depends on may have changed.`
    );
  }
  cookieHeader = mergeCookies(cookieHeader, agreeResp);

  if (!/sessionid=/.test(cookieHeader)) {
    throw new Error(
      "Senate EFD agreement POST succeeded but no sessionid cookie was set. " +
      "Search endpoints will 403 without it — aborting rather than fetching nothing useful."
    );
  }

  console.log("✅ Senate EFD session established.");
  return { cookieHeader, csrfToken };
}

// ---------------------------------------------------------------------------
// Listing: paginate /search/report/data/ for annual Senator filings
// ---------------------------------------------------------------------------

interface ReportDataResponse {
  recordsTotal: number;
  data: string[][];
}

async function fetchReportPage(
  session: SenateSession,
  startDate: string,
  endDate: string,
  start: number
): Promise<ReportDataResponse> {
  const body = new URLSearchParams({
    draw: String(start / PAGE_SIZE + 1),
    start: String(start),
    length: String(PAGE_SIZE),
    report_types: `[${REPORT_TYPE_ANNUAL}]`,
    filer_types: `[${FILER_TYPE_SENATOR}]`,
    submitted_start_date: `${startDate} 00:00:00`,
    submitted_end_date: `${endDate} 23:59:59`,
    candidate_state: "",
    senator_state: "",
    office_id: "",
    first_name: "",
    last_name: "",
  });

  const resp = await fetch(REPORT_DATA_URL, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: SEARCH_URL,
      "X-CSRFToken": session.csrfToken,
      Cookie: session.cookieHeader,
    },
    body,
  });

  if (!resp.ok) {
    throw new Error(`Senate EFD report listing fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const json = (await resp.json()) as { recordsTotal: number; data: string[][] };
  return { recordsTotal: json.recordsTotal, data: json.data };
}

/** One row of the search results, after picking apart the report-link HTML. */
interface ListedFiling {
  first: string;
  last: string;
  filedDate: string; // MM/DD/YYYY as published
  uuid: string;
  isPaper: boolean;
  /** Report year parsed from the link text; null for paper filings, which never state it. */
  linkYear: number | null;
}

const ANNUAL_LINK_RE = /<a href="\/search\/view\/annual\/([\w-]+)\/"[^>]*>([^<]*)<\/a>/;
const PAPER_LINK_RE = /<a href="\/search\/view\/paper\/([\w-]+)\/"[^>]*>/;

function parseListedFiling(row: string[]): ListedFiling | null {
  const [first, last, , linkHtml, filedDate] = row;

  const annualMatch = linkHtml.match(ANNUAL_LINK_RE);
  if (annualMatch) {
    const [, uuid, linkText] = annualMatch;
    const yearMatch = linkText.match(/CY\s+(\d{4})/);
    return {
      first: first.trim(),
      last: last.trim(),
      filedDate,
      uuid,
      isPaper: false,
      linkYear: yearMatch ? Number(yearMatch[1]) : null,
    };
  }

  const paperMatch = linkHtml.match(PAPER_LINK_RE);
  if (paperMatch) {
    return {
      first: first.trim(),
      last: last.trim(),
      filedDate,
      uuid: paperMatch[1],
      isPaper: true,
      linkYear: null,
    };
  }

  return null;
}

/**
 * Lists every annual Senator filing whose *submitted* date falls after the
 * earliest an original CY `reportYear` report could exist (Jan 1 of the
 * following year — annual reports always cover a completed calendar year),
 * through today (to catch amendments filed any time since, which do happen
 * years later — see the Welch example in this module's development notes).
 *
 * This is the server-side narrowing the brief asks for: it avoids pulling
 * the site's entire 2012-to-present history, at the cost of trusting that no
 * original CY `reportYear` report is ever submitted before `reportYear + 1`
 * — true in practice, since the reporting period isn't even over yet
 * otherwise.
 */
async function listAnnualFilings(session: SenateSession, reportYear: number): Promise<ListedFiling[]> {
  const startDate = `01/01/${reportYear + 1}`;
  const endDate = todayAsUsDate();

  console.log(`🔎 Searching Senate EFD for annual filings submitted ${startDate} through ${endDate}...`);

  const filings: ListedFiling[] = [];
  let start = 0;
  let recordsTotal = Infinity;

  while (start < recordsTotal) {
    const page = await fetchReportPage(session, startDate, endDate, start);
    recordsTotal = page.recordsTotal;
    for (const row of page.data) {
      const parsed = parseListedFiling(row);
      if (parsed) filings.push(parsed);
    }
    start += PAGE_SIZE;
    if (start < recordsTotal) await sleep(REQUEST_DELAY_MS);
  }

  console.log(`   Found ${filings.length} row(s) across ${recordsTotal} total matching filings.`);
  return filings;
}

/** One senator's chosen filing for the target report year, after dedup. */
interface ChosenFiling {
  first: string;
  last: string;
  filing: ListedFiling;
}

/**
 * Groups listed filings by filer name and keeps only the latest-filed one per
 * senator — an amendment supersedes an original, it does not add to it.
 *
 * Paper filings don't declare their report year in the listing (see file
 * header), so they're included in the grouping purely on the strength of the
 * date-window filter already applied by `listAnnualFilings`: within that
 * window, an "Annual Report (Amendment)" paper filing is assumed to belong to
 * `reportYear`, same assumption the date filter already makes for everything
 * else. If a paper filing wins its group (is the latest for that senator),
 * the whole senator is skipped — even if an earlier electronic filing for the
 * same year exists, because the paper one supersedes it and can't be parsed.
 */
function chooseLatestPerSenator(
  filings: ListedFiling[],
  reportYear: number
): { chosen: ChosenFiling[]; paperSkipped: Array<{ name: string; reason: string }> } {
  const relevant = filings.filter((f) => f.isPaper || f.linkYear === reportYear);

  const groups = new Map<string, ListedFiling[]>();
  for (const f of relevant) {
    const key = `${f.first.toUpperCase()}|${f.last.toUpperCase()}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  }

  const chosen: ChosenFiling[] = [];
  const paperSkipped: Array<{ name: string; reason: string }> = [];

  for (const bucket of groups.values()) {
    const latest = bucket.reduce((best, f) =>
      usDateToComparable(f.filedDate) > usDateToComparable(best.filedDate) ? f : best
    );
    const name = `${latest.first} ${latest.last}`;
    if (latest.isPaper) {
      paperSkipped.push({
        name,
        reason:
          `latest CY ${reportYear} annual filing is a paper/"Blind Trust" report ` +
          `(scanned PDF at /search/view/paper/${latest.uuid}/, not machine-readable)`,
      });
      continue;
    }
    chosen.push({ first: latest.first, last: latest.last, filing: latest });
  }

  return { chosen, paperSkipped };
}

// ---------------------------------------------------------------------------
// Annual report HTML: section scoping + table parsing
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  const withoutTags = html.replace(/<[^>]+>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#35;/g, "#")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return decoded.replace(/\s+/g, " ").trim();
}

/**
 * Slices out one "Part N. Title" section of the report, from its heading to
 * the next "Part " heading (or end of document). Case-insensitive and
 * tolerant of whitespace, since the goal is section scoping, not exact markup
 * matching — several other Parts (4, 5, 6) also contain "$X - $Y" ranges, so
 * this boundary is what keeps them out of the Assets/Liabilities sums.
 */
function sectionSlice(html: string, partLabel: string): string | null {
  const headingRe = new RegExp(`<h3[^>]*>\\s*${partLabel.replace(/\./g, "\\.")}[\\s\\S]*?</h3>`, "i");
  const headingMatch = headingRe.exec(html);
  if (!headingMatch) return null;

  const start = headingMatch.index + headingMatch[0].length;
  const rest = html.slice(start);
  const nextHeadingMatch = /<h3[^>]*>\s*Part\s+\d/i.exec(rest);
  const end = nextHeadingMatch ? start + nextHeadingMatch.index : html.length;

  return html.slice(start, end);
}

/** Index of the column whose header text matches `label` (case-insensitive, trimmed). */
function headerColumnIndex(sectionHtml: string, label: string): number | null {
  const theadMatch = /<thead>([\s\S]*?)<\/thead>/i.exec(sectionHtml);
  if (!theadMatch) return null;

  const headers = Array.from(theadMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)).map((m) =>
    stripTags(m[1]).toLowerCase()
  );
  const idx = headers.indexOf(label.toLowerCase());
  return idx === -1 ? null : idx;
}

/** All `<tbody>` rows in the section's first table, each cell already tag-stripped. */
function tableRows(sectionHtml: string): string[][] {
  const tableMatch = /<table[^>]*>([\s\S]*?)<\/table>/i.exec(sectionHtml);
  if (!tableMatch) return [];

  const bodyMatch = /<tbody>([\s\S]*?)<\/tbody>/i.exec(tableMatch[1]);
  const body = bodyMatch ? bodyMatch[1] : tableMatch[1];

  return Array.from(body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((rowMatch) =>
    Array.from(rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((cellMatch) => stripTags(cellMatch[1]))
  );
}

/**
 * Strips the Senate-specific "...and held independently by spouse or
 * dependent child" clause off the one phrasing that isn't already part of
 * parseBracket's shared vocabulary, leaving "Over $1,000,000" for it to parse
 * normally. Everything else (including "--" and "None (or less than $X)",
 * both now handled directly by parseBracket) is passed through untouched —
 * see the file header for why those are NOT special-cased here.
 */
function normalizeSenateValueText(raw: string): string {
  const overWithSuffix = raw.match(/^(over\s+\$[\d,]+)\b/i);
  return overWithSuffix ? overWithSuffix[1] : raw;
}

/** Sums one section's value column. */
function sumValueColumn(sectionHtml: string | null, headerLabel: string): { bracket: Bracket; unparsedRows: number } {
  if (sectionHtml === null) return { bracket: { ...ZERO_BRACKET }, unparsedRows: 0 };

  const colIndex = headerColumnIndex(sectionHtml, headerLabel);
  if (colIndex === null) {
    // No table at all means the filer answered "No" to this part's question —
    // not a parsing failure. See file header.
    return { bracket: { ...ZERO_BRACKET }, unparsedRows: 0 };
  }

  const brackets: Bracket[] = [];
  let unparsedRows = 0;

  for (const row of tableRows(sectionHtml)) {
    if (colIndex >= row.length) continue;
    const cell = row[colIndex].trim();

    const bracket = parseBracket(normalizeSenateValueText(cell));
    if (bracket === null) {
      unparsedRows++;
      continue;
    }
    brackets.push(bracket);
  }

  return { bracket: sumBrackets(brackets), unparsedRows };
}

/**
 * Parses one annual report page into summed Part 3 assets and Part 7 liabilities.
 *
 * Throws when the Assets heading is absent entirely. That is NOT the same as a
 * filer reporting no assets: every annual report renders all ten Part headings
 * regardless of the answers, so a missing "Part 3. Assets" means the page isn't
 * the report we think it is, or the markup changed. Treating that as "$0 in
 * assets" is precisely how this scraper silently reported all 95 senators as
 * worth nothing on its first run — a section-matching bug produced zeros that
 * looked exactly like honest zeros. Failing loudly here turns that class of bug
 * into a skipped filer and a visible coverage drop.
 */
function parseAnnualReportHtml(html: string): { assets: Bracket; liabilities: Bracket; unparsedRows: number } {
  // Plain text, not a regex fragment — sectionSlice escapes it. Passing a
  // pre-escaped "Part 3\\. Assets" here double-escaped the dot and matched
  // nothing, which was the original zeroing bug.
  const assetsSection = sectionSlice(html, "Part 3. Assets");
  const liabilitiesSection = sectionSlice(html, "Part 7. Liabilities");

  if (assetsSection === null) {
    throw new Error(
      'report HTML has no "Part 3. Assets" heading — markup may have changed; refusing to ' +
      "record this filer as $0"
    );
  }

  const assets = sumValueColumn(assetsSection, "Value");
  const liabilities = sumValueColumn(liabilitiesSection, "Amount");

  return {
    assets: assets.bracket,
    liabilities: liabilities.bracket,
    unparsedRows: assets.unparsedRows + liabilities.unparsedRows,
  };
}

// ---------------------------------------------------------------------------
// Fetching individual reports, with retry
// ---------------------------------------------------------------------------

async function fetchWithRetry(url: string, session: SenateSession): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Cookie: session.cookieHeader },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      return await resp.text();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Splits a Senate `last` field like "King, Jr." into surname + suffix. */
function splitLastAndSuffix(last: string): { last: string; suffix: string } {
  const commaIdx = last.indexOf(",");
  if (commaIdx === -1) return { last, suffix: "" };
  return {
    last: last.slice(0, commaIdx).trim(),
    suffix: last.slice(commaIdx + 1).trim(),
  };
}

/**
 * Scrapes US Senate annual financial disclosures for `reportYear` and
 * returns summed asset/liability brackets per senator.
 *
 * Never throws for a single filer's failure — a report that can't be fetched
 * or parsed after retries goes in `skipped` so one bad filing can't take down
 * a ~100-filer run. It DOES throw if the session/listing machinery itself
 * fails, since nothing downstream is trustworthy without that.
 */
export async function fetchSenateDisclosures(reportYear: number): Promise<DisclosureFetchResult> {
  console.log(`\n🏛️  Fetching Senate financial disclosures for CY ${reportYear}...`);

  const session = await bootstrapSession();
  const filings = await listAnnualFilings(session, reportYear);
  const { chosen, paperSkipped } = chooseLatestPerSenator(filings, reportYear);

  console.log(
    `📄 ${chosen.length} senator(s) have a machine-readable CY ${reportYear} annual report; ` +
    `${paperSkipped.length} skipped as paper/"Blind Trust" filings.`
  );

  const skipped: Array<{ name: string; reason: string }> = [...paperSkipped];
  const disclosures: RawDisclosure[] = [];

  let completed = 0;
  await mapWithConcurrency(chosen, CONCURRENCY, async (entry) => {
    const name = `${entry.first} ${entry.last}`;
    const sourceUrl = `${BASE_URL}/search/view/annual/${entry.filing.uuid}/`;

    await sleep(REQUEST_DELAY_MS);

    try {
      const html = await fetchWithRetry(sourceUrl, session);
      const { assets, liabilities, unparsedRows } = parseAnnualReportHtml(html);
      const { last, suffix } = splitLastAndSuffix(entry.last);

      disclosures.push({
        chamber: "Senate",
        last,
        first: entry.first,
        suffix,
        state: "", // Not exposed by the search index; the roster join disambiguates.
        district: "",
        reportYear,
        filedDate: usDateToIso(entry.filing.filedDate),
        sourceUrl,
        assets,
        liabilities,
        unparsedRows,
      });

      if (unparsedRows > 0) {
        console.warn(`  ⚠️  ${name}: ${unparsedRows} unparsed value row(s), totals are incomplete.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push({ name, reason: `fetch/parse failed after retries: ${message}` });
      console.warn(`  ⚠️  Skipping ${name}: ${message}`);
    } finally {
      completed++;
      if (completed % 20 === 0) console.log(`   ...${completed}/${chosen.length} senator reports processed.`);
    }
  });

  console.log(
    `✅ Senate disclosures done: ${disclosures.length} parsed, ${skipped.length} skipped.`
  );

  return { disclosures, reportYear, skipped };
}
