/**
 * Proportional cent allocation (largest-remainder / Hamilton method).
 *
 * Splits an authoritative total across N buckets weighted by `weights`, guaranteeing
 * the parts sum EXACTLY to `totalCents` (no penny drift) and are all >= 0. Deterministic:
 * leftover cents go to the largest fractional remainders, ties broken by lowest index.
 *
 * Used by the Estimate "Work Total" override and the flat→itemized conversion so the
 * visible service prices ALWAYS add up to the entered total — one authoritative number.
 */
export function allocateProportional(totalCents: number, weights: number[]): number[] {
  const n = weights.length
  if (n === 0) return []
  const T = Math.max(0, Math.round(totalCents))

  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0))
  const W = w.reduce((s, x) => s + x, 0)

  // No usable weights → distribute as evenly as possible.
  if (W <= 0) {
    const base = Math.floor(T / n)
    const out = new Array(n).fill(base)
    let r = T - base * n
    for (let i = 0; i < n && r > 0; i++, r--) out[i] += 1
    return out
  }

  const raw = w.map((x) => (T * x) / W)
  const floors = raw.map((x) => Math.floor(x))
  let remainder = T - floors.reduce((s, x) => s + x, 0)

  // Rank indices by fractional part desc, then index asc (deterministic).
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i))

  const out = floors.slice()
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) out[order[k].i] += 1
  return out
}
