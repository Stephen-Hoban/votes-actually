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
data/                  — cached reference data (committed since 2026-08-03; see below)
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
~~The `data/` directory is gitignored. Anyone cloning the repo or starting fresh must run
`npm run refresh-cache` first.~~ **Changed 2026-08-03:** the four reference caches are now
committed to the repo, so a fresh clone works immediately — GitHub Actions containers depend on
this. `data/` is otherwise still ignored (see `.gitignore`, which is an allowlist). If a cache
file is ever missing the script still exits with a clear error directing you to
`npm run refresh-cache`.

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

### CI enforcement (added 2026-08-04)
`.github/workflows/ci.yml` runs `npm run typecheck` and `npm test` on every pull request and
on every push to `main`. Before this, the suite existed but nothing ran it — a PR could merge
with failing tests and the bots would post wrong numbers on the next cron tick, which is
exactly the failure mode the tests were written to prevent. Actions minutes are free and
unlimited on public repos, so running this on every PR costs nothing.

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
data/member-ages.json        — age cache (committed since 2026-08-03)
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

> **Superseded 2026-08-03.** The Render Blueprint below was replaced by GitHub Actions; the
> section is kept because the reasoning about per-bot isolation still explains the current
> design. The age bot now runs from `.github/workflows/age-bot.yml`. It still needs **no**
> `CENSUS_API_KEY` — only `BLUESKY_AGE_HANDLE` / `BLUESKY_AGE_APP_PASSWORD`, plus the shared
> `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`.

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
would run ~$29/mo. Confirmed directly against Render's own docs (2026-08-03), not just the
arithmetic above: `render.com/docs/free` states Background Workers and disks are both
paid-only ("Other service types don't support Free instances"; "Free web services cannot"
attach a disk), and `render.com/docs/disks` confirms a disk is single-service-only ("accessible
by only a single service instance") — so per-bot disks aren't just today's choice, they're the
only option on this platform. The $7/mo Starter figure is first-party confirmed
(`render.com/articles/render-vs-railway`); the $0.25/GB disk figure is corroborated by several
third-party pricing trackers but not pulled directly off Render's own (JS-rendered) pricing
page.

**The "combined worker" idea below was considered and rejected** in favor of the hosting
change in the next section — see that section for why.

~~If that becomes the binding constraint, the alternative is folding multiple personas into a
single worker that polls votes once and posts to several accounts. The Phase-2 refactor already
makes this cheap: `voteSources.ts` does the fetching for everybody, and each bot is just a calc
module plus a thin entry point, so a combined runner would mostly be a loop over
`[{botId, analyze, buildPost}]`.~~ Rejected (2026-08-03): merging bots into one process trades
four small failure domains for one large one, concretely —
- `runOnce()`'s `process.exit(1)` on cache-load failure or any uncaught error
  (`src/fetchVotes.ts`, main-loop catch block) would kill every bot's process at once instead of
  just the failing one.
- Sequential polling means one bot's slow/hung fetch delays every bot queued behind it in the
  same cycle.
- One combined service means one shared credential set (all Bluesky app passwords + Census key
  in one env), one shared 512MB/0.5CPU budget across all bots' XML parsing, one restart/deploy
  domain (a change to bot #4 forces downtime for the stable, already-live population bot too),
  and interleaved logs that make per-bot failures harder to attribute.

#### Hosting decision: GitHub Actions cron replaces the always-on worker (implemented 2026-08-03)

The real fix isn't consolidating bots onto one always-on process — it's not paying for an
always-on process at all. This workload is a few seconds of work every 15 minutes; Render (and
the rejected combined-worker idea) both bill for a service that's idle >99% of the time.

**Setup as built:** one GitHub Actions scheduled workflow per bot, each running the existing
one-shot `npm run post-votes` / `npm run post-ages` (no `--watch` flag needed — the platform's
scheduler replaces `setInterval`/`sleep()` in `src/fetchVotes.ts`/`src/fetchAgeVotes.ts`; the
flag still exists for local use). This keeps every bot in its own isolated job/run — the same
failure-isolation property the two Render services had. No porting was required: `tsx`,
`xml2js`, and the `fs`-based reference-cache reads are untouched, since a workflow step is just
the existing npm script.

Crons are deliberately offset from the quarter-hour and staggered between bots
(`2,17,32,47` for population, `7,22,37,52` for age). `:00`/`:15`/`:30`/`:45` are the most
contended slots on GitHub's scheduler and queue behind platform load; an odd offset reduces
that delay. Each workflow also has a `concurrency` group so two runs of the same bot can never
overlap.

Tradeoff accepted: GitHub Actions cron timing can slip several minutes under platform load.
Fine for "post within ~15-20 min of a vote," confirmed acceptable for this project (2026-08-03).

##### Cost correction: this is only ~$0 because the repo is public (2026-08-03)

The earlier claim that Actions would be "well under the free-minute allowance for private repos
at this frequency, since each run is seconds long" was **wrong**, and the error mattered enough
to change a decision. GitHub meters Actions at the **job** level and rounds each job **up to the
nearest whole minute** — a 20-second job bills as 1 minute. At 2 bots × 96 runs/day that's
~5,760 billed minutes/month against GitHub Free's **2,000 minutes/month** for private repos.
Even ignoring the rounding, ~40s of real work per run still lands around 3,840 min/month. Either
way it overshoots, and the overage (~$0.006/min for a Linux 2-core runner) would have run
**~$23-35/mo — more than the $14.50/mo Render setup this migration was meant to escape.**

**Actions minutes are unlimited and free on public repositories**, so the repo was made public
(2026-08-03) and the ~$0 figure holds — including headroom for the two remaining planned bots.
This was safe to do: the git history never contained `.env` or `data/` (verified before
flipping), all credentials live in GitHub Secrets, and everything the bots read is public
government data. **If the repo is ever made private again, both bots must drop to roughly a
45-minute cadence or the account starts accruing overage charges.**

Sources: [Actions billing](https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions),
[runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing).

##### The 60-day scheduled-workflow gotcha

GitHub **disables scheduled workflows after 60 days with no commits to the repo** — which would
silently stop both bots with no error anywhere. `refresh-caches.yml` runs monthly and commits
any changed reference data, which both keeps the caches current and keeps the repo active. Worth
knowing about anyway: if the bots ever go quiet, check the Actions tab for a disabled-workflow
banner before debugging the code.

**Durable storage: Supabase (Postgres, free tier)** for the two things that actually mutate
per-run and must survive between the now-ephemeral scheduled containers:
- `seen-votes-{botid}.json` → `seen_votes(bot_id, vote_id, posted_at)`, primary key
  `(bot_id, vote_id)`.
- `bluesky-session-{botid}.json` → `bluesky_sessions(bot_id, session_json, updated_at)`,
  avoids relogin rate-limiting across runs.

Both tables have RLS enabled with **no policies**: the `service_role` key the bots use bypasses
RLS, so nothing else can reach the data — a leaked anon key exposes nothing. Schema lives in
`db/schema.sql`, idempotent and safe to re-run.

##### Why dedupe became claim-based, not load-a-Set/save-a-Set

The original plan said "call sites in `fetchVotes.ts`/`fetchAgeVotes.ts` don't change." They had
to. The old `loadSeenVotes()` → mutate a `Set` → `saveSeenVotes()` shape has a read-modify-write
race baked in: two overlapping runs both read a set lacking vote X, both post X, and the second
write clobbers the first. Keeping that shape and merely swapping `fs` for Postgres would have
moved the race, not fixed it — and the whole reason this state went to a database was that a
duplicate post is public and irreversible.

So `seenVotes.ts` now exposes `claimVote(botId, voteId)` / `releaseVote(botId, voteId)`. A bot
**INSERTs the row before posting** and lets the primary key arbitrate: a unique violation means
someone else owns that vote, so this run skips it. Exactly one caller can ever win, and the
guarantee is the database's, not the loop's. On a failed post the claim is released so a later
run retries. The call-site change is ~6 lines per bot.

(Note the original rationale — "separate bots' Actions jobs run concurrently" — wasn't the actual
risk: separate bots use different `bot_id`s and different accounts, so they can't collide. The
real exposure is one bot's run overlapping *itself*, e.g. a slow run still going when the next
cron fires. The `concurrency` group in each workflow makes that unlikely; the primary key makes
it impossible.)

This isn't a new dependency invented for this problem — `src/seenVotes.ts`'s own header already
flagged "Supabase migration still open for later" (Phase 2), and Phase 3's website was already
planned to use Supabase as its database. Building it now means building it once for both.

**Explicitly NOT moved to Supabase:** the slow-changing reference caches
(`state-populations.json`, `district-populations.json`, `member-districts.json`,
`member-ages.json`). These only change on the `refresh-*` cadence (Census updates, new
Congress, special elections) — they're build artifacts, not runtime state, and forcing them
into a database buys nothing. They are now **committed to the repo**, so a scheduled container
gets them from `actions/checkout` with no Census refresh per run.

`.gitignore`'s `data/` rule became an **allowlist** to make this safe: `data/*` stays ignored and
the four cache files are individually un-ignored. A denylist would have risked
`bluesky-session-*.json` — which holds live auth tokens — reaching a public repo the first time
someone added a new file under `data/`.

Because Render's disk-based start scripts used to rebuild caches on first boot and nothing else
would now, `refresh-caches.yml` (manual `workflow_dispatch` + monthly cron) re-runs
`npm run refresh-cache` and commits any diff. Without it the member→district map would silently
go stale after a special election and votes would start coming back unmatched.

Known tradeoffs: a new network dependency per run (if Supabase is unreachable, `claimVote()`
throws and the cycle aborts — skip-posting rather than post-and-risk-a-duplicate, consistent with
this project's fail-loud philosophy, see the Aye/No bug above); one more secret (Supabase service
key); Supabase's free tier auto-pauses after 7 days idle, not a concern at a 15-minute cadence.

**Status: built, and the dedupe guarantee verified against the live database (2026-08-04).**
`npm run typecheck` clean, 73/73 tests pass, and live non-posting runs of both bots
(`fetch-votes`, `fetch-ages`) produce unchanged output against real 119th Congress data. The
Supabase-missing path throws before any post is attempted.

The atomicity claim was tested for real, not just reasoned about — against the live Supabase
project, with test rows cleaned up afterwards:
- an already-posted vote is refused (`claimVote` → `false`)
- a fresh vote is claimable exactly once (`true`, then `false`)
- **5 parallel `claimVote` calls for the same vote → exactly 1 winner**
- `releaseVote` makes a vote retryable again

Still not verified in production (nothing has been posted through the new path) — see cutover
ordering below.

##### Cutover ordering (matters — both Render services were live)

Render workers dedupe against their disk; Actions runs dedupe against Supabase. **While both are
running they share no dedupe store, so every vote gets posted twice.**

**The local seen-votes files are NOT the authoritative record (discovered 2026-08-04).** Migrating
them is necessary but nowhere near sufficient. `data/seen-votes-population.json` was last written
**2026-07-08**; the bots have been live on Render since **2026-07-27**, writing to their own
persistent disks ever since. Checked directly: the local file holds `senate-119-2-00001…00005` and
`house-2026-229…233`, while the pipeline currently fetches `senate-119-2-00214…00218` and
`house-2026-279…283` — **zero overlap**. The age bot is worse: it has no local file at all, so
migration seeds it with nothing.

Left uncorrected, the first Actions run would have found none of the current votes in `seen_votes`,
concluded all 10 were new, and re-posted every one — publicly and irreversibly, on both accounts.

Fix: `npm run baseline-seen -- <botId>` (`src/baselineSeenVotes.ts`) fetches the votes the pipeline
currently returns and marks them seen **without posting anything**. Its failure direction is
deliberate — baselining can only cause a vote to be skipped, never double-posted. If Render hadn't
yet posted one of them, that post is silently lost, which is the recoverable direction.

Correct order — **suspend before baselining**, or a vote Render posts in between lands in nobody's
dedupe store and gets posted twice:
1. Run `npm run migrate-supabase` once (Bluesky sessions + whatever historical IDs exist locally).
2. **Suspend both Render services** in the Render dashboard.
3. `npm run baseline-seen -- population` and `npm run baseline-seen -- age`.
4. Only then let the Actions workflows run (merging to `main` is what activates the crons; or
   trigger one manually via `workflow_dispatch`).
5. Confirm on Bluesky, then delete the Render services.

If exact fidelity matters more than simplicity, the alternative is pulling the real
`seen-votes-*.json` off each Render disk via Render's shell before suspending. Baselining was
chosen instead: simpler, and its worst case is a missed post rather than a duplicate.

##### Node 20 is EOL — the runtime moved to 24 (2026-08-04)

`npm run migrate-supabase` failed on first use with "Node.js 20 detected without native WebSocket
support." `createClient()` builds a `RealtimeClient` eagerly and resolves its WebSocket transport
in the constructor, so on a runtime with no global `WebSocket` it throws before any query runs —
even though this project never opens a Realtime channel. Node added a global `WebSocket` in 22.

Two things came out of it:
- `ws` is now a dependency, passed as `realtime.transport` in `src/supabase.ts`. Three lines, works
  on every Node version, opens no socket. Removable once the floor is Node 22+ everywhere.
- **Node 20 reached end of security support on 2026-04-30** — the project was three months past EOL.
  The workflows now pin **Node 24** (Active LTS, supported to April 2028). Local dev is still on
  20.20.1, which `ws` keeps working; worth upgrading locally when convenient.

Considered and rejected: dropping `@supabase/supabase-js` for `@supabase/postgrest-js`, which is
the exact subset used here (no Auth, Realtime, Storage, or Functions) and would sidestep the
WebSocket path entirely. Rejected to stay on the package all Supabase documentation assumes, which
matters more for Phase 3's website than saving one dependency.

##### Testing gap

The Supabase layer (`supabase.ts`, the rewritten `seenVotes.ts`/`bluesky.ts` I/O) has **no unit
tests** — it's network glue, and testing it meaningfully needs either mocks that assert nothing
real or a live test project. The pure calculation logic that the 73 tests cover is unchanged and
still passes. The claim/release atomicity rests on the database primary key, which is enforced by
Postgres rather than by code that could regress. Worth revisiting if this layer grows.

#### Bluesky account status

`.env` has `BLUESKY_AGE_HANDLE` / `BLUESKY_AGE_APP_PASSWORD` as of 2026-07-28, so local
`npm run post-ages` is unblocked. ~~Still outstanding: the same two values on the Render service,
and the `age-bot` branch is local-only.~~ Resolved: `age-bot` merged to `main` (PR #5), and both
bots' credentials now live in **GitHub Secrets** rather than on a Render service. Required
secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `BLUESKY_POPULATION_HANDLE`,
`BLUESKY_POPULATION_APP_PASSWORD`, `BLUESKY_AGE_HANDLE`, `BLUESKY_AGE_APP_PASSWORD`,
`CENSUS_API_KEY` (the last one only used by `refresh-caches.yml`).

---

## Net worth bot (2026-08-11)

The third bot persona (`@networth.votesactually.com`) posts the **average and median net worth
of the members who voted yea vs. nay**, in the same post shape as the population and age bots.

It reuses the Phase-2 refactor exactly as intended — `voteSources.ts` does the fetching,
`buildVotePost()` does the layout — so the bot itself is one calc module plus one entry point.
**Almost all the work in this bot is the data, not the bot.**

### The data problem (this is the important part)

Unlike population (Census API) and age (a `birthday` field sitting in JSON we already fetch),
**there is no free, machine-readable source of congressional net worth.** Verified 2026-08-05:

- **OpenSecrets**, historically the only organisation publishing pre-computed net worth
  estimates, returns **HTTP 403** behind a Cloudflare challenge, and its `robots.txt`
  explicitly disallows `ClaudeBot`/`GPTBot`/`CCBot` plus `/api` and `/export_data`. That is a
  policy signal, not just a technical one, and was not worked around. Their figures also stop
  at 2018, so they wouldn't have been current enough anyway.
- Every congressional-finance repo on GitHub (`house-stock-watcher`, `senate-stock-watcher`,
  and the various trading trackers) parses **Periodic Transaction Reports** — individual stock
  trades — never a cumulative holdings figure. They cannot answer "what is this member worth."
- `congress-legislators` carries `id.opensecrets` (523/537), `id.fec`, `id.govtrack`,
  `id.icpsr` — good join keys, but no financial data of its own.

So the figures are derived from the primary sources, which do work and need no API key:

| Chamber | Source | Format |
|---|---|---|
| House | `disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.zip` → index XML → `{year}/{DocID}.pdf` | Per-filer PDF, text-extractable |
| Senate | `efdsearch.senate.gov` (CSRF token → ToS POST → session cookie → JSON search → report HTML) | HTML tables |

### Why the House PDFs are parseable at all

Each Schedule A row contains **two** dollar ranges — the asset's value *and* the income it
produced — and Schedules B/C/D use the same `$X - $Y` format. A regex over flattened text
double-counts income as assets and silently inflates every member.

They're separable because the columns are at fixed x-coordinates. Measured on Pelosi's 2025
filing (DocID 10075701):

```
x=280  "$5,000,001 -"    ← Value of Asset
x=280  "$25,000,000"
x=445  "$100,001 -"      ← Income  (must NOT be counted)
x=445  "$1,000,000"
```

`pdfjs-dist` exposes those coordinates (`item.transform[4]`/`[5]`); the parser locates the
column headers per page and assigns each dollar item to the nearest column. Note a bracket is
routinely **split across two lines** at the same x, so vertically adjacent items in a column
are rejoined before parsing.

**Rejected: microsoft/markitdown.** It's Python (this project is Node-on-Actions), and its PDF
path is a plain text extractor — layout-aware extraction requires the paid Azure Document
Intelligence backend. It would discard exactly the x-coordinates the parse depends on, making
the job harder, not easier.

### Methodology (decided 2026-08-11) — every number here is an estimate

Disclosure law (Ethics in Government Act) requires only **bracketed ranges**, never exact
figures, so a "net worth" number is always derived. The choices made:

- **Assets minus liabilities, kept as a range end to end.** `netWorthLow`/`netWorthHigh` are
  the summed bracket bounds; `netWorth` is their midpoint and is the only place a range
  collapses to a number. The bounds cross over deliberately (`low = assets.low −
  liabilities.high`) so the range doesn't look more precise than the source supports.
- **Spouse and joint holdings are included.** Not optional in practice: nearly every asset on
  Pelosi's filing is coded `SP` or `JT`, and excluding them would report her as worth roughly
  nothing. This matches what OpenSecrets did.

  A caveat found while building this, and **corrected before it made it into the design**: the
  Senate has an "Over $1,000,000 and held independently by spouse or dependent child" category
  (the 5 U.S.C. app. §102(e) spousal-privacy carve-out), which looked at first like a hard
  ceiling that would systematically understate senators with wealthy spouses relative to
  representatives. It isn't. Measured across 298 spouse-owned rows in a six-filer sample, only
  50 used it — **all belonging to a single filer** — while other senators' spouses had
  above-$1M holdings reported in ordinary fine-grained brackets. It is an *optional per-asset
  election*, not a form-imposed cap. Whether House filers have and use the same option is
  **unverified**; do not reason from a cross-chamber asymmetry here without checking first.
- **The open-ended top bracket ("Over $50,000,000") counts as $50,000,001.** It has no
  midpoint, so every figure derived from it is a *floor*, not a central estimate. Members at
  the top of the scale are therefore systematically understated.
- **Median is published alongside the average.** Congressional wealth is extremely top-heavy;
  a mean is dominated by a handful of very rich members and can swing by millions when one
  changes sides. The gap between the two is itself the signal.
- **Report-year backfill.** The annual report filed each May covers the *previous* calendar
  year, and many members take an extension (in the 2025 index: **226 annual originals against
  714 extensions**). The refresh starts at the most recent year for freshness, then backfills
  anyone still missing from the year before, which is complete. Each member's own
  `disclosureYear` records which year they came from.

### Joining filings to votes

Neither chamber keys filings by BioGuide, but the vote XML does (House) or by LIS ID (Senate).
`disclosureJoin.ts` bridges them, and is deliberately conservative because **a wrong match
doesn't error — it publishes one member's wealth under another's vote**:

- House filings match on **state + district first** (one seat, one member), then the surname
  must agree. A district whose surname disagrees is a *former* member's filing (special
  election) and is dropped, not guessed at.
- Senate filings match on surname within the chamber, narrowed by given name then state.
- Anything still ambiguous is reported and dropped. Name normalization folds accents
  (`Velázquez`/`Velazquez`), strips punctuation and honorifics/suffixes **positionally only**,
  and matches compound surnames on their final token (`Wasserman Schultz` ↔ `Schultz`).
  It explicitly does **not** do edit-distance matching — `Miller`/`Milller` being one typo
  apart is not evidence of identity.

### Five silent-zero bugs, and why they're the whole story of this bot

Every serious bug found while building the disclosure pipeline had the same shape: **a failure
that produces a plausible number instead of an error.** None crashed, none logged a warning,
and the two worst were caught only by inspecting the finished cache rather than by reading a
run that looked clean.

| Bug | Effect | How it was caught |
|---|---|---|
| Senate section regex double-escaped (caller pre-escaped, `sectionSlice` escaped again) | **All 95 senators = $0**, reported as "88 parsed, 0 skipped, 0 unparsed rows" | Full-run cache inspection; independently by prototype comparison |
| Bracket split across a *page* boundary (merge required same page) | Dropped one of Pelosi's Schedule D liabilities | Hand-summing her 11 liability rows against the parser's output |
| Page furniture ("Filing ID #…", footnote URLs) landing inside column tolerance | 1 phantom unparsed row on ~416 of ~450 filers | Cross-checking sample filers |
| `parseBracket` rejected exact figures with cents (`"$226,776.00"`) | One filer silently lost 8 liability rows totalling ~$3.67M | Reading the unparsed-row log *after* it was changed to print the offending text |
| Scanned paper filings extract 0 text items | **33 members counted as genuinely worth $0**, dragging every published average down | Noticing those filers shared an anomalous DocID range (`9116xxx`) |

Two lessons worth keeping:

1. **A count is not a diagnostic.** "1 unparsed row" appeared on nearly every filing and was
   unactionable — it could equally have been a header artifact or a dropped six-figure asset.
   Changing the log to print the offending *text* turned an ignorable warning into a bug report
   within one run, and immediately exposed the cents bug. `sumColumn` returns `unparsedTexts`
   for this reason; don't reduce it back to a tally.
2. **"No data" and "zero" must never be the same value.** Three of the five bugs were some
   variant of a lookup failing and returning `0`. The fixes are all the same shape: fail loudly
   and drop the filer, so the damage shows up as *lower coverage* (visible, guarded) instead of
   as a *lower average* (invisible, published). `parseAnnualReportHtml` throws on a missing
   Part 3 heading; `parseFilingPdf` throws on zero extractable text; `parseBracket` returns
   `null` rather than a zero bracket.

Note the House filings that legitimately read $0 — Frost, Valadao, García, Crawford — are
distinguished by having *text* that says "None disclosed." The test is text vs. no text, never
zero vs. non-zero.

### The coverage guard

Disclosure coverage isn't guaranteed the way birthdays are. `MIN_COVERAGE = 0.8`: if fewer
than 80% of a vote's yea/nay voters have a figure on file, the bot **skips that vote entirely
and says why**, rather than publishing an average over half a chamber and calling it "the
average net worth of the members who voted yea." The skip happens *before* `claimVote()`, so a
later run with a refreshed cache can still post it.

**Measured coverage as built (2026-08-11):** 460 of 537 sitting members (85.7%) have a usable
disclosure. Per-vote that lands at **~94.9% on Senate votes** and **~83.4% on House votes** —
both clear the guard, but the House only by ~3 points. If a future refresh loses ground (more
paper filers, a format change), the House side goes quiet rather than posting bad numbers.
That's the intended trade, but it means **a silent bot is a symptom to investigate, not a
sign nothing is happening.** Check the refresh log's coverage line first.

**The missing ~15% is not a random sample**, and this is the caveat most likely to matter. It
is disproportionately: members who filed on paper (scanned, unparseable), members who took a
filing extension and haven't filed yet, and members newly seated. If any of those correlate
with wealth — and paper filing plausibly correlates with seniority, which correlates with
wealth — then the published averages carry a selection bias whose direction and size are
**unmeasured**. Nothing in the pipeline corrects for it and no claim here should be read as
if it did.

### Cache freshness — the one real difference from the age bot

A stale age recomputes itself from the birthday already on disk. **A stale net worth cannot** —
it needs a new disclosure. So `member-networth.json` entries carry `validUntil`
(`NET_WORTH_REFRESH_DAYS = 90`), `findStaleNetWorths()` only *reports*, and the bot warns
loudly and keeps posting: a quarter-old figure is still the most recent one that exists, and
going silent would be worse. `refresh-networth.yml` is what actually renews it.

### Key files
```
src/disclosureBrackets.ts   — bracket string → numeric range; sum; assets − liabilities
src/disclosureTypes.ts      — RawDisclosure contract shared by both chamber scrapers
src/disclosureHouse.ts      — House ZIP index + PDF parsing (pdfjs-dist, column-aware)
src/disclosureSenate.ts     — Senate eFD session/CSRF flow + report HTML parsing
src/disclosureJoin.ts       — filing → BioGuide matching (pure, heavily tested)
src/netWorthCalculations.ts — net worth math, mean/median aggregation, post formatting
src/fetchNetWorthVotes.ts   — net worth bot pipeline (mirrors fetchAgeVotes.ts)
src/debug/diagHouse.ts      — dumps one filing's unparseable column cells
src/debug/dumpPdfText.ts    — dumps one filing's raw extracted text (scanned vs. text)
data/member-networth.json   — the quarterly cache (committed)
```

The two `src/debug/` scripts are kept deliberately. When a refresh reports unparsed rows or a
suspicious zero, pointing them at a single DocID is the fastest way to tell a harmless artifact
from a real dropped asset — that is exactly how the cents bug and the scanned-filing bug were
identified. They read `disclosureHouse.ts`'s `__debug__` export, which nothing in `src/` imports.

```bash
npx tsx src/debug/diagHouse.ts    https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2025/10075701.pdf
npx tsx src/debug/dumpPdfText.ts  https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2025/9116162.pdf
```

### npm scripts
```
npm run fetch-networth     — fetch + print net worth analysis (no posting)
npm run post-networth      — fetch + post new votes to Bluesky (one-shot; what Actions runs)
npm run watch-networth     — same, looping on POLL_INTERVAL_MINUTES
npm run refresh-networth   — rebuild the net worth cache from the disclosures
```

### Deployment
`.github/workflows/networth-bot.yml`, cron `12,27,42,57` — staggered five minutes off the age
bot and ten off population, same reasoning as those files. Needs `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `BLUESKY_NETWORTH_HANDLE`, `BLUESKY_NETWORTH_APP_PASSWORD`. No Census
key.

`.github/workflows/refresh-networth.yml` rebuilds the cache quarterly (Feb/May/Aug/Nov, 120-min
timeout — it's hundreds of PDFs). `refresh-caches.yml` was changed to pass explicit
`--census --members --ages` flags, because a bare `npm run refresh-cache` now includes the net
worth rebuild and that must not run monthly.

### Verification (2026-08-11)
- `npm run typecheck` clean; `npm test` 211 tests pass (73 pre-existing + 138 new across
  net worth, brackets, and the join).
- `npm run refresh-networth` run end-to-end against live sources three times, fixing the bugs
  above between runs. Final cache: 460 members (95 Senate, 365 House), 85.7% roster coverage,
  21 members with any unparsed row, 4 legitimate zeros.
- Spot-checked against independently known facts: Jim Justice ($1.30B) tops the list, then
  Rick Scott ($479M), Issa ($282M), Ricketts ($271M), Buchanan ($193M), Pelosi ($142M). Median
  across all members is $1.6M, in line with commonly reported congressional medians. AOC at
  $16.5K and Sanders at $979K are plausible and correctly ordered.
- Pelosi's Schedule D liabilities were hand-transcribed from the raw PDF text and summed by
  hand ($61,250,011–$152,500,000) — matches the parser exactly.
- `npm run fetch-networth` live against real 119th Congress votes, both chambers: Senate votes
  ~94.9% coverage, House ~83.4%, every post inside the 300-grapheme limit (longest exactly
  300, with description shortening and the congress.gov facet both intact), and the Aye/No
  resolution vote (House #282, 214-208) matches official totals.

### Legal note
Title I of the Ethics in Government Act (5 U.S.C. app. §105(c)) makes it unlawful to obtain or
use **Senate** financial disclosure reports for commercial purposes, credit rating, or
political/charitable solicitation. A non-commercial public-interest bot is the use the statute
contemplates, but this is statutory rather than boilerplate ToS — it constrains what this
project may become, not just how it fetches.

---

## Known issues / future cleanup
- Senate post text sometimes verbose — question field can duplicate the description field
- 1 unmatched House member per vote (non-voting delegate) — acceptable, can be noted in posts
- Age bot uses each member's age **as of the run time**, not as of the vote date. Votes are
  fetched within minutes-to-hours of happening, so this only matters for a hypothetical
  backfill of old votes.
- Net worth figures are **structurally understated at the top**: the open-ended "over
  $50,000,000" bracket is counted as $50,000,001, so the wealthiest members — the ones that
  move an average most — are floored rather than estimated.
- Disclosed assets are **not** net worth: personal residences (unless income-producing) and
  federal retirement accounts are excluded from filings entirely, and home mortgages are
  excluded from the liability side. The figure is "disclosable wealth", not wealth.
- Net worth is up to ~20 months stale by construction (annual report filed in May covers the
  previous calendar year, and extensions push some members later still). Fine for a "who is
  wealthier" comparison, wrong for anything claiming to be current.
- The Senate eFD scrape depends on an undocumented CSRF/session flow with no API contract, so
  it can break without notice. Every POST also needs a hand-set same-origin `Referer` header or
  Django 403s it — `fetch` never sends one. The failure is visible (coverage drops, the bot
  skips Senate votes) rather than silent.
- **Heavily-leveraged members can show a large negative midpoint** — Ken Calvert lands at
  −$38.5M from a range of −$92.6M to +$15.6M. This is partly real (large disclosed mortgages)
  and partly an artifact: an open-ended *asset* bracket is floored at $50,000,001, while
  bracketed *liabilities* contribute their full upper bound. So a wealthy borrower's assets are
  understated while their debts are not. The published range makes this visible; the midpoint
  alone does not.
- Coverage is ~15% short of the full roster and **the gap is not random** — see the coverage
  guard section. Treat cross-chamber comparisons especially carefully, since Senate coverage
  (94.9%) is much better than House (83.4%).

---

## Phase 2: Build the bots

**Goal:** Post to Bluesky automatically when a new vote is detected.

### Steps
- ✅ Fix `HOUSE_YEAR` and `SENATE_SESSION` hardcoded values — replaced with auto-detection
- ✅ Set up Bluesky account for the population bot (subdomain handle, DNS TXT verified)
- ✅ Format posts per bot persona — population bot done (`buildPopulationPost()` in `fetchVotes.ts`); other personas still need their own post-formatting functions
- ✅ Add vote polling loop — `--watch` flag (`npm run watch-votes`) re-runs the fetch/post cycle on an interval (`POLL_INTERVAL_MINUTES`, default 15) instead of a separate cron-triggered process
- ✅ Store seen vote IDs to avoid duplicate posts — `src/seenVotes.ts`, local JSON per bot (`data/seen-votes-{botid}.json`), Supabase migration still open for later
- Set up remaining Bluesky accounts as each bot is built (one per bot persona) — population, age, and net worth done; campaign contributions outstanding
- ✅ ~~Deploy config for population bot — `render.yaml` Blueprint~~ **Superseded 2026-08-03:** `render.yaml` deleted, replaced by one GitHub Actions scheduled workflow per bot. See "Hosting decision" above.
- ✅ Deployed to Render — live and posting as of 2026-07-27 (deployed in a separate session; confirmed by checking `@population.votesactually.com` directly, e.g. recent posts ~15 min old, including current Senate cloture/nomination votes). **Migrated off Render 2026-08-03.**
- ✅ Migrated hosting to GitHub Actions + Supabase (2026-08-03) — built and locally verified; production cutover follows the ordering documented above.

**Status (2026-08-11):** Population, age, and net worth bots run from GitHub Actions on a ~15-minute schedule, with dedupe and Bluesky sessions in Supabase. Posting, dedupe, polling, post-length safety, and bill linking are all implemented. The remaining persona (campaign contributions) is not yet started.

The "adding a bot is a calc module, an entry point, an `.env` pair, and one workflow file" claim held up for the net worth bot — but only for the *bot*. Its analysis needed a whole data pipeline of its own (disclosure scraping, PDF parsing, name→BioGuide joining), which was ~5x the code of the bot itself. Worth expecting the same for the campaign-contributions persona: the FEC has an actual API, so it should land closer to the age bot than to this one.

### Key files (added Phase 2)
```
src/bluesky.ts    — postToBluesky(botId, text, facets?): login/session persistence, posts
                    (with optional rich-text link facets), keyed per bot
src/seenVotes.ts  — claimVote/releaseVote(botId, voteId): per-bot dedupe, atomic via
                    the seen_votes primary key
```

### Key files (added in the Actions/Supabase migration)
```
src/supabase.ts           — shared secret-key client, lazily constructed
src/migrateToSupabase.ts  — one-time: local seen-votes/session files → Supabase
src/baselineSeenVotes.ts  — mark currently-fetched votes as seen without posting
                            (cutover safety — see "Cutover ordering")
db/schema.sql             — the two tables + RLS lockdown (idempotent)
.github/workflows/        — population-bot.yml, age-bot.yml, refresh-caches.yml
```

### npm scripts (added Phase 2)
```
npm run post-votes       — fetch-votes + post any new votes to Bluesky (one-shot; this is
                           what the GitHub Actions workflow runs)
npm run watch-votes      — same, but loops forever on POLL_INTERVAL_MINUTES (default 15).
                           No longer used in deployment — kept for local testing.
npm run migrate-supabase — one-time: push local seen-votes/session files into Supabase
npm run baseline-seen -- <botId>
                         — mark the currently-fetched votes as seen for a bot,
                           posting nothing (run after suspending Render)
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
