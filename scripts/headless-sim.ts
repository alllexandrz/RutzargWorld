// Runs the world simulation without clients, fast-forwarded, and prints the chronicle.
// Used to check that agents create emergent situations on their own (concept §28 success criterion).
// Usage: node scripts/headless-sim.ts [gameDays=3]

import { World } from "../server/sim/world.ts";
import { fmtDayTime } from "../shared/time.ts";
import { surfaceCounts } from "../server/sim/resources.ts";

const days = Number(process.argv[2] ?? 3);
const w = new World();
let printed = 0;
const dt = 0.05;
const steps = Math.ceil((days * 1440) / dt);
const t0 = Date.now();
for (let i = 0; i < steps; i++) {
  w.tick(dt);
  w.pendingTiles.length = 0;
  while (printed < w.chronicleTotal) {
    const e = w.chronicle[w.chronicle.length - (w.chronicleTotal - printed)];
    printed++;
    if (e && (process.env.ALL || e.kind !== "intent")) console.log(`[${fmtDayTime(e.t)}] ${e.text}`);
  }
}
console.log(`\n--- ${days} game days simulated in ${((Date.now() - t0) / 1000).toFixed(1)}s ---`);
for (const a of w.agents.values()) {
  console.log(`${a.name.padEnd(18)} coins=${String(a.coins).padStart(4)} hunger=${a.hunger.toFixed(0).padStart(3)} energy=${a.energy.toFixed(0).padStart(3)} job=${a.jobBiz ?? "-"} mem=${a.memories.length} act=${a.activity.label}`);
}
console.log(`Town treasury: ${Math.round(w.townTreasury)}`);
console.log("Surface:", JSON.stringify(surfaceCounts(w)), "Deposits:", JSON.stringify(w.res.deposits));
console.log("Market:", JSON.stringify(w.market.stock));
for (const b of w.businesses.values()) console.log(`${b.name.padEnd(28)} owner=${b.ownerId} wage=${b.wage} workers=${b.workers.join(",")} treasury=${Math.round(b.treasury)}`);
