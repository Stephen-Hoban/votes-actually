/**
 * bluesky.ts
 *
 * Minimal Bluesky posting client for the vote bots.
 * Persists each bot's login session to disk so repeated runs don't hit
 * Bluesky's login rate limit.
 *
 * Each bot has its own account, so credentials and env vars are keyed by
 * bot ID. For a bot with ID "population", requires in .env:
 *   BLUESKY_POPULATION_HANDLE
 *   BLUESKY_POPULATION_APP_PASSWORD
 * Create an app password at https://bsky.app/settings/app-passwords
 * (do not use your main account password).
 */

import { AtpAgent, type AppBskyRichtextFacet, type AtpSessionData } from "@atproto/api";
import * as fs from "fs";
import * as path from "path";
import {
  fitsInPost,
  graphemeLength,
  truncateToGraphemes,
  MAX_POST_LENGTH,
  type PostFacet,
} from "./voteCalculations.js";

function envPrefix(botId: string): string {
  return `BLUESKY_${botId.toUpperCase()}_`;
}

function sessionFile(botId: string): string {
  return path.join(process.cwd(), "data", `bluesky-session-${botId}.json`);
}

function loadSavedSession(botId: string): AtpSessionData | undefined {
  const file = sessionFile(botId);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

function saveSession(botId: string, session: AtpSessionData): void {
  const file = sessionFile(botId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
}

async function getAgent(botId: string): Promise<AtpAgent> {
  const prefix = envPrefix(botId);
  const handle = process.env[`${prefix}HANDLE`]?.replace(/^@/, "");
  const password = process.env[`${prefix}APP_PASSWORD`];
  if (!handle || !password) {
    throw new Error(
      `Missing ${prefix}HANDLE or ${prefix}APP_PASSWORD in .env. ` +
        "Create an app password at https://bsky.app/settings/app-passwords."
    );
  }

  const agent = new AtpAgent({
    service: "https://bsky.social",
    persistSession: (_evt, session) => {
      if (session) saveSession(botId, session);
    },
  });

  const saved = loadSavedSession(botId);
  if (saved) {
    try {
      await agent.resumeSession(saved);
      return agent;
    } catch {
      console.warn(`  ⚠️  Saved Bluesky session for "${botId}" expired, logging in fresh.`);
    }
  }

  await agent.login({ identifier: handle, password });
  return agent;
}

// Callers (e.g. buildPopulationPost) should already shorten text to fit.
// This is a last-resort safety net so postToBluesky never sends something
// Bluesky will reject or mangle — if it actually triggers, that's a sign
// the caller's own shortening logic missed a case. Facets are dropped in
// that case since their byte ranges are no longer trustworthy once the
// text has been blindly sliced.
export function truncateForBluesky(text: string): string {
  if (fitsInPost(text)) return text;
  console.warn(
    `  ⚠️  Post exceeds Bluesky's ${MAX_POST_LENGTH}-grapheme limit (${graphemeLength(text)} graphemes); truncating as a last resort.`
  );
  return truncateToGraphemes(text, MAX_POST_LENGTH - 1) + "…";
}

function toAtprotoFacets(text: string, facets: PostFacet[]): AppBskyRichtextFacet.Main[] {
  if (!fitsInPost(text)) return []; // ranges aren't trustworthy once truncateForBluesky rewrites the text
  return facets.map((f) => ({
    index: { byteStart: f.byteStart, byteEnd: f.byteEnd },
    features: [{ $type: "app.bsky.richtext.facet#link", uri: f.uri }],
  }));
}

export async function postToBluesky(botId: string, text: string, facets: PostFacet[] = []): Promise<void> {
  const agent = await getAgent(botId);
  const atprotoFacets = toAtprotoFacets(text, facets);
  const finalText = truncateForBluesky(text);
  await agent.post({
    text: finalText,
    facets: atprotoFacets.length > 0 ? atprotoFacets : undefined,
    createdAt: new Date().toISOString(),
  });
}
