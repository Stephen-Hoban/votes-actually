# Congressional Vote Bluesky Bots — Project Brief

## Stack
TypeScript / Node.js 20

---

## Phase 1: Complete ✅

### What was built
- senate.gov XML → vote detection + member votes
- clerk.house.gov XML → House vote detection + member votes
- Census ACS5 API → state populations (Senate) + district populations (House)
- congress-legislators (GitHub gh-pages branch) → BioGuide ID → district mapping
- Caching layer: `npm run refresh-cache` (slow data), `npm run fetch-votes` (live votes)
- Output: population represented by yes vs no per vote, both chambers

### Key files
```
src/fetchVotes.ts      — main pipeline script (loads from cache, fetches live votes)
src/refreshCache.ts    — cache refresh script
data/                  — cached reference data (gitignored — must run refresh-cache first)
tsconfig.json          — ES2020 target (required for Map, Set, fetch, etc.)
```

### npm scripts
```
npm run fetch-votes       — fetch latest votes (requires cache to exist)
npm run refresh-cache     — refresh all cached data
npm run refresh-members   — refresh member→district map only (after special elections)
npm run refresh-census    — refresh district populations only
```

### Important: cache setup
The `data/` directory is gitignored. Anyone cloning the repo or starting fresh must run
`npm run refresh-cache` before `npm run fetch-votes` will work. If the cache is missing,
the script exits with a clear error message directing you to run the refresh.

---

## Testing

**Goal:** Catch silent calculation errors before they're posted publicly and irreversibly
(added 2026-07-13, prompted by the Aye/No resolution-vote bug above — it produced 0%
population with no error, and would have shipped a wrong post if undetected).

The population/percentage calculation logic is pure and framework-free, split out of
`fetchVotes.ts` into `src/voteCalculations.ts` specifically so it can be unit tested without
network or filesystem access (`fetchVotes.ts` itself runs its pipeline on import, so it can't
be imported safely in a test).

### Key files
```
src/voteCalculations.ts       — pure calc/formatting functions (imported by fetchVotes.ts)
src/voteCalculations.test.ts  — vitest unit tests (22 tests)
```

### npm scripts
```
npm test    — run the test suite once (vitest run)
```

### Coverage
- `normalizeHouseVote` — Yea/Nay (bills) and Aye/No (resolutions) both normalize correctly
- `calculateSenatePopulation` / `calculateHousePopulation` — correct sums, plus edge cases:
  unmatched members (missing from `member-districts.json`), unmatched districts (missing
  from Census cache), non-voting codes (Present), missing bioguide IDs
- `computeCongressSession` — Congress/session rollover at year boundaries
- `formatPop`, `formatPct`, `buildPopulationPost` — output formatting, including the exact
  Bluesky post string

Not covered yet: the XML-fetching/parsing layer in `fetchVotes.ts` itself (would need
recorded HTTP fixtures) — deferred until it becomes a real pain point.

---

## Data sources & rationale

| Data | Source | Why |
|---|---|---|
| Vote detection + member votes | senate.gov + clerk.house.gov XML | Direct source, no API key, no rate limits |
| Bill context / enrichment | ProPublica Congress API (Phase 3) | Reserved for website — richer metadata |
| District populations | Census ACS5 2022, variable `B01003_001E` | State + congressional district level |
| Member→district lookup | congress-legislators, gh-pages branch | BioGuide IDs, updated by CircleCI |
| State populations | Census ACS5 2022, same variable | Used for Senate calculation |

### congress-legislators URL (important)
JSON files live in the `gh-pages` branch, not `main`. Use:
```
https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages/legislators-current.json
```
The `theunitedstates.io` domain is no longer active. The GitHub raw URL is the correct
permanent home. Updated by CircleCI automation — confirmed active as of April 2026.

### House member→district lookup
The House XML (`clerk.house.gov/evs/{year}/roll{NNN}.xml`) does **not** include a district
attribute on the `<legislator>` element. District is resolved via a two-step chain:
```
vote XML: name-id="A000370" (BioGuide ID)
    ↓  congress-legislators JSON
district key: "NC-12"
    ↓  Census ACS5 API
population: 748,052
```

---

## Methodology notes

### Senate population calculation
- Each senator represents their full state population
- Denominator = 2 × total 50-state population (two senators per state)
- A unanimous 100-0 vote sums to ~100% across yes + no + abstain
- DC and PR excluded (no senators)
- Independents Sanders (VT) and King (ME) counted with Democrats

### House population calculation
- Each representative represents their specific congressional district population
- Denominator = total 50-state population
- District populations are roughly equal by design (~760K per district)
- 1 unmatched member per vote is expected — likely a non-voting delegate (DC, PR, etc.)
- **Vote code varies by vote type:** the House XML's per-member `<vote>` value is `Yea`/`Nay`
  for bill votes but `Aye`/`No` for votes on resolutions (procedural/rule votes, e.g. "On
  Agreeing to the Resolution"). `fetchVotes.ts`'s `normalizeHouseVote()` treats both pairs
  the same. Matching only `Yea`/`Nay` silently produces 0 population represented on
  resolution votes with no warning (fixed 2026-07-08; verified against roll #231).

---

## Congress/session/year: auto-detected (Phase 2, resolved 2026-07-07)

`CONGRESS_NUM`, `SENATE_SESSION`, and `HOUSE_YEAR` are no longer hardcoded. `fetchVotes.ts`
now derives them at runtime:
- `computeCongressSession(date)` — Congress number from `(year - 1789) / 2 + 1`, session
  1/2 from odd/even calendar year.
- `detectCongressSession()` — computes the candidate congress/session, then verifies the
  Senate's `vote_menu_{congress}_{session}.xml` exists; falls back to the previous session
  if not (e.g. new session hasn't posted votes yet).
- `detectHouseYear()` — checks `roll001.xml` for the current calendar year; falls back to
  the previous year if the House hasn't posted votes yet for the new year.

No more manual updates needed at the start of each session/year/Congress.

---

## Known issues / future cleanup
- Senate post text sometimes verbose — question field can duplicate the description field
- 1 unmatched House member per vote (non-voting delegate) — acceptable, can be noted in posts

---

## Phase 2: Build the bots

**Goal:** Post to Bluesky automatically when a new vote is detected.

### Steps
- ✅ Fix `HOUSE_YEAR` and `SENATE_SESSION` hardcoded values — replaced with auto-detection
- ✅ Set up Bluesky account for the population bot (subdomain handle, DNS TXT verified)
- ✅ Format posts per bot persona — population bot done (`buildPopulationPost()` in `fetchVotes.ts`); other personas still need their own post-formatting functions
- ✅ Add vote polling loop — `--watch` flag (`npm run watch-votes`) re-runs the fetch/post cycle on an interval (`POLL_INTERVAL_MINUTES`, default 15) instead of a separate cron-triggered process
- ✅ Store seen vote IDs to avoid duplicate posts — `src/seenVotes.ts`, local JSON per bot (`data/seen-votes-{botid}.json`), Supabase migration still open for later
- Set up remaining Bluesky accounts as each bot is built (one per bot persona)
- Deploy to Railway or Render running `npm run watch-votes` as a long-lived process (free tier to start, upgradeable)

**Status (2026-07-13):** Posting, dedupe, and polling are implemented, live-tested against `@population.votesactually.com`, and merged to `main` via [PR #1](https://github.com/Stephen-Hoban/votes-actually/pull/1). Not yet deployed anywhere.

### Key files (added Phase 2)
```
src/bluesky.ts    — postToBluesky(botId, text): login/session persistence, posts, keyed per bot
src/seenVotes.ts  — loadSeenVotes/saveSeenVotes(botId): per-bot dedupe store
```

### npm scripts (added Phase 2)
```
npm run post-votes    — fetch-votes + post any new votes to Bluesky (one-shot)
npm run watch-votes   — same, but loops forever on POLL_INTERVAL_MINUTES (default 15)
```

### Bluesky setup notes
- Use `@atproto/api` npm package for posting (`src/bluesky.ts`)
- Domain verification: add DNS TXT record per Bluesky's instructions per subdomain handle
- Rate limits: persist session to disk after login to avoid hitting login rate limits — session stored per bot at `data/bluesky-session-{botid}.json`
- One Bluesky account per bot (separate credentials per persona). Env vars are namespaced per bot ID: `BLUESKY_{BOTID}_HANDLE` / `BLUESKY_{BOTID}_APP_PASSWORD` (e.g. `BLUESKY_POPULATION_HANDLE`). Adding a new bot persona is just new `.env` entries — no code changes needed.
- The Bluesky login API rejects a leading `@` on the handle (though `@handle` is the normal display form) — `bluesky.ts` strips it automatically, so `.env` can be written either way.

### Bot family (population bot first, others to follow — see BotList.md)
| Bot handle | What it posts |
|---|---|
| `@population.domain` | Population represented by yes vs no |
| `@networth.domain` | Average net worth of reps on each side of the vote |
| `@age.domain` | Average age of reps on each side of the vote |
| `@money.domain` | Campaign contributions from affected industries (FEC API) |

### Possible future bot accounts (not yet planned in detail)
- `@party.domain` — party-line breakdown + defectors
- `@district.domain` — how reps voted vs their district's demographics

---

## Phase 3: Website

**Goal:** A dashboard storing full analysis that doesn't fit in a 280-char Bluesky post.
Each bot post links back to a richer page. Acts as a permanent record of votes and breakdowns.

### Stack options
- **Next.js + Vercel** — easy deployment, good for this kind of content site
- **Astro** — great for mostly-static content with some dynamic pieces
- **Database** — Supabase (free tier generous, Postgres under the hood)

### ProPublica Congress API
Reserved for Phase 3 enrichment — bill summaries, subject tags, committee history,
links to full bill text. Requires free API key registration.

---

## Existing competition / prior art
- **Representabot** (Protect Democracy) — Twitter/X bot, Senate only, population calculation,
  archived October 2024. Our direct predecessor. Open source on GitHub (MIT license).
  Uses senate.gov XML + Census API — same approach we took.
- **FedBillBot** (`@fedbillbot.bsky.social`) — posts about bills on Bluesky, no vote analysis.

Our differentiation: Bluesky, both chambers, bot family with multiple analytical lenses,
Phase 3 website for deeper context.
