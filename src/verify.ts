// Verification for Ruzsa's genus-one equation a + 3b = 2c + 2d over Z/NZ.
//
// A set A ⊆ Z/NZ is *valid* when the only solutions to
//   a + 3b ≡ 2c + 2d (mod N)  with a, b, c, d ∈ A
// are the trivial ones a = b = c = d.
//
// Counting argument: with
//   r1(v) = #{(a,b) ∈ A² : a + 3b ≡ v},
//   r2(v) = #{(c,d) ∈ A² : 2c + 2d ≡ v},
// the total number of solutions is Σ_v r1(v)·r2(v), and the trivial
// solutions contribute exactly |A| (one per element, via v = 4x).
// So A is valid ⟺ Σ_v r1(v)·r2(v) = |A|.  This runs in O(|A|²) time and
// O(N) memory. Saturating the r1 counts at 255 preserves the equivalence:
// a saturated bucket has r1(v) ≥ 255 ≥ 2, so any (c,d) pair landing on it
// already pushes the sum past |A|.

export const MAX_N = 50_000
export const MAX_SET_SIZE = 10_000
export const MAX_ELEMENTS_TEXT_BYTES = 1_000_000

export interface Counterexample {
  a: number
  b: number
  c: number
  d: number
}

export type VerifyResult =
  | { ok: false; error: string }
  | {
      ok: true
      valid: boolean
      N: number
      size: number
      /** |A| / sqrt(N); above 1 beats the sqrt(N) barrier. */
      ratio: number
      /** Elements after reduction mod N, sorted. */
      elements: number[]
      counterexample?: Counterexample
    }

/**
 * Parse a list of integers from user text. Accepts comma, whitespace, and
 * newline separators, and tolerates surrounding brackets `[ ... ]`.
 */
export function parseElements(text: string): number[] | { error: string } {
  const cleaned = text.replace(/[\[\]{}()]/g, ' ').trim()
  if (cleaned === '') return { error: 'no elements provided' }
  const tokens = cleaned.split(/[\s,;]+/).filter((t) => t !== '')
  const out: number[] = []
  for (const t of tokens) {
    if (!/^[+-]?\d+$/.test(t)) {
      return { error: `could not parse ${JSON.stringify(t)} as an integer` }
    }
    const x = Number(t)
    if (!Number.isSafeInteger(x)) {
      return { error: `element ${t} is too large` }
    }
    out.push(x)
  }
  return out
}

export function verify(N: number, rawElements: number[]): VerifyResult {
  if (!Number.isSafeInteger(N) || N < 2) {
    return { ok: false, error: 'N must be an integer with N ≥ 2' }
  }
  if (N > MAX_N) {
    return { ok: false, error: `N must be at most ${MAX_N.toLocaleString('en-US')}` }
  }
  if (rawElements.length === 0) {
    return { ok: false, error: 'the set must be nonempty' }
  }
  if (rawElements.length > MAX_SET_SIZE) {
    return {
      ok: false,
      error: `the set may have at most ${MAX_SET_SIZE.toLocaleString('en-US')} elements`,
    }
  }

  // Reduce mod N and reject duplicates.
  const seen = new Set<number>()
  for (const x of rawElements) {
    const r = ((x % N) + N) % N
    if (seen.has(r)) {
      return { ok: false, error: `duplicate element ${r} (after reduction mod N)` }
    }
    seen.add(r)
  }
  const A = [...seen].sort((p, q) => p - q)
  const n = A.length

  // r1[v] = #{(a,b) : a + 3b ≡ v (mod N)}, saturating at 255.
  const r1 = new Uint8Array(N)
  for (let i = 0; i < n; i++) {
    const a = A[i]
    for (let j = 0; j < n; j++) {
      const v = (a + 3 * A[j]) % N
      if (r1[v] < 255) r1[v]++
    }
  }

  // total = Σ_v r1(v)·r2(v), accumulated pairwise over (c,d).
  let total = 0
  for (let i = 0; i < n; i++) {
    const tc = (2 * A[i]) % N
    for (let j = 0; j < n; j++) {
      total += r1[(tc + 2 * A[j]) % N]
    }
  }

  const base = {
    ok: true as const,
    N,
    size: n,
    ratio: n / Math.sqrt(N),
    elements: A,
  }
  if (total === n) {
    return { ...base, valid: true }
  }
  return { ...base, valid: false, counterexample: findCounterexample(N, A, r1, seen) }
}

/**
 * Locate one concrete nontrivial solution. Only called on invalid sets.
 * Cost: O(|A|²) for the diagonal sweep plus O(|A|) per bucket probed —
 * any off-diagonal (c,d) hit is immediately nontrivial, so the first
 * populated bucket it meets terminates the search.
 */
function findCounterexample(
  N: number,
  A: number[],
  r1: Uint8Array,
  inA: Set<number>,
): Counterexample | undefined {
  const n = A.length
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const c = A[i]
      const d = A[j]
      const v = (2 * c + 2 * d) % N
      if (r1[v] === 0) continue
      for (const b of A) {
        const a = (((v - 3 * b) % N) + N) % N
        if (!inA.has(a)) continue
        if (a === b && b === c && c === d) continue
        return { a, b, c, d }
      }
    }
  }
  return undefined
}
