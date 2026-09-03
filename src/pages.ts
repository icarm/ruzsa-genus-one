// Server-rendered HTML pages, plain template literals.

import {
  MAX_N,
  MAX_SET_SIZE,
  type VerifyResult,
} from './verify'
import type {
  ActivityItem,
  CommentView,
  RecordStatus,
  UserWitnessStats,
  WitnessListRow,
  WitnessSort,
  WitnessView,
} from './store'
import { COMMENT_MAX } from './store'

export interface User {
  id: number
  provider: string
  email?: string | null
  display_name?: string | null
  avatar_url?: string | null
}

export interface TokenRow {
  id: number
  name: string | null
  prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export function escapeHtml(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const SITE_NAME = 'Ruzsa’s genus-one problem'
const SITE_DESCRIPTION =
  "Ruzsa's genus-one equation: hunt for large subsets of Z/NZ with no " +
  'nontrivial solutions to a + 3b = 2c + 2d. Can you beat sqrt(N)?'

function authNav(user: User | null): string {
  if (user) {
    const name = escapeHtml(user.display_name || user.email || 'user')
    return (
      `<a href="/profile" class="auth-user">${name}</a>` +
      `<form class="auth-logout" method="post" action="/auth/logout"><button type="submit">log out</button></form>`
    )
  }
  return `<a class="auth-login" href="/auth/github">log in with GitHub</a>`
}

export function layout(title: string, bodyInner: string, user: User | null = null): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(SITE_DESCRIPTION)}" />
    <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(SITE_DESCRIPTION)}" />
    <meta property="og:image" content="https://ruzsa-genus-one.icarm.cloud/og.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="/style.css" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  </head>
  <body>
    <header>
      <div class="inner">
        <h1><a href="/">Ruzsa&rsquo;s genus-one problem</a></h1>
        <nav><span class="auth-nav">${authNav(user)}</span></nav>
      </div>
    </header>
    <main>${bodyInner}</main>
    <footer>
      <div class="inner">
        <nav class="footer-links">
          <a href="/api">API</a> &nbsp;&middot;&nbsp;
          <a class="external" href="https://github.com/icarm/ruzsa-genus-one">source</a> &nbsp;&middot;&nbsp;
          <a class="external" href="https://icarm.io">icarm.io</a>
        </nav>
        <p class="acknowledgment">This website is maintained by the NSF Institute for Computer-Aided
        Reasoning in Mathematics <span class="nowrap">(<a class="external" href="https://icarm.io">ICARM</a>)</span>.
        Please <a href="/acknowledge">acknowledge</a> ICARM and NSF Grant DMS 2425401 in related
        publications, projects, or other scholarly work.</p>
      </div>
    </footer>
  </body>
</html>`
}

function problemStatement(): string {
  return `
  <section class="prose">
    <p>
      Fix a modulus <var>N</var> and look for a large set
      <var>A</var> &sube; <span class="math">&#8484;/N&#8484;</span> containing
      <em>no nontrivial solutions</em> to
    </p>
    <p class="display-eq"><span class="eq">a + 3b &equiv; 2c + 2d (mod N)</span></p>
    <p>
      with <var>a</var>, <var>b</var>, <var>c</var>, <var>d</var> &isin; <var>A</var>.
      A solution is <em>trivial</em> when <var>a</var> = <var>b</var> = <var>c</var> = <var>d</var>.
    </p>
    <p>
      In <a class="external" href="https://matwbn.icm.edu.pl/ksiazki/aa/aa65/aa6537.pdf">a
      1993 paper</a>, Imre Z. Ruzsa suggested that
      |<var>A</var>| = <var>N</var><sup>1&minus;o(1)</sup> could be achievable.
      There are known constructions that reach
      |<var>A</var>| = &Theta;(&radic;<span class="sqrt">N</span>).
      Our challenge: find a witness with
      |<var>A</var>| &gt; &radic;<span class="sqrt">N</span>.
    </p>
  </section>`
}

export interface FormState {
  nValue?: string
  elementsValue?: string
}

/** A current record: the witness row id, the modulus, and its best size. */
export interface RecordPoint {
  id: number
  n: number
  size: number
}

// Server-rendered SVG scatters of the records against the modulus N. Both
// views share a fixed 720x440 frame with a log10-N x-axis, so the sqrt(N)
// goal always reads the same. No JS; tooltips via <title>.
const PLOT = { W: 720, H: 440, L: 56, R: 18, T: 18, B: 46 }
const INNER_W = PLOT.W - PLOT.L - PLOT.R
const INNER_H = PLOT.H - PLOT.T - PLOT.B
const LOG_NMIN = Math.log10(2) // N = 2 is the smallest valid modulus
const LOG_NMAX = Math.log10(MAX_N) // ~4.7
const plotX = (logN: number) =>
  PLOT.L + ((logN - LOG_NMIN) / (LOG_NMAX - LOG_NMIN)) * INNER_W

// Tick labels as powers of ten.
const pow10 = (k: number): string =>
  k === 0 ? '1' : `10<tspan class="sup" dy="-5">${k}</tspan><tspan dy="5">&#8203;</tspan>`

// Decade gridlines and ticks for the shared x-axis, plus a tick for N = 2 at
// the left edge (the axis line itself, so no gridline).
function xDecadeGrid(): string {
  let grid = `<text class="tick" x="${PLOT.L}" y="${PLOT.T + INNER_H + 18}" text-anchor="middle">2</text>`
  for (let k = 1; k <= Math.floor(LOG_NMAX); k++) {
    const x = plotX(k).toFixed(1)
    grid += `<line class="grid" x1="${x}" y1="${PLOT.T}" x2="${x}" y2="${PLOT.T + INNER_H}"/>`
    grid += `<text class="tick" x="${x}" y="${PLOT.T + INNER_H + 18}" text-anchor="middle">${pow10(k)}</text>`
  }
  return grid
}

function plotSvg(ariaLabel: string, yTitle: string, body: string): string {
  return `<svg class="records-plot" viewBox="0 0 ${PLOT.W} ${PLOT.H}" role="img" aria-label="${ariaLabel}">
      ${body}
      <line class="axis" x1="${PLOT.L}" y1="${PLOT.T}" x2="${PLOT.L}" y2="${PLOT.T + INNER_H}"/>
      <line class="axis" x1="${PLOT.L}" y1="${PLOT.T + INNER_H}" x2="${PLOT.W - PLOT.R}" y2="${PLOT.T + INNER_H}"/>
      <text class="axis-title" x="${PLOT.L + INNER_W / 2}" y="${PLOT.H - 6}" text-anchor="middle">modulus N &#8594;</text>
      <text class="axis-title" transform="rotate(-90)" x="${-(PLOT.T + INNER_H / 2)}" y="15" text-anchor="middle">${yTitle}</text>
    </svg>`
}

// Log-log view: record size r(N) against N. The y-scale is chosen so the
// r = sqrt(N) goal line runs corner to corner.
function sizePlot(): string {
  const ymax = LOG_NMAX / 2
  const Y = (logR: number) => PLOT.T + INNER_H - (logR / ymax) * INNER_H

  let grid = xDecadeGrid()
  for (let k = 0; k <= Math.floor(ymax); k++) {
    const y = Y(k).toFixed(1)
    if (k > 0) grid += `<line class="grid" x1="${PLOT.L}" y1="${y}" x2="${PLOT.W - PLOT.R}" y2="${y}"/>`
    grid += `<text class="tick" x="${PLOT.L - 8}" y="${(Y(k) + 4).toFixed(1)}" text-anchor="end">${pow10(k)}</text>`
  }

  // The sqrt(N) barrier (log r = log N / 2), spanning the full x-range. Its
  // label runs along the line, nudged perpendicular so it doesn't overlap.
  const gx1 = plotX(LOG_NMIN), gy1 = Y(LOG_NMIN / 2)
  const gx2 = plotX(LOG_NMAX), gy2 = Y(LOG_NMAX / 2)
  const lineAngle = (Math.atan2(gy2 - gy1, gx2 - gx1) * 180) / Math.PI
  const labelX = gx1 + 0.85 * (gx2 - gx1), labelY = gy1 + 0.85 * (gy2 - gy1)
  const sqrtLine = `<line class="guide guide-sqrt" x1="${gx1.toFixed(1)}" y1="${gy1.toFixed(1)}" x2="${gx2.toFixed(1)}" y2="${gy2.toFixed(1)}"/>
      <text class="guide-label" transform="rotate(${lineAngle.toFixed(1)} ${labelX.toFixed(1)} ${labelY.toFixed(1)})" x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" dy="-7" text-anchor="end">|A| = &#8730;N</text>`

  return plotSvg(
    'record witness size versus modulus, log-log scatter plot',
    'record witness size |A| &#8594;',
    `${grid}\n      ${sqrtLine}`,
  )
}

// Exponent view: log r(N) / log N against N, linear y from 0.35 to 1/2, so
// the sqrt(N) barrier is the horizontal line along the top edge. Weak records
// below the window are simply cut off.
function exponentPlot(): string {
  const ymin = 0.35, ymax = 0.5
  const Y = (v: number) => PLOT.T + INNER_H - ((v - ymin) / (ymax - ymin)) * INNER_H

  let grid = xDecadeGrid()
  for (const v of [0.35, 0.4, 0.45, 0.5]) {
    const y = Y(v).toFixed(1)
    if (v > ymin && v < ymax) grid += `<line class="grid" x1="${PLOT.L}" y1="${y}" x2="${PLOT.W - PLOT.R}" y2="${y}"/>`
    grid += `<text class="tick" x="${PLOT.L - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`
  }

  const sqrtLine = `<line class="guide guide-sqrt" x1="${PLOT.L}" y1="${Y(0.5)}" x2="${PLOT.W - PLOT.R}" y2="${Y(0.5)}"/>
      <text class="guide-label" x="${PLOT.W - PLOT.R - 8}" y="${(Y(0.5) + 16).toFixed(1)}" text-anchor="end">|A| = &#8730;N</text>`

  return plotSvg(
    'exponent log |A| over log N versus modulus scatter plot',
    'exponent log |A| / log N &#8594;',
    `${grid}\n      ${sqrtLine}`,
  )
}

/** Which records plot the home page shows; selected via the ?plot= query param. */
export type PlotKind = 'size' | 'exponent'

// The SVG carries only the static frame (axes, grid, guides); the dots — one
// per modulus, 30k+ of them — are drawn client-side onto a canvas overlay by
// /plot.js from /records.json, keeping the page payload and DOM small.
function recordsSection(plot: PlotKind): string {
  const tab = (kind: PlotKind, href: string, label: string) =>
    kind === plot
      ? `<span class="active" aria-current="page">${label}</span>`
      : `<a href="${href}">${label}</a>`
  const inner = `<nav class="plot-tabs">
      ${tab('exponent', '/', 'exponent log&thinsp;|A|&thinsp;/&thinsp;log&thinsp;N')}
      ${tab('size', '/?plot=size', 'record size |A|')}
      <button class="plot-refresh" type="button" hidden
        title="re-fetch the records without reloading the page">refresh</button>
    </nav>
    <div class="plot-panel">
      <div class="plot-stage" data-plot="${plot}">
        ${plot === 'exponent' ? exponentPlot() : sizePlot()}
        <canvas class="plot-canvas" aria-hidden="true"></canvas>
        <div class="plot-loading" hidden>loading records&hellip;</div>
        <div class="plot-tooltip" hidden></div>
      </div>
      <noscript><p class="muted">Drawing the record dots needs JavaScript &mdash;
      <a href="/witnesses">browse the witness table</a> instead.</p></noscript>
    </div>
    <script src="/plot.js" defer></script>`
  return `
  <section class="panel records">
    ${inner}
    <p class="muted plot-caption">Each dot is the largest known witness for its modulus.
    A dot above the dashed line beats &radic;<span class="sqrt">N</span>.</p>
    <p class="plot-caption"><a href="/witnesses">Browse witnesses &rarr;</a> &nbsp;&middot;&nbsp;
    <a href="/recent">Recent activity &rarr;</a> &nbsp;&middot;&nbsp;
    <a class="external nowrap" href="https://icarm.zulipchat.com/#narrow/channel/519875-general/topic/Ruzsa.20Genus.20One/near/614443028">Discuss on Zulip</a></p>
    <p class="plot-caption"><a class="nowrap" href="/database.json" download>Download all records (JSON) &darr;</a></p>
  </section>`
}

function verifierForm(state: FormState, user: User | null): string {
  const submit = user
    ? '<button type="submit">Verify</button>'
    : '<a class="login-to-submit" href="/auth/github">Log in to submit</a>'
  return `
  <section class="panel">
    <h2>Submit a witness</h2>
    <form method="post" action="/verify">
      <label for="N">Modulus <var>N</var></label>
      <input id="N" name="N" type="text" inputmode="numeric" required
             placeholder="e.g. 25045" value="${escapeHtml(state.nValue ?? '')}" />
      <label for="A">Elements of <var>A</var> (integers separated by commas, spaces, or newlines; brackets ok)</label>
      <textarea id="A" name="A" rows="8" required
                placeholder="e.g. 0, 260, 268, 280, ...">${escapeHtml(state.elementsValue ?? '')}</textarea>
      ${submit}
      <p class="muted form-note">Verification runs server-side in O(|A|&sup2;) time.
         Limits: N &le; ${MAX_N.toLocaleString('en-US')}, |A| &le; ${MAX_SET_SIZE.toLocaleString('en-US')}.</p>
    </form>
  </section>`
}

function recordSection(size: number, N: number, record?: RecordStatus): string {
  if (!record) return ''
  const nStr = N.toLocaleString('en-US')
  const recordLink = (text: string) =>
    record.witnessId ? `<a href="/witness/${record.witnessId}">${text}</a>` : text
  if (record.recorded) {
    return `<p class="record-new">New record: the largest known witness for N = ${nStr}. Saved as ${recordLink(
      `witness #${record.witnessId}`,
    )}.</p>`
  }
  if (record.recordSize === size) {
    if (record.tiedExact) {
      return `<p class="muted">This is exactly the ${recordLink('current record witness')} for N = ${nStr} (|A| = ${record.recordSize.toLocaleString(
        'en-US',
      )}), element for element.</p>`
    }
    return `<p class="muted">Ties the ${recordLink('current record')} for N = ${nStr} (|A| = ${record.recordSize.toLocaleString(
      'en-US',
    )}) with a <em>different</em> set of the same size &mdash; the standing record keeps its place.</p>`
  }
  return `<p class="muted">The ${recordLink('record witness')} for N = ${nStr} has |A| = ${record.recordSize.toLocaleString(
    'en-US',
  )}, so this one was not saved.</p>`
}

function resultSection(result: VerifyResult, record?: RecordStatus): string {
  if (!result.ok) {
    return `
    <section class="result result-error">
      <h2>Error</h2>
      <p>${escapeHtml(result.error)}</p>
    </section>`
  }
  const sqrtN = Math.sqrt(result.N)
  const stats = `
      <dl class="stats">
        <div><dt>N</dt><dd>${result.N.toLocaleString('en-US')}</dd></div>
        <div><dt>|A|</dt><dd>${result.size.toLocaleString('en-US')}</dd></div>
        <div><dt>&radic;<span class="sqrt">N</span></dt><dd>${sqrtN.toFixed(1)}</dd></div>
        <div><dt>exponent log&thinsp;|A|&thinsp;/&thinsp;log&thinsp;N</dt><dd class="score">${(
          Math.log(result.size) / Math.log(result.N)
        ).toFixed(6)}</dd></div>
      </dl>`
  if (result.valid) {
    const beats = result.ratio > 1
    return `
    <section class="result result-valid">
      <h2>Valid witness ✓</h2>
      <p>No nontrivial solutions to <span class="eq">a + 3b &equiv; 2c + 2d (mod ${result.N.toLocaleString(
        'en-US',
      )})</span> in this set.</p>
      ${stats}
      ${recordSection(result.size, result.N, record)}
      ${
        beats
          ? '<p class="beats">This witness beats &radic;<span class="sqrt">N</span>! 🏆</p>'
          : '<p class="muted">An exponent above 0.5 would beat the &radic;<span class="sqrt">N</span> barrier.</p>'
      }
    </section>`
  }
  const ce = result.counterexample
  const ceHtml = ce
    ? `<p>Counterexample: <span class="eq">${ce.a} + 3&middot;${ce.b} &equiv; 2&middot;${ce.c} + 2&middot;${
        ce.d
      } &equiv; ${(ce.a + 3 * ce.b) % result.N} (mod ${result.N.toLocaleString('en-US')})</span></p>`
    : ''
  return `
  <section class="result result-invalid">
    <h2>Not a valid witness ✗</h2>
    <p>The set contains a nontrivial solution.</p>
    ${ceHtml}
    ${stats}
  </section>`
}

export function landingPage(
  user: User | null = null,
  resultExpired = false,
  plot: PlotKind = 'exponent',
): string {
  const expiredNote = resultExpired
    ? '<section class="prose"><p class="muted">That result link has expired &mdash; submit the set again below.</p></section>'
    : ''
  const body = `
    ${problemStatement()}
    ${expiredNote}
    ${recordsSection(plot)}
    ${verifierForm({}, user)}
    <section class="prose api-note">
      <h2>API</h2>
      <p>
        <code>POST /api/verify</code> with JSON body
        <code>{"N": 25045, "A": [0, 260, ...]}</code> returns the same verdict
        as JSON. See the <a href="/api">API docs</a>.
      </p>
    </section>`
  return layout(SITE_NAME, body, user)
}

// Post/Redirect/Get target for non-record submissions: the verdict plus the
// form, pre-filled for quick iteration. Served from a short-lived KV flash,
// so reloading is harmless.
export function resultPage(
  user: User | null,
  result: VerifyResult,
  record: RecordStatus | undefined,
  form: FormState,
): string {
  const body = `
    <section class="prose">
      <p class="page-nav"><a href="/">&larr; home</a></p>
    </section>
    ${resultSection(result, record)}
    ${verifierForm(form, user)}`
  return layout(`Result — ${SITE_NAME}`, body, user)
}

function userWitnessesSection(userId: number, { submitted, held }: UserWitnessStats): string {
  const heading = '<h3>Your record witnesses</h3>'
  if (submitted === 0) {
    return `<section class="my-witnesses">
      ${heading}
      <p class="muted">None yet &mdash; a witness is saved when it sets the record for its modulus. <a href="/">Submit one &rarr;</a></p>
    </section>`
  }
  const fmt = (k: number) => k.toLocaleString('en-US')
  const mine = (all: boolean) => `/witnesses?user=${userId}${all ? '&all=1' : ''}`
  return `<section class="my-witnesses">
      ${heading}
      <dl class="stats">
        <div><dt>records held</dt><dd><a href="${mine(false)}" title="your witnesses that are still the record for their modulus">${fmt(held)}</a></dd></div>
        <div><dt>records submitted</dt><dd><a href="${mine(true)}" title="every witness of yours that set the record when submitted">${fmt(submitted)}</a></dd></div>
      </dl>
      <p class="muted">A witness counts as submitted when it set the record for its modulus; it is held until a larger set beats it.</p>
    </section>`
}

export function profilePage(
  user: User,
  tokens: TokenRow[],
  newToken: { token: string; prefix: string } | null,
  witnesses: UserWitnessStats = { submitted: 0, held: 0 },
): string {
  const newTokenBlock = newToken
    ? `<div class="new-token">
        <p><strong>New token created.</strong> Copy it now &mdash; this is the only time it will be shown.</p>
        <pre class="token-secret">${escapeHtml(newToken.token)}</pre>
        <p class="muted">Send it as <code>Authorization: Bearer ${escapeHtml(newToken.token)}</code> when calling the API.</p>
      </div>`
    : ''
  const tokenRows = tokens.length
    ? tokens
        .map((t) => {
          const label = t.name ? escapeHtml(t.name) : '<span class="muted">(unnamed)</span>'
          const status = t.revoked_at
            ? `<span class="muted">revoked ${escapeHtml(t.revoked_at)}</span>`
            : `<form method="post" action="/profile/tokens/${t.id}/revoke" class="inline-form"><button type="submit" class="link-button">revoke</button></form>`
          const lastUsed = t.last_used_at
            ? escapeHtml(t.last_used_at)
            : '<span class="muted">never</span>'
          return `<tr>
            <td><code>${escapeHtml(t.prefix)}&hellip;</code></td>
            <td>${label}</td>
            <td>${escapeHtml(t.created_at)}</td>
            <td>${lastUsed}</td>
            <td>${status}</td>
          </tr>`
        })
        .join('\n')
    : `<tr><td colspan="5" class="muted">No tokens yet.</td></tr>`
  const body = `
    <section class="prose">
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>Profile</h2>
      <p class="muted">Signed in as ${escapeHtml(user.display_name || user.email || 'user')} (via ${escapeHtml(
        user.provider,
      )}).</p>
      ${newTokenBlock}
      <section class="profile-name">
        <h3>Display name</h3>
        <form method="post" action="/profile/name" class="profile-name-form">
          <input type="text" name="name" value="${escapeHtml(user.display_name || '')}" maxlength="100" required />
          <button type="submit">save</button>
        </form>
      </section>
      <section class="tokens">
        <h3>API tokens</h3>
        <p>Send a token in the <code>Authorization: Bearer &hellip;</code> header to call the <a href="/api">API</a> as yourself, so record witnesses are attributed to you.</p>
        <table class="tokens-table">
          <thead><tr><th>Prefix</th><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
          <tbody>${tokenRows}</tbody>
        </table>
        <form method="post" action="/profile/tokens" class="new-token-form">
          <label>Name (optional) <input type="text" name="name" maxlength="100" placeholder="e.g. laptop CLI" /></label>
          <button type="submit">Generate new token</button>
        </form>
      </section>
      ${userWitnessesSection(user.id, witnesses)}
    </section>`
  return layout(`Profile — ${SITE_NAME}`, body, user)
}

export function apiDocsPage(user: User | null = null): string {
  const verifyReq = `curl -X POST https://ruzsa-genus-one.icarm.cloud/api/verify \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer ruzsa_...' \\
  -d '{ "N": 49, "A": [0, 7, 13, 29, 41], "commentary": "optional note for the witness page" }'`
  const verifyResp = `{
  "ok": true,
  "N": 49,
  "size": 5,
  "ratio": 0.7142857142857143,     // |A| / sqrt(N)
  "valid": true,
  "record": { "recorded": true, "recordSize": 5 }
}`
  const invalidResp = `{
  "ok": true,
  "valid": false,
  "counterexample": { "a": 3, "b": 1, "c": 1, "d": 2 },  // a + 3b ≡ 2c + 2d (mod N)
  ...
}`
  const body = `
    <section class="prose">
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>API</h2>

      <h3>POST <code>/api/verify</code></h3>
      <p>Verifies that a set <var>A</var> &sube; <span class="math">&#8484;/N&#8484;</span> contains no
      nontrivial solutions to <span class="eq">a + 3b &equiv; 2c + 2d (mod N)</span>. Elements are
      reduced mod <var>N</var>; duplicates after reduction are rejected. Limits:
      <var>N</var> &le; ${MAX_N.toLocaleString('en-US')} and
      |<var>A</var>| &le; ${MAX_SET_SIZE.toLocaleString('en-US')}.</p>
      <p>Requires an <code>Authorization: Bearer &lt;token&gt;</code> header &mdash; create a token
      on your <a href="/profile">profile</a> page. Requests without a valid token receive
      <code>401</code>. A record-setting witness is saved and attributed to your account.</p>
      <pre><code>${escapeHtml(verifyReq)}</code></pre>
      <p>Returns <code>200</code> with the verdict, <code>401</code> without a valid token, or
      <code>400</code> if the body isn&rsquo;t JSON of
      the form <code>{"N": &lt;integer&gt;, "A": [&lt;integers&gt;]}</code> or violates the limits.
      A <em>valid</em> witness that is larger than every previously recorded witness for its modulus
      is saved, and <code>record.recorded</code> is <code>true</code>; otherwise
      <code>record.recordSize</code> reports the standing record. When a valid submission ties the
      record, <code>record.tiedExact</code> reports whether it is element-for-element the record
      witness itself (<code>true</code>) or a different set of the same size (<code>false</code>).</p>
      <p>An optional <code>commentary</code> string (at most ${COMMENT_MAX.toLocaleString(
        'en-US',
      )} characters) becomes the new witness page&rsquo;s commentary when &mdash; and only
      when &mdash; the submission sets a record; the response then carries
      <code>commentaryApplied</code>. It can be edited later on the witness page, with full
      edit history kept. Commentary is plain text, except that <code>witness#123</code>
      becomes a link to that witness&rsquo;s page.</p>
      <pre><code>${escapeHtml(verifyResp)}</code></pre>
      <p>An invalid set instead gets <code>valid: false</code> and one concrete nontrivial solution
      (no <code>record</code> field):</p>
      <pre><code>${escapeHtml(invalidResp)}</code></pre>

      <h3>GET <code>/database.json</code></h3>
      <p>All record witnesses as one JSON download: <code>{ count, witnesses }</code>, each with
      its modulus <code>n</code>, <code>size</code>, <code>ratio</code>, full <code>elements</code>
      list, <code>submitter</code>, <code>created_at</code>, and <code>current</code> (false for
      superseded records, which are kept as history). No auth required. Responses carry a strong
      <code>ETag</code>; conditional requests return <code>304</code> when nothing has changed.</p>

      <h3>MCP server: <code>/mcp</code></h3>
      <p>The site is also a remote <a class="external"
      href="https://modelcontextprotocol.io">Model Context Protocol</a> server, so AI chat clients
      can verify and submit witnesses mid-conversation. Add
      <code>https://ruzsa-genus-one.icarm.cloud/mcp</code> as a custom connector (Claude.ai:
      Settings &rarr; Connectors; ChatGPT: developer-mode connectors; also works with Claude Code,
      MCP Inspector, and other MCP clients). The connector flow signs you in with GitHub &mdash;
      the same account as the website &mdash; and record submissions are attributed to you.</p>
      <p>Tools: <code>list_records</code>, <code>get_record</code> (one modulus, with elements),
      <code>verify_witness</code>, and <code>submit_witness</code>. Verification and submission
      share the per-account rate limit.</p>
    </section>`
  return layout(`API — ${SITE_NAME}`, body, user)
}

// Linkify `witness#123` references in commentary text; everything else is escaped.
function renderCommentary(content: string): string {
  let out = ''
  let last = 0
  for (const m of content.matchAll(/witness#(\d+)/g)) {
    out += escapeHtml(content.slice(last, m.index))
    out += `<a href="/witness/${m[1]}">witness#${m[1]}</a>`
    last = (m.index ?? 0) + m[0].length
  }
  return out + escapeHtml(content.slice(last))
}

function commentarySection(witnessId: number, comment: CommentView | null, user: User | null): string {
  const hasContent = !!comment && comment.content.length > 0
  const body = hasContent
    ? `<div class="comment-body">${renderCommentary(comment!.content)}</div>`
    : `<p class="muted">No commentary yet.</p>`
  const meta = comment
    ? `<p class="comment-meta">last edited ${comment.author ? `by ${escapeHtml(comment.author)} ` : ''}at ${escapeHtml(
        comment.created_at,
      )} UTC &middot; <a href="/witness/${witnessId}/commentary-history">history</a></p>`
    : ''
  const editor = user
    ? `<details class="comment-edit">
        <summary>edit</summary>
        <form method="post" action="/witness/${witnessId}/commentary">
          <textarea name="content" rows="6" maxlength="${COMMENT_MAX}">${escapeHtml(comment?.content ?? '')}</textarea>
          <div><button type="submit">save</button> <span class="muted">plain text; <code>witness#123</code> links to that witness &middot; submit empty to clear</span></div>
        </form>
      </details>`
    : `<p class="muted"><a href="/auth/github">Log in</a> to add commentary.</p>`
  return `<section class="comment-section">
      <h3>Commentary</h3>
      ${body}
      ${meta}
      ${editor}
    </section>`
}

export function witnessDetailPage(
  w: WitnessView,
  comment: CommentView | null = null,
  user: User | null = null,
  justRecorded = false,
): string {
  let elements: number[] = []
  try {
    elements = JSON.parse(w.elements)
  } catch {
    /* leave empty */
  }
  const submitter = w.submitter_name
    ? escapeHtml(w.submitter_name)
    : '<span class="muted">anonymous</span>'
  const isCurrent = w.size === w.record_size
  const status = isCurrent
    ? 'current record for this modulus'
    : `superseded &mdash; the record is now <a href="/witness/${w.record_id}">|A| = ${w.record_size.toLocaleString('en-US')}</a>`
  const body = `
    <section class="prose">
      <p class="page-nav"><a href="/">&larr; home</a> &nbsp;&middot;&nbsp; <a href="/witnesses">all witnesses</a></p>
      ${justRecorded ? `<p class="record-new">New record: the largest known witness for N = ${w.n.toLocaleString('en-US')}. Saved. 🏅</p>` : ''}
      <h2>witness #${w.id}</h2>
      <dl class="stats">
        <div><dt>N</dt><dd><a href="/witnesses?n=${w.n}" title="all record witnesses for this modulus">${w.n.toLocaleString('en-US')}</a></dd></div>
        <div><dt>|A|</dt><dd>${w.size.toLocaleString('en-US')}</dd></div>
        <div><dt>exponent log&thinsp;|A|&thinsp;/&thinsp;log&thinsp;N</dt><dd class="score">${(
          Math.log(w.size) / Math.log(w.n)
        ).toFixed(6)}</dd></div>
      </dl>
      <dl class="witness-meta">
        <dt>status</dt><dd>${status}</dd>
        <dt>submitted by</dt><dd>${submitter}</dd>
        <dt>submitted at</dt><dd>${escapeHtml(w.created_at)} UTC</dd>
      </dl>
      <section class="witness-elements">
        <h3>Elements <span class="muted">(${elements.length.toLocaleString('en-US')})</span></h3>
        <pre class="elements">${elements.join(', ')}</pre>
      </section>
      ${commentarySection(w.id, comment, user)}
    </section>`
  return layout(`witness #${w.id} — ${SITE_NAME}`, body, user)
}

export function commentaryHistoryPage(
  w: WitnessView,
  entries: CommentView[],
  user: User | null = null,
): string {
  const list = entries.length
    ? entries
        .map(
          (e) => `<li>
        <p class="comment-meta">${e.author ? escapeHtml(e.author) : '<span class="muted">(deleted user)</span>'} &middot; ${escapeHtml(
            e.created_at,
          )} UTC</p>
        ${e.content.length > 0 ? `<div class="comment-body">${renderCommentary(e.content)}</div>` : `<p class="muted">(cleared)</p>`}
      </li>`,
        )
        .join('\n')
    : `<li class="muted">No commentary yet.</li>`
  const body = `
    <section class="prose">
      <p class="page-nav"><a href="/witness/${w.id}">&larr; witness #${w.id}</a></p>
      <h2>Commentary history</h2>
      <p class="muted">${entries.length} edit${entries.length === 1 ? '' : 's'}.</p>
      <ul class="comment-history">${list}</ul>
    </section>`
  return layout(`Commentary history — ${SITE_NAME}`, body, user)
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

// A SQLite CURRENT_TIMESTAMP string ('YYYY-MM-DD HH:MM:SS', UTC) as a
// timezone-free relative time ("3 hours ago"), with the exact UTC instant
// in the tooltip and a machine-readable datetime attribute.
function relativeTime(ts: string): string {
  const then = new Date(ts.replace(' ', 'T') + 'Z').getTime()
  if (Number.isNaN(then)) return escapeHtml(ts)
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  const units: [number, string][] = [
    [31536000, 'year'],
    [2592000, 'month'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ]
  let text = 'just now'
  for (const [secs, name] of units) {
    if (s >= secs) {
      const k = Math.floor(s / secs)
      text = `${k} ${name}${k === 1 ? '' : 's'} ago`
      break
    }
  }
  return `<time datetime="${ts.replace(' ', 'T')}Z" title="${escapeHtml(ts)} UTC">${text}</time>`
}

// Recent-activity feed: record witnesses and commentary edits, newest first.
export function activityPage(
  items: ActivityItem[],
  page: number,
  hasOlder: boolean,
  user: User | null = null,
): string {
  const who = (u: string | null) => (u ? escapeHtml(u) : '<span class="muted">anonymous</span>')
  const entry = (a: ActivityItem): string => {
    const link = `<a href="/witness/${a.witness_id}">witness #${a.witness_id}</a>`
    const meta = `<p class="activity-meta">${relativeTime(a.ts)} &middot; ${who(a.user)}</p>`
    if (a.kind === 'record') {
      return `<li>
        ${meta}
        <p class="activity-line">set a record for N = ${a.n.toLocaleString('en-US')} with ${link} &mdash; |A| = ${a.size.toLocaleString(
          'en-US',
        )}, exponent ${(Math.log(a.size) / Math.log(a.n)).toFixed(4)}</p>
      </li>`
    }
    const cleared = !a.content || a.content.length === 0
    return `<li>
        ${meta}
        <p class="activity-line">${cleared ? `cleared commentary on ${link}` : `edited commentary on ${link}`}</p>
        ${cleared ? '' : `<div class="comment-body">${renderCommentary(clip(a.content!, 280))}</div>`}
      </li>`
  }
  const list = items.length
    ? `<ul class="activity">${items.map(entry).join('\n')}</ul>`
    : `<p class="muted">No activity yet.</p>`
  const newer =
    page > 0
      ? `<a href="/recent${page - 1 === 0 ? '' : `?p=${page - 1}`}">&larr; newer</a>`
      : `<span class="muted">&larr; newer</span>`
  const older = hasOlder
    ? `<a href="/recent?p=${page + 1}">older &rarr;</a>`
    : `<span class="muted">older &rarr;</span>`
  const body = `
    <section class="prose">
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>Recent activity</h2>
      <p class="muted">Record witnesses and commentary edits, newest first.</p>
      ${list}
      <nav class="pager">${newer} <span class="muted">page ${page + 1}</span> ${older}</nav>
    </section>`
  return layout(`Recent activity — ${SITE_NAME}`, body, user)
}

// The /witnesses table. Filtering, sorting, and pagination are all
// server-side via query params — the column headers and page links carry the
// target state, so the page needs no JS.
const WITNESS_SORT_KEYS: readonly WitnessSort[] = ['id', 'n', 'size', 'exponent', 'date']

/** Rows per page on /witnesses. */
export const WITNESSES_PAGE_SIZE = 100

// First-click direction per column: sizes and exponents are most interesting
// large-first, ids/moduli small-first.
const WITNESS_SORT_DEFAULT_DIR: Record<WitnessSort, 'asc' | 'desc'> = {
  id: 'asc',
  n: 'asc',
  size: 'desc',
  exponent: 'desc',
  date: 'desc',
}

export interface WitnessesQuery {
  sort: WitnessSort
  dir: 'asc' | 'desc'
  currentOnly: boolean
  nFilter: number | null
  userFilter: number | null // submitter user id
  page: number // 1-based
}

/** Normalize raw /witnesses query params into validated page state. */
export function parseWitnessesQuery(query: {
  sort?: string
  dir?: string
  all?: string
  n?: string
  user?: string
  page?: string
}): WitnessesQuery {
  const sort: WitnessSort = (WITNESS_SORT_KEYS as readonly string[]).includes(query.sort ?? '')
    ? (query.sort as WitnessSort)
    : 'exponent'
  const dir: 'asc' | 'desc' =
    query.dir === 'asc' || query.dir === 'desc' ? query.dir : WITNESS_SORT_DEFAULT_DIR[sort]
  const nFilter = /^\d+$/.test(query.n ?? '') ? Number(query.n) : null
  const userFilter = /^\d+$/.test(query.user ?? '') ? Number(query.user) : null
  // Current records only is the default; ?all=1 opts into superseded rows.
  // A modulus filter always shows that modulus's full record history.
  const currentOnly = nFilter === null && query.all !== '1'
  const page = /^\d+$/.test(query.page ?? '') ? Math.max(1, Number(query.page)) : 1
  return { sort, dir, currentOnly, nFilter, userFilter, page }
}

export function witnessesPage(
  rows: WitnessListRow[],
  total: number,
  { sort, dir, currentOnly, nFilter, userFilter, page }: WitnessesQuery,
  user: User | null = null,
  submitterName: string | null = null, // display name for userFilter, when it names a real user
): string {
  const exponent = (w: WitnessListRow) => Math.log(w.size) / Math.log(w.n)

  const href = (
    s: WitnessSort,
    d: 'asc' | 'desc',
    current: boolean,
    n: number | null = nFilter,
    p = 1, // sort and filter changes reset to the first page
    u: number | null = userFilter,
  ): string => {
    const q = new URLSearchParams()
    if (!(s === 'exponent' && d === 'desc')) {
      q.set('sort', s)
      q.set('dir', d)
    }
    if (n !== null) q.set('n', String(n))
    else if (!current) q.set('all', '1')
    if (u !== null) q.set('user', String(u))
    if (p > 1) q.set('page', String(p))
    const qs = q.toString()
    return '/witnesses' + (qs ? '?' + qs : '')
  }
  const th = (key: WitnessSort, label: string, cls = '', title = ''): string => {
    const active = key === sort
    const target = active ? (dir === 'asc' ? 'desc' : 'asc') : WITNESS_SORT_DEFAULT_DIR[key]
    return `<th${cls ? ` class="${cls}"` : ''}><a class="sort${active ? ` ${dir}` : ''}" href="${href(
      key,
      target,
      currentOnly,
    )}"${title ? ` title="${title}"` : ''}>${label}</a></th>`
  }

  const trs = rows
    .map(
      (w) => `<tr>
        <td><a href="/witness/${w.id}">#${w.id}</a></td>
        <td class="num"><a href="${href(sort, dir, currentOnly, w.n)}" title="show only N = ${w.n.toLocaleString('en-US')}">${w.n.toLocaleString('en-US')}</a></td>
        <td class="num">${w.size.toLocaleString('en-US')}</td>
        <td class="num">${exponent(w).toFixed(4)}</td>
        <td>${w.submitter ? escapeHtml(w.submitter) : '<span class="muted">anonymous</span>'}</td>
        <td>${escapeHtml(w.created_at)}</td>
        <td>${w.is_current ? 'current' : '<span class="muted">superseded</span>'}</td>
      </tr>`,
    )
    .join('\n')

  // A modulus filter always shows the full history, so the toggle only appears
  // on the unfiltered view.
  const filterToggle =
    nFilter !== null
      ? ''
      : currentOnly
        ? `<strong>current records</strong> &middot; <a href="${href(sort, dir, false)}">include superseded</a> &nbsp;&middot;&nbsp; `
        : `<a href="${href(sort, dir, true)}">current records</a> &middot; <strong>include superseded</strong> &nbsp;&middot;&nbsp; `
  // The modulus filter is a plain GET form (the page has no JS); hidden inputs
  // mirror href() so submitting preserves the sort state.
  const hiddenState =
    (sort === 'exponent' && dir === 'desc'
      ? ''
      : `<input type="hidden" name="sort" value="${sort}"><input type="hidden" name="dir" value="${dir}">`) +
    (userFilter === null ? '' : `<input type="hidden" name="user" value="${userFilter}">`)
  const modulusFilter =
    `<form class="inline-form modulus-filter" method="get" action="/witnesses">${hiddenState}` +
    `<label>N&nbsp;=&nbsp;<input name="n" type="number" min="2" max="50000" step="1" ` +
    `value="${nFilter ?? ''}" placeholder="any"></label> ` +
    `<button class="link-button" type="submit">filter</button></form>` +
    (nFilter === null
      ? ''
      : ` &middot; <a href="${href(sort, dir, true, null)}">clear</a>`)
  // The submitter filter is only reachable by link (from a profile page), so it
  // shows as a label with a way out rather than a form.
  const submitterFilter =
    userFilter === null
      ? ''
      : ` &nbsp;&middot;&nbsp; submitted by <strong>${escapeHtml(
          submitterName ?? `user #${userFilter}`,
        )}</strong> &middot; <a href="${href(sort, dir, currentOnly, nFilter, 1, null)}">all submitters</a>`

  const totalPages = Math.max(1, Math.ceil(total / WITNESSES_PAGE_SIZE))
  const from = (page - 1) * WITNESSES_PAGE_SIZE
  const showing =
    rows.length === 0
      ? `no witnesses on page ${page.toLocaleString('en-US')}`
      : `showing ${(from + 1).toLocaleString('en-US')}&ndash;${(from + rows.length).toLocaleString(
          'en-US',
        )} of ${total.toLocaleString('en-US')} witnesses`
  const pageLink = (label: string, p: number, enabled: boolean): string =>
    enabled ? `<a href="${href(sort, dir, currentOnly, nFilter, p)}">${label}</a>` : `<span>${label}</span>`
  const pageNav =
    totalPages > 1
      ? `<div class="table-controls muted">${pageLink('&laquo; first', 1, page > 1)} &middot; ${pageLink(
          '&lsaquo; prev',
          page - 1,
          page > 1,
        )} &nbsp; page ${page.toLocaleString('en-US')} of ${totalPages.toLocaleString(
          'en-US',
        )} &nbsp; ${pageLink('next &rsaquo;', page + 1, page < totalPages)} &middot; ${pageLink(
          'last &raquo;',
          totalPages,
          page < totalPages,
        )}</div>`
      : ''

  const nLabel = nFilter === null ? '' : ` for N = ${nFilter.toLocaleString('en-US')}`
  const byLabel =
    userFilter === null ? '' : ` submitted by ${escapeHtml(submitterName ?? `user #${userFilter}`)}`
  const heading = (currentOnly ? 'Current record witnesses' : 'All witnesses') + nLabel + byLabel
  const description = currentOnly
    ? userFilter === null
      ? 'The largest known witness for each modulus.'
      : 'Witnesses from this submitter that are still the largest known for their modulus.'
    : `Every record-setting witness ever submitted${nLabel ? ' for this modulus' : ''}${
        userFilter === null ? '' : ' by this submitter'
      }; a superseded row was the record${nLabel ? '' : ' for its modulus'} until a larger set beat it.`

  const body = `
    <section class="prose">
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>${heading}</h2>
      <p class="muted">${description} Click a column header to sort; click
      again to reverse.</p>
      <div class="table-controls muted">${showing}
        &nbsp;&middot;&nbsp; ${filterToggle}${modulusFilter}${submitterFilter}
        &nbsp;&middot;&nbsp; <a href="/database.json" download>Download (JSON) &darr;</a></div>
      <div class="table-scroll">
      <table class="tokens-table witnesses-table">
        <thead><tr>
          ${th('id', 'witness')}
          ${th('n', 'N', 'num')}
          ${th('size', '|A|', 'num')}
          ${th('exponent', 'exponent', 'num', 'exponent log |A| / log N')}
          <th>submitter</th>
          ${th('date', 'submitted')}
          <th>status</th>
        </tr></thead>
        <tbody>${trs}</tbody>
      </table>
      </div>
      ${pageNav}
    </section>`
  return layout(`${heading} — ${SITE_NAME}`, body, user)
}

export function acknowledgePage(user: User | null = null): string {
  const body = `
    <section class="prose">
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>Acknowledgement</h2>
      <p>The Institute for Computer-Aided Reasoning in Mathematics
      <span class="nowrap">(<a class="external" href="https://icarm.io">ICARM</a>)</span> is supported by
      U.S. National Science Foundation Grant DMS 2425401. The views expressed on these pages do not
      necessarily reflect those of the NSF.</p>
      <p>If any ICARM meetings, resources, or innovation engineers are helpful to you, you can indicate
      that in associated publications with a brief acknowledgment, such as the following:</p>
      <ul>
        <li>&ldquo;Part of this research has been carried out at the Institute for Computer-Aided
        Reasoning (ICARM), which is supported by NSF Grant DMS 2425401.&rdquo;</li>
        <li>&ldquo;This research made use of the Ruzsa genus-one problem site, maintained by the
        Institute for Computer-Aided Reasoning (ICARM) under NSF Grant DMS 2425401.&rdquo;</li>
        <li>&ldquo;We are grateful to the Institute for Computer-Aided Reasoning (ICARM) for technical
        support provided under NSF Grant DMS 2425401.&rdquo;</li>
      </ul>
    </section>`
  return layout(`Acknowledgement — ${SITE_NAME}`, body, user)
}

/**
 * OAuth consent screen for MCP clients. The original authorization query
 * string rides along in a hidden field so the POST can re-validate it.
 */
export function consentPage(
  user: User,
  clientName: string,
  redirectHost: string,
  query: string,
): string {
  const name = escapeHtml(user.display_name || user.email || 'user')
  const client = escapeHtml(clientName)
  const body = `
    <section class="prose">
      <h2>Authorize ${client}?</h2>
      <p><strong>${client}</strong> (redirecting to <code>${escapeHtml(redirectHost)}</code>)
      wants to connect to ${escapeHtml(SITE_NAME)} as <strong>${name}</strong>.</p>
      <p>If you approve, it will be able to verify candidate sets and submit record
      witnesses attributed to your account. It will not be able to manage your API
      tokens, edit your profile, or log in as you on this site. You can revoke access
      any time by disconnecting it on the client&rsquo;s side.</p>
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="query" value="${escapeHtml(query)}" />
        <button type="submit" name="decision" value="approve">Approve</button>
        &nbsp;
        <button type="submit" name="decision" value="deny">Deny</button>
      </form>
    </section>`
  return layout(`Authorize ${clientName} — ${SITE_NAME}`, body, user)
}

/**
 * Shown to a person who opens /mcp in a browser. MCP clients never see this:
 * they don't ask for text/html, so they get the OAuth 401 challenge instead.
 */
export function mcpInfoPage(user: User | null = null): string {
  const body = `
    <section class="prose">
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>MCP endpoint</h2>
      <p>This URL is a <a class="external" href="https://modelcontextprotocol.io">Model Context
      Protocol</a> server, meant for AI assistants rather than browsers. Connect an MCP client
      to it and the assistant can look up records, verify candidate sets, and submit witnesses
      from inside a conversation.</p>
      <ul>
        <li><strong>Claude.ai</strong> &mdash; add <code>https://ruzsa-genus-one.icarm.cloud/mcp</code>
        under Settings &rarr; Connectors (on Team/Enterprise plans an Owner adds it in
        Organization settings &rarr; Connectors).</li>
        <li><strong>ChatGPT</strong> &mdash; add it as a connector in developer mode.</li>
        <li><strong>Claude Code / other MCP clients</strong> &mdash; point them at the same URL
        (streamable HTTP transport).</li>
      </ul>
      <p>Connecting signs you in with GitHub &mdash; the same account as this website &mdash; and
      record submissions made through the connector are attributed to you.</p>
      <p>Tools: <code>list_records</code>, <code>get_record</code>, <code>verify_witness</code>,
      <code>submit_witness</code>. See the <a href="/api">API docs</a> for details, including the
      plain JSON API.</p>
    </section>`
  return layout(`MCP endpoint — ${SITE_NAME}`, body, user)
}

export function notFoundPage(user: User | null = null): string {
  return layout('Not found', `<section class="prose"><p>Page not found.</p></section>`, user)
}
