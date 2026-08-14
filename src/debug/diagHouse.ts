/**
 * Scratch diagnostic: dumps the Schedule A / Schedule D column cells that
 * disclosureHouse.ts could not parse for a single filing, so a systematic
 * "N unparsed rows on every filer" pattern can be identified rather than
 * accepted as noise.
 *
 * Usage: npx tsx src/debug/diagHouse.ts <pdf-url>
 */
import { __debug__ } from "../disclosureHouse.js";
import { parseBracket } from "../disclosureBrackets.js";

async function main(): Promise<void> {
  const url = process.argv[2];
  const resp = await fetch(url, { headers: { "User-Agent": "votes-actually (educational project)" } });
  const buf = new Uint8Array(await resp.arrayBuffer());
  // pdfjs transfers the buffer it is handed, so every call gets its own copy.
  const items = await __debug__.extractPositionedItems(buf.slice());
  const { assetCells, liabilityCells } = __debug__.collectScheduleCells(items);

  const parsed = await __debug__.parseFilingPdf(buf.slice());
  console.log(`parseFilingPdf → unparsedRows=${parsed.unparsedRows} assets=[${parsed.assets.low}..${parsed.assets.high}] liabilities=[${parsed.liabilities.low}..${parsed.liabilities.high}]`);

  for (const [label, cells] of [["ASSET", assetCells], ["LIABILITY", liabilityCells]] as const) {
    const merged = __debug__.mergeSplitCells(cells);
    const bad = merged.filter((t) => parseBracket(t) === null);
    console.log(`${label}: ${merged.length} merged cells, ${bad.length} unparseable`);
    for (const b of bad) console.log(`   UNPARSEABLE: ${JSON.stringify(b)}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
