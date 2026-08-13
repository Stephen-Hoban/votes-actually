/**
 * Scratch diagnostic: dumps the raw extracted text of a disclosure PDF.
 *
 * Used to tell a scanned/image filing (no extractable text at all — which the
 * parser would otherwise report as a legitimate $0) apart from a text filing
 * the column logic simply missed.
 *
 * Usage: npx tsx src/debug/dumpPdfText.ts <pdf-url>
 */
import { __debug__ } from "../disclosureHouse.js";

async function main(): Promise<void> {
  const resp = await fetch(process.argv[2], {
    headers: { "User-Agent": "votes-actually (educational project)" },
  });
  const buf = new Uint8Array(await resp.arrayBuffer());
  const items = await __debug__.extractPositionedItems(buf.slice());
  console.log(`total positioned text items: ${items.length}`);
  console.log(items.slice(0, 40).map((i) => i.text.replace(/\0/g, "")).join(" | "));
}

main().catch((err) => { console.error(err); process.exit(1); });
