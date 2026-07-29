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
src/voteCalculations.test.ts  — vitest unit tests (36 tests)
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
  Bluesky post string, description shortening, and bill-link facet placement
- `graphemeLength` / `fitsInPost` / `truncateToGraphemes` — grapheme-cluster-aware length
  checks (see "Bluesky post length & bill links" below)
- `buildBillUrl` — congress.gov URL mapping for all House/Senate bill/resolution types,
  including the ordinal-suffix edge case (11th/12th/13th vs. 21st/22nd/23rd)
- `selectRecentSenateVotes` — Senate vote list ordering (see below)

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

## Bluesky post length & bill links (resolved 2026-07-27)

**Problem:** Posts were getting cut off mid-content (e.g. losing the entire "❌ NO" line —
see the [example post](https://bsky.app/profile/population.votesactually.com/post/3mr6qpz4hzn2j)
that motivated the fix). Root cause: `truncateForBluesky()` sliced the whole post at 300 raw
JS `.length` chars — which both mismeasures multi-codepoint emoji (e.g. 🇺🇸 is 2 codepoints/4
UTF-16 units but 1 grapheme) and blindly cuts wherever the limit lands, with no regard for
which content is expendable.

**Fix:**
- `graphemeLength()` / `fitsInPost()` / `truncateToGraphemes()` in `voteCalculations.ts` use
  `Intl.Segmenter` to count/cut by grapheme cluster, matching what Bluesky actually enforces
  (required adding `ES2022.Intl` to `tsconfig.json`'s `lib`).
- `buildPopulationPost()` now treats the Result and Population-represented lines as fixed —
  never truncated. Only the `description` field gets shortened (with a trailing "…") when the
  post doesn't fit.
- `buildPopulationPost()` returns `{ text, facets }` instead of a plain string. When a bill
  URL is resolvable, the description text itself (full or truncated) becomes a clickable
  Bluesky rich-text facet linking to the bill's congress.gov page — no more `Full text: <url>`
  suffix competing for character budget. Facet byte offsets are computed with
  `Buffer.byteLength(..., "utf-8")` since Bluesky facets index UTF-8 bytes, not JS string
  indices.
- `buildBillUrl(congress, rawDesignation)` maps a raw bill/resolution designation (House
  `<legis-num>`, e.g. `"H R 5103"`; Senate `document_type`+`document_number`, e.g. `"H.R.
  6938"`, falling back to `amendment_to_document_number` for amendment votes) to its
  congress.gov page, e.g. `https://www.congress.gov/bill/119th-congress/house-bill/5103`.
  Returns `""` for things with no bill page (nominations, unresolvable amendments) — those
  posts just have no link, no crash.
- `postToBluesky(botId, text, facets)` in `bluesky.ts` converts the generic facet shape into
  `@atproto/api`'s `AppBskyRichtextFacet.Main` and passes it to `agent.post()`. Its own
  `truncateForBluesky()` safety net (grapheme-aware now) still exists as a last resort and
  logs a warning if it ever actually fires — that would mean `buildPopulationPost()`'s own
  budget math missed a case.

**Also fixed in the same commit:** the Senate vote fetcher (`fetchSenateVotes()`) was pulling
the 5 *oldest* votes of the session instead of the 5 most recent. The Senate's
`vote_menu_{congress}_{session}.xml` lists votes newest-first (descending `vote_number`), but
the old code did `voteArray.slice(-VOTES_TO_SHOW).reverse()`, which assumed the opposite
order. Combined with the seen-votes dedupe store, this meant the Senate bot had likely never
posted anything past the first ~5 votes of a session. Fixed via
`selectRecentSenateVotes(voteArray, count)` in `voteCalculations.ts`, which just takes the
first `count` entries.

Live-verified against real 119th Congress data before deploying: all sampled posts (bills,
House/Senate resolutions, joint/concurrent resolutions, nominations) stayed within 300
graphemes, and Senate votes now show the current session's latest activity instead of vote
#1-5 from January. Confirmed again in production after deployment (2026-07-27): recent posts
on `@population.votesactually.com` show current Senate activity (cloture motions,
nominations), and the description text renders as an actual clickable link to congress.gov
(e.g. the "S.J.Res. 180" post links to
`https://www.congress.gov/bill/119th-congress/senate-joint-resolution/180`).

---

## Age bot + multi-bot refactor (2026-07-28)

The second bot persona (`@age.votesactually.com`) posts the **average age of the members who
voted yea vs. nay**, in the same post shape as the population bot.

### The refactor that made it possible
Adding a second bot exposed the fact that `fetchVotes.ts` mixed three unrelated concerns:
fetching votes, computing populations, and formatting posts. Only the middle one is
population-specific. Rather than copy ~200 lines of XML parsing into the age bot, the shared
parts were extracted:

```
src/voteSources.ts     — NEW. All senate.gov / clerk.house.gov fetching + XML parsing.
                         Returns chamber-agnostic RawVote records; knows nothing about
                         population, age, or any other bot's analysis.
src/voteCalculations.ts — buildVotePost(meta, statBlock) extracted out of
                         buildPopulationPost(). Post length budgeting, description
                         shortening, and bill-link facet placement now live in ONE place
                         that every bot shares. buildPopulationPost() is now a thin wrapper
                         that supplies the population stat block.
src/fetchVotes.ts      — population bot: cache loading + population math + posting only.
src/fetchAgeVotes.ts   — NEW. age bot: same shape, age math instead.
```

`RawVote.members` carries every identifier both chambers publish (`bioguide`, `lisId`,
`state`, raw `voteCast`) so each bot can key off whichever it needs — the population bot uses
state/bioguide, the age bot uses bioguide/lisId. Adding a third bot is now: one calc module,
one entry point, one `.env` pair, one `render.yaml` service.

**Verified the refactor was behavior-preserving** before building on it: the 36 existing
`voteCalculations.test.ts` tests still pass unchanged (they exercise `buildPopulationPost`,
which now routes through `buildVotePost`), and a live `npm run fetch-votes` run produced the
same populations and the same post text as before.

### Age data source & the Senate ID problem
Birthdays come from `bio.birthday` in the same `congress-legislators` JSON already used for
the member→district map — no new data source, no API key. All 537 current members have a
birthday on file.

The catch: **the two chambers publish different member IDs.** House vote XML has BioGuide IDs
(`name-id`), but Senate vote XML has only `lis_member_id` — no BioGuide anywhere. So the age
cache indexes members by *both* (`id.bioguide` and `id.lis` from congress-legislators; all 100
senators have an LIS ID), and `lookupMemberAge()` tries BioGuide first, then LIS.

### Age caching + birthday invalidation
`data/member-ages.json` stores, per member: `birthday` (the source of truth), `age`, and
`ageValidUntil` — **the date the cached age goes wrong, i.e. their next birthday**.

This means the cache never needs a scheduled refresh just because time passed. On each run
`refreshStaleAges()` finds entries whose `ageValidUntil` has arrived, recomputes those ages
from the birthday already on disk, and writes the file back (logging a `🎂 Happy birthday`
line). A real refresh (`npm run refresh-ages`) is only needed when the **roster** changes —
new Congress, special elections — same cadence as `refresh-members`.

All date math is UTC so a machine's local timezone can't shift a birthday by a day. Feb 29
birthdays increment on Mar 1 in non-leap years, in both `calculateAge` and `nextBirthday`.

### Key files
```
src/ageCalculations.ts       — pure age math, aggregation, post formatting
src/ageCalculations.test.ts  — vitest unit tests
src/fetchAgeVotes.ts         — age bot pipeline (mirrors fetchVotes.ts)
data/member-ages.json        — age cache (gitignored — run `npm run refresh-ages` first)
```

### npm scripts
```
npm run fetch-ages     — fetch + print age analysis (no posting)
npm run post-ages      — fetch + post new votes to Bluesky (one-shot)
npm run watch-ages     — same, looping on POLL_INTERVAL_MINUTES
npm run refresh-ages   — refresh the member age cache only
npm run typecheck      — tsc --noEmit (see below)
```

### Typechecking now actually works
`npx tsc --noEmit` had never been clean — `@types/node` and `@types/xml2js` were simply not
installed, so every `fs`/`path`/`process`/`console`/`fetch` reference errored and the noise
made real type errors invisible. Everything runs through `tsx`, which strips types without
checking them, so nothing caught this. Both are now devDependencies and the whole project
typechecks clean via `npm run typecheck`.

### Verification (2026-07-28)
- `npm test` — 73 tests pass (36 existing population + 37 new age).
- `npm run typecheck` — clean across the whole project.
- `npm run fetch-votes` — population bot output unchanged after the refactor.
- `npm run fetch-ages` — live run against real 119th Congress data:
  - Senate #210: 51 + 43 members, every one matched (avg 64.6 yea vs. 65.3 nay).
  - House #283 (`Yea`/`Nay` bill vote): 232 + 188, all matched, bill link resolved.
  - House #282 (`Aye`/`No` resolution vote): 214 + 208 — matches the official totals, so the
    Aye/No normalization that once silently zeroed the population bot is handled here.
  - **Zero unmatched members on House votes**, vs. the population bot's usual 3. Non-voting
    delegates have birthdays in congress-legislators even though they have no district
    population, so the age bot covers members the population bot has to drop.
  - All sampled posts landed within the 300-grapheme limit (longest observed: exactly 300).

### Deployment

`render.yaml` gained an `age-bot` worker alongside `population-bot`, same shape (Starter plan,
1GB disk at `data/`, `npm run render-start-age`). It needs **no** `CENSUS_API_KEY` — only
`BLUESKY_AGE_HANDLE` / `BLUESKY_AGE_APP_PASSWORD`.

#### One Blueprint, many services (answered 2026-07-28)

**Each new bot is a new *service*, not a new *Blueprint*.** `render.yaml` is a single Blueprint
that defines a *list* of services; Render's existing Blueprint instance manages every service in
that one file. Adding a bot = appending one `- type: worker` block, nothing else.

How a new bot reaches production:
1. Merge the updated `render.yaml` into the branch the Blueprint tracks (`main`). Render sees
   nothing until it lands there — an unpushed branch is invisible to Render.
2. Render detects the diff and offers a Blueprint sync. Approve it; the new service is created.
   Existing services whose blocks didn't change are left alone (the `age-bot` commit left the
   `population-bot` block byte-identical, so the live population bot was untouched).
3. Enter the `sync: false` env vars on the new service in the Render dashboard. These do **not**
   come from local `.env` — that file only covers local runs.

#### Why each bot gets its own disk

Each bot needs its own `data/` — its own reference cache, its own `seen-votes-{botid}.json`, its
own `bluesky-session-{botid}.json`. On Render a disk attaches to exactly one service, so sharing
one between two workers isn't possible regardless. Both disks mount at the same *path*
(`/opt/render/project/src/data`), which is fine — different service instances, different disks.

First boot needs no hand-holding: the disk starts empty, so each `render-start-*` script runs its
cache refresh before entering the watch loop (`test -f <cache file> || npm run refresh-…`).

#### Cost

Render's free plan supports neither Background Workers nor disks, so every bot is a Starter
service: **~$7/mo + ~$0.25/mo disk, per bot.** This scales linearly — the four planned personas
would run ~$29/mo.

If that becomes the binding constraint, the alternative is folding multiple personas into a
single worker that polls votes once and posts to several accounts. The Phase-2 refactor already
makes this cheap: `voteSources.ts` does the fetching for everybody, and each bot is just a calc
module plus a thin entry point, so a combined runner would mostly be a loop over
`[{botId, analyze, buildPost}]`. Not built — noted as the escape hatch if per-bot cost matters
more than per-bot isolation (independent restarts, independent failure blast radius).

#### Bluesky account status

`.env` has `BLUESKY_AGE_HANDLE` / `BLUESKY_AGE_APP_PASSWORD` as of 2026-07-28, so local
`npm run post-ages` is unblocked. Still outstanding: the same two values on the Render service,
and the `age-bot` branch is local-only — not pushed, not merged, so not deployed. Nothing has
been posted to Bluesky from this branch.

---

## Known issues / future cleanup
- Senate post text sometimes verbose — question field can duplicate the description field
- 1 unmatched House member per vote (non-voting delegate) — acceptable, can be noted in posts
- Age bot uses each member's age **as of the run time**, not as of the vote date. Votes are
  fetched within minutes-to-hours of happening, so this only matters for a hypothetical
  backfill of old votes.

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
- ✅ Deploy config for population bot — `render.yaml` Blueprint (Background Worker + 1GB persistent disk mounted at `data/`, `npm run render-start` as start command). Render's free plan doesn't support Background Workers or disks, so this runs on the Starter plan (~$7/mo + ~$0.25/mo disk).
- ✅ Deployed to Render — live and posting as of 2026-07-27 (deployed in a separate session; confirmed by checking `@population.votesactually.com` directly, e.g. recent posts ~15 min old, including current Senate cloture/nomination votes).

**Status (2026-07-27):** Population bot is deployed and live on Render, posting automatically. Posting, dedupe, polling, post-length safety, and bill linking are all implemented and verified in production. Other bot personas (net worth, age, campaign contributions) are not yet started.

### Key files (added Phase 2)
```
src/bluesky.ts    — postToBluesky(botId, text, facets?): login/session persistence, posts
                    (with optional rich-text link facets), keyed per bot
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
