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

import { AtpAgent, type AtpSessionData } from "@atproto/api";
import * as fs from "fs";
import * as path from "path";

const MAX_POST_LENGTH = 300;

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

export function truncateForBluesky(text: string): string {
  if (text.length <= MAX_POST_LENGTH) return text;
  return text.slice(0, MAX_POST_LENGTH - 1) + "…";
}

export async function postToBluesky(botId: string, text: string): Promise<void> {
  const agent = await getAgent(botId);
  await agent.post({ text: truncateForBluesky(text), createdAt: new Date().toISOString() });
}
