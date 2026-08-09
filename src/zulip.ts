// Posts a Zulip message when a submission achieves a new best exponent —
// log|A| / log N strictly greater than that of every previously recorded
// witness, across all moduli.
//
// Delivery uses Zulip's Slack-compatible incoming webhook
// (`/api/v1/external/slack_incoming`): a single secret URL with the api_key,
// stream, and topic baked in, to which we POST `{ "text": <markdown> }`. The
// URL lives in the ZULIP_WEBHOOK_URL secret; when it is unset (e.g. local dev)
// notification is silently skipped.

import type { Bindings } from './auth'
import { currentRecords, type RecordStatus, type ValidResult } from './store'

// Send `text` as a Zulip message via the incoming webhook. Returns true on a
// 2xx response. Never throws: delivery is best-effort and runs off the
// request path.
async function send(url: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      console.error(`Zulip webhook returned ${res.status}: ${await res.text()}`)
      return false
    }
    return true
  } catch (err) {
    console.error('Zulip webhook request failed:', err)
    return false
  }
}

const exponentOf = (n: number, size: number): number => Math.log(size) / Math.log(n)

// Notify Zulip if the just-recorded witness holds the new best exponent. A
// superseded row never exceeds its modulus's current record (same N, smaller
// |A|), so scanning current records other than the new row covers every
// previously stored witness. No-op when the webhook is unconfigured, the
// submission didn't set a per-modulus record, or the exponent doesn't
// strictly beat the previous best.
//
// Intended to be called via `ctx.waitUntil(...)` so neither the record scan
// nor delivery blocks the response to the submitter.
export async function notifyNewBestExponent(
  env: Bindings,
  status: RecordStatus,
  result: ValidResult,
  submitter: string | null,
  baseUrl: string,
): Promise<void> {
  const url = env.ZULIP_WEBHOOK_URL
  if (!url || !status.recorded) return

  const exponent = exponentOf(result.N, result.size)
  let prev: { exponent: number; id: number } | null = null
  for (const r of await currentRecords(env)) {
    if (r.id === status.witnessId) continue
    const e = exponentOf(r.n, r.size)
    if (!prev || e > prev.exponent) prev = { exponent: e, id: r.id }
  }
  if (prev && exponent <= prev.exponent) return

  const link = `${baseUrl}/witness/${status.witnessId}`
  const who = submitter ? ` by **${submitter}**` : ''
  const prevText = prev
    ? `beating the previous best ${prev.exponent.toFixed(4)} ([witness #${prev.id}](${baseUrl}/witness/${prev.id}))`
    : 'the first witness on the board'
  const text =
    `:trophy: **New best exponent: ${exponent.toFixed(4)}** — ` +
    `[witness #${status.witnessId}](${link}) for N = ${result.N.toLocaleString('en-US')} ` +
    `with |A| = ${result.size.toLocaleString('en-US')}, submitted${who}, ${prevText}.` +
    (exponent > 0.5 ? '\n:tada: This witness beats the √N barrier!' : '')

  await send(url, text)
}
