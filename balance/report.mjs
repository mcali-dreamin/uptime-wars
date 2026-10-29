// Print balance-results/*.json as a table: per race the median survival, min core % and seconds below 50% HP.
// Per run: tier, hero level, casts, farms broken (f), expansions (x), peak $, Spot rentals (s),
// lowest core % (min), time under half HP (low) and own buildings lost (lost). Missing fields print "-".
import { readFileSync, readdirSync } from "node:fs";
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const has = (v) => typeof v === "number";
const medOr = (xs, f) => { const v = xs.filter(has); return v.length ? f(median(v)) : "-"; };
const pct = (p) => `${Math.round(p / 10)}%`;
const files = readdirSync("balance-results").filter((f) => f.endsWith(".json")).sort();
const data = files.map((file) => [file, JSON.parse(readFileSync(`balance-results/${file}`, "utf8"))]);
const first = data.flatMap(([, rows]) => rows).find((r) => r.pressure !== undefined || r.minutes !== undefined);
console.log(`pressure ${first?.pressure ?? "-"} permille, minutes ${first?.minutes ?? "-"}`);
for (const [file, rows] of data) {
  console.log(`${file.replace(".json", "").padEnd(14)} median ${fmt(median(rows.map((r) => r.survived)))} minCore ${medOr(rows.map((r) => r.minCorePermille), pct)} below50 ${medOr(rows.map((r) => r.secondsBelowHalf), fmt)}`);
  for (const hero of [...new Set(rows.map((r) => r.hero))]) {
    const mine = rows.filter((r) => r.hero === hero);
    const runs = mine.map((r) => `${fmt(r.survived)}${r.survivedAll ? "+" : ""} t${r.tier} L${r.heroLevel} c${r.casts} f${r.farmsBroken ?? 0} x${r.expansions ?? 0} $${r.peakMoney ?? 0} s${r.spotRentals ?? 0} min${has(r.minCorePermille) ? Math.round(r.minCorePermille / 10) + "%" : "-"} low${has(r.secondsBelowHalf) ? fmt(r.secondsBelowHalf) : "-"} lost${r.buildingsLost ?? "-"}`).join(" | ");
    console.log(`  ${hero.padEnd(20)} ${fmt(median(mine.map((r) => r.survived)))}  ${runs}`);
  }
}
