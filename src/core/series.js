// Time series at one place: which time steps to read for a span of dates,
// and what to say about the result, such as the date sea ice concentration
// fell through its edge and when chlorophyll peaked after it. Dates are
// epoch ms throughout.

const DAY = 86400000;

// Indices of dates (ascending, epoch ms) in [t0, t1], at most max of them,
// evenly spaced through the span. The nearest date to `keep`, when inside,
// is always among them.
export function sampleIndices(dates, t0, t1, { max = 160, keep = null } = {}) {
  let a = 0, b = dates.length;
  while (a < b && dates[a] < t0) a++;
  while (b > a && dates[b - 1] > t1) b--;
  const n = b - a;
  if (n <= 0) return [];
  const stride = Math.max(1, Math.ceil(n / max));
  const out = [];
  for (let i = a; i < b; i += stride) out.push(i);
  if (keep != null) {
    let k = a, best = Infinity;
    for (let i = a; i < b; i++) { const d = Math.abs(dates[i] - keep); if (d < best) { best = d; k = i; } }
    if (!out.includes(k)) { out.push(k); out.sort((x, y) => x - y); }
  }
  return out;
}

// Where values (at ascending times) cross edge: [{ t, dir }] with dir -1
// for a fall from at or above edge to below it, +1 for a rise. The time is
// interpolated between the two samples. With nanBelow, a missing value
// counts as below the edge (a sea ice field leaves open water missing);
// otherwise missing values are skipped.
export function crossings(times, values, edge, { nanBelow = false } = {}) {
  const out = [];
  let pt = null, pv = null;
  for (let i = 0; i < times.length; i++) {
    let v = values[i];
    if (v !== v) { if (!nanBelow) continue; v = -Infinity; }
    if (pv !== null) {
      const was = pv >= edge, is = v >= edge;
      if (was !== is) {
        const f = Number.isFinite(pv) && Number.isFinite(v) && v !== pv ? (edge - pv) / (v - pv) : 0.5;
        out.push({ t: pt + f * (times[i] - pt), dir: is ? 1 : -1 });
      }
    }
    pt = times[i]; pv = v;
  }
  return out;
}

// The largest value at or after t (and before `until`, when given):
// { t, v } or null when nothing is there.
export function peakAfter(times, values, t, until = Infinity) {
  let best = null;
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    if (times[i] < t || times[i] > until || v !== v) continue;
    if (!best || v > best.v) best = { t: times[i], v };
  }
  return best;
}

// Retreat to bloom: the ice's last fall through its edge at or before
// `around` (else its first fall after it), then the next rise of the ice
// (the end of open water) and the chlorophyll peak between the two.
// { retreat, refreeze, peak, lagDays } or null when the ice never falls.
export function retreatToPeak(ice, chl, { edge = 0.15, around = null } = {}) {
  const falls = crossings(ice.times, ice.values, edge, { nanBelow: true });
  const down = falls.filter((c) => c.dir < 0);
  if (!down.length) return null;
  const at = around == null ? down[0] : down.filter((c) => c.t <= around).at(-1) || down[0];
  const up = falls.find((c) => c.dir > 0 && c.t > at.t);
  const peak = peakAfter(chl.times, chl.values, at.t, up ? up.t : Infinity);
  return { retreat: at.t, refreeze: up ? up.t : null, peak, lagDays: peak ? (peak.t - at.t) / DAY : null };
}
