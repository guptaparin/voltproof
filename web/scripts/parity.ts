// Checks that the browser verifier (lib/demo/model.ts) matches the Python verifier exactly.
//   python scripts/parity_cases.py /tmp/parity_cases.json && npx tsx web/scripts/parity.ts /tmp/parity_cases.json
import fs from "fs";
import path from "path";
import { assess, decodeForest } from "../lib/demo/model";

const cases = JSON.parse(fs.readFileSync(process.argv[2] || "/tmp/parity_cases.json", "utf8"));
const dir = path.resolve(__dirname, "../public/demo");
const snap = JSON.parse(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8"));
const bin = fs.readFileSync(path.join(dir, "forest.bin"));
const forest = decodeForest(snap.forest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

let status = 0, score = 0, maxScoreDiff = 0, maxExpRel = 0, codes = 0;
for (const c of cases) {
  const t = assess(forest, c.e, c.sys, c.h, c.wx, c.hist);
  if (t.status === c.py.status) status++;
  const d = Math.abs(t.scoreBps - c.py.scoreBps);
  if (d === 0) score++;
  maxScoreDiff = Math.max(maxScoreDiff, d);
  maxExpRel = Math.max(maxExpRel, Math.abs(t.expectedWh - c.py.expectedWh) / Math.max(1, c.py.expectedWh));
  if (JSON.stringify(t.reasons.map((r) => r.code)) === JSON.stringify(c.py.codes)) codes++;
}
const n = cases.length;
console.log(`parity over ${n} cases: status ${status}/${n}, exact score ${score}/${n} (max diff ${maxScoreDiff} bps), reason codes ${codes}/${n}, max expected-energy rel. error ${maxExpRel.toExponential(2)}`);
process.exit(status === n && maxScoreDiff <= 1 && codes === n ? 0 : 1);
