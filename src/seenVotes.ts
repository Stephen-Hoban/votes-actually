/**
 * seenVotes.ts
 *
 * Tracks which vote IDs a given bot has already posted, so re-running the
 * pipeline (e.g. on a cron schedule) never double-posts the same vote.
 * Local JSON to start; can move to Supabase later without changing callers.
 */

import * as fs from "fs";
import * as path from "path";

// Bounds the file size — at 10 votes fetched per run, this comfortably
// covers months of history without growing unbounded.
const MAX_SEEN_IDS = 1000;

function seenFile(botId: string): string {
  return path.join(process.cwd(), "data", `seen-votes-${botId}.json`);
}

export function loadSeenVotes(botId: string): Set<string> {
  const file = seenFile(botId);
  if (!fs.existsSync(file)) return new Set();
  try {
    const ids = JSON.parse(fs.readFileSync(file, "utf-8")) as string[];
    return new Set(ids);
  } catch {
    return new Set();
  }
}

export function saveSeenVotes(botId: string, seen: Set<string>): void {
  const file = seenFile(botId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ids = [...seen].slice(-MAX_SEEN_IDS);
  fs.writeFileSync(file, JSON.stringify(ids, null, 2));
}
