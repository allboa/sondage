// Time series helpers: sampling a span, edge crossings, retreat to peak.
import { sampleIndices, crossings, peakAfter, retreatToPeak } from "../src/core/series.js";

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };
const DAY = 86400000, D = (s) => Date.parse(s + "T00:00:00Z");

const days = Float64Array.from({ length: 730 }, (_, i) => D("2019-01-01") + i * DAY);
const s = sampleIndices(days, D("2019-03-01"), D("2020-02-29"), { max: 60, keep: D("2019-07-04") });
ok(s.length >= 45 && s.length <= 61, `daily year sampled to at most 60 (plus the kept date): ${s.length}`);
ok(days[s[0]] >= D("2019-03-01") && days[s.at(-1)] <= D("2020-02-29"), "samples inside the span");
ok(s.includes(184), "the date asked for is kept");
ok(s.every((x, i) => !i || x > s[i - 1]), "samples ascend");
ok(sampleIndices(days, D("2030-01-01"), D("2031-01-01")).length === 0, "a span past the dates is empty");
const months = Float64Array.from({ length: 12 }, (_, i) => Date.UTC(2019, i, 1));
ok(sampleIndices(months, months[0], months[11]).length === 12, "monthly year: every month");

// ice 0.9 until day 100, falling to 0 by day 120, NaN (open water) until 250, back to 0.8 by 270
const t = Array.from({ length: 365 }, (_, i) => D("2019-01-01") + i * DAY);
const ice = t.map((_, i) => (i < 100 ? 0.9 : i < 120 ? 0.9 * (120 - i) / 20 : i < 250 ? NaN : i < 270 ? 0.8 * (i - 250) / 20 : 0.8));
const c = crossings(t, ice, 0.15, { nanBelow: true });
ok(c.length === 2 && c[0].dir === -1 && c[1].dir === 1, `one fall then one rise: ${c.map((x) => x.dir)}`);
const fallDay = (c[0].t - t[0]) / DAY;
ok(fallDay > 116 && fallDay < 117.5, `fall interpolated near day 116.7: ${fallDay.toFixed(2)}`);
ok(crossings(t, ice, 0.15).length === 2 && Math.abs(crossings(t, ice, 0.15)[0].t - c[0].t) < 1, "without nanBelow the open water is skipped, crossings the same here");

const chlT = Array.from({ length: 12 }, (_, i) => Date.UTC(2019, i, 1));
const chl = [0.1, 0.1, 0.1, 0.2, 0.5, 2.5, 1.2, 0.6, 0.3, 4, 0.1, NaN];
ok(peakAfter(chlT, chl, D("2019-04-15")).v === 4, "peak after a date: the largest");
ok(peakAfter(chlT, chl, D("2019-04-15"), D("2019-08-01")).v === 2.5, "peak before an end date");
const r = retreatToPeak({ times: t, values: ice }, { times: chlT, values: chl });
ok(r && Math.abs(r.lagDays - (Date.UTC(2019, 5, 1) - r.retreat) / DAY) < 1e-9 && r.peak.v === 2.5, `retreat to peak: ${r && r.lagDays.toFixed(1)} d to ${r && r.peak.v}`);
ok(retreatToPeak({ times: t, values: t.map(() => 0.9) }, { times: chlT, values: chl }) === null, "ice that never falls: null");

if (fails) { console.log(`${fails} failures`); process.exit(1); }
console.log("series: all checks passed");
