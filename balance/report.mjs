// Print balance-results/*.json as a table: median survival per race and hero.
import { readFileSync, readdirSync } from "node:fs";
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
for (const file of readdirSync("balance-results").filter((f) => f.endsWith(".json")).sort()) {
  const rows = JSON.parse(readFileSync(`balance-results/${file}`, "utf8"));
  const all = rows.map((r) => r.survived);
  console.log(`${file.replace(".json", "").padEnd(14)} median ${fmt(median(all))}`);
  for (const hero of [...new Set(rows.map((r) => r.hero))]) {
    const mine = rows.filter((r) => r.hero === hero);
    const runs = mine.map((r) => `${fmt(r.survived)}${r.survivedAll ? "+" : ""} t${r.tier} L${r.heroLevel} c${r.casts}`).join(" | ");
    console.log(`  ${hero.padEnd(20)} ${fmt(median(mine.map((r) => r.survived)))}  ${runs}`);
  }
}
