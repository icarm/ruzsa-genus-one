import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
} from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import { mcpApiHandler, type McpProps } from './mcp'
import {
  acknowledgePage,
  activityPage,
  apiDocsPage,
  commentaryHistoryPage,
  consentPage,
  landingPage,
  leaderboardPage,
  mcpInfoPage,
  notFoundPage,
  profilePage,
  resultPage,
  witnessDetailPage,
  parseWitnessesQuery,
  WITNESSES_PAGE_SIZE,
  witnessesPage,
  type FormState,
} from './pages'
import {
  type AppEnv,
  type Bindings,
  generateApiToken,
  loadCurrentUser,
  loadUserFromToken,
  startOAuth,
  handleCallback,
  logout,
  updateSessionUser,
} from './auth'
import {
  listWitnesses,
  COMMENT_MAX,
  commentaryHistory,
  currentRecords,
  leaderboard,
  listTokens,
  loadWitness,
  postCommentary,
  recentActivity,
  recordWitness,
  userWitnessStats,
  userDisplayName,
  type RecordStatus,
} from './store'
import {
  MAX_ELEMENTS_TEXT_BYTES,
  MAX_SET_SIZE,
  parseElements,
  verify,
  type VerifyResult,
} from './verify'
import {
  checkSubmissionRateLimit,
  SUBMISSION_RATE_LIMIT,
  SUBMISSION_RATE_PERIOD_SEC,
} from './rateLimit'
import { notifyNewBestExponent } from './zulip'

const rateLimitMessage = `submission rate limit exceeded: ${SUBMISSION_RATE_LIMIT} per ${SUBMISSION_RATE_PERIOD_SEC} seconds`

const app = new Hono<AppEnv>()

// Resolve the current user (session cookie, else API bearer token) for every
// request. Both lookups short-circuit cheaply when their credential is absent.
app.use('*', async (c, next) => {
  const user = (await loadCurrentUser(c)) ?? (await loadUserFromToken(c))
  c.set('user', user)
  await next()
})

app.get('/', async (c) =>
  c.html(
    landingPage(
      c.get('user'),
      c.req.query('expired') === '1',
      c.req.query('plot') === 'size' ? 'size' : 'exponent',
    ),
  ),
)

// Compact feed for the client-rendered homepage plot (see public/plot.js):
// one [witnessId, n, size] triple per modulus with a record.
app.get('/records.json', async (c) =>
  c.json((await currentRecords(c.env)).map((r) => [r.id, r.n, r.size])),
)

app.get('/auth/:provider', startOAuth)
app.get('/auth/:provider/callback', handleCallback)
app.post('/auth/logout', logout)

app.get('/api', (c) => c.html(apiDocsPage(c.get('user'))))

// Every record witness (current and superseded) as one JSON download.
//
// The table is 60k+ rows with full element lists (tens of MB as JSON), so
// building the payload in memory blew the Worker memory limit. Instead the
// body is streamed: keyset-paginated batches over the (n, size) index, each
// row's stored `elements` JSON spliced in verbatim, written through a
// TransformStream so memory stays at ~one batch regardless of table size.
//
// The ETag is derived from (row count, max id) rather than the body bytes —
// the table is append-only, so this catches every new witness; the one thing
// it misses is a submitter renaming themselves between records. no-cache =
// clients may store but must revalidate; a fresh request returns 304 (no
// body) when nothing changed.
app.get('/database.json', async (c) => {
  const meta = await c.env.DB.prepare(
    'SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId FROM witnesses',
  ).first<{ count: number; maxId: number }>()
  const count = meta?.count ?? 0
  const etag = `W/"${count}-${meta?.maxId ?? 0}"`
  const headers = {
    'content-type': 'application/json; charset=UTF-8',
    'content-disposition': 'attachment; filename="ruzsa-genus-one-records.json"',
    'cache-control': 'no-cache',
    etag,
  }
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers })

  const db = c.env.DB
  const { readable, writable } = new TransformStream<Uint8Array>()
  c.executionCtx.waitUntil(
    (async () => {
      const writer = writable.getWriter()
      const encoder = new TextEncoder()
      try {
        await writer.write(encoder.encode(`{"count":${count},"witnesses":[`))
        // Keyset pagination in (n, size) order — the unique index the table
        // already has — so each batch is an indexed range scan.
        type DumpRow = {
          id: number
          n: number
          size: number
          ratio: number
          elements: string
          created_at: string
          submitter: string | null
          is_current: number
        }
        let lastN = -1
        let lastSize = -1
        let first = true
        for (;;) {
          const { results }: { results: DumpRow[] } = await db
            .prepare(
              `SELECT w.id, w.n, w.size, w.ratio, w.elements, w.created_at,
                      u.display_name AS submitter,
                      (w.size = (SELECT MAX(size) FROM witnesses WHERE n = w.n)) AS is_current
                 FROM witnesses w LEFT JOIN users u ON u.id = w.submitter_user_id
                WHERE (w.n, w.size) > (?, ?)
                ORDER BY w.n, w.size LIMIT 500`,
            )
            .bind(lastN, lastSize)
            .all<DumpRow>()
          if (results.length === 0) break
          let chunk = ''
          for (const r of results) {
            // r.elements is already JSON array text; splice it in verbatim.
            chunk +=
              (first ? '' : ',') +
              `{"id":${r.id},"n":${r.n},"size":${r.size},"ratio":${r.ratio},` +
              `"elements":${r.elements},"submitter":${JSON.stringify(r.submitter)},` +
              `"created_at":${JSON.stringify(r.created_at)},"current":${r.is_current ? 'true' : 'false'}}`
            first = false
          }
          await writer.write(encoder.encode(chunk))
          lastN = results[results.length - 1].n
          lastSize = results[results.length - 1].size
        }
        await writer.write(encoder.encode(']}'))
        await writer.close()
      } catch (err) {
        console.error('database.json stream failed:', err)
        await writer.abort(err)
      }
    })(),
  )
  return new Response(readable, { status: 200, headers })
})

app.get('/acknowledge', (c) => c.html(acknowledgePage(c.get('user'))))

app.get('/witnesses', async (c) => {
  const q = parseWitnessesQuery({
    sort: c.req.query('sort'),
    dir: c.req.query('dir'),
    all: c.req.query('all'),
    n: c.req.query('n'),
    user: c.req.query('user'),
    page: c.req.query('page'),
  })
  const [{ rows, total }, submitterName] = await Promise.all([
    listWitnesses(c.env, {
      sort: q.sort,
      dir: q.dir,
      currentOnly: q.currentOnly,
      n: q.nFilter,
      submitter: q.userFilter,
      limit: WITNESSES_PAGE_SIZE,
      offset: (q.page - 1) * WITNESSES_PAGE_SIZE,
    }),
    q.userFilter === null ? null : userDisplayName(c.env, q.userFilter),
  ])
  return c.html(witnessesPage(rows, total, q, c.get('user'), submitterName))
})

app.get('/witness/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.html(notFoundPage(c.get('user')), 404)
  const loaded = await loadWitness(c.env, id)
  if (!loaded) return c.html(notFoundPage(c.get('user')), 404)
  return c.html(
    witnessDetailPage(loaded.witness, loaded.comment, c.get('user'), c.req.query('new') === '1'),
  )
})

app.post('/witness/:id/commentary', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.html(notFoundPage(user), 404)
  const exists = await c.env.DB.prepare('SELECT id FROM witnesses WHERE id = ?').bind(id).first()
  if (!exists) return c.html(notFoundPage(user), 404)
  const form = await c.req.parseBody()
  // An explicit empty string is a deliberate "clear"; a missing field is a
  // malformed request and must not clear anything.
  if (typeof form.content !== 'string') {
    return c.text('missing or invalid form field: content', 400)
  }
  const content = form.content.slice(0, COMMENT_MAX)
  await postCommentary(c.env, id, user.id, content)
  return c.redirect(`/witness/${id}`, 302)
})

app.get('/witness/:id/commentary-history', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.html(notFoundPage(c.get('user')), 404)
  const loaded = await loadWitness(c.env, id)
  if (!loaded) return c.html(notFoundPage(c.get('user')), 404)
  return c.html(
    commentaryHistoryPage(loaded.witness, await commentaryHistory(c.env, id), c.get('user')),
  )
})

app.get('/leaderboard', async (c) => c.html(leaderboardPage(await leaderboard(c.env), c.get('user'))))

app.get('/recent', async (c) => {
  const p = Math.max(0, Math.floor(Number(c.req.query('p')) || 0))
  const { items, page, hasOlder } = await recentActivity(c.env, p)
  return c.html(activityPage(items, page, hasOlder, c.get('user')))
})

app.get('/profile', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github?return_to=/profile', 302)
  const [tokens, witnesses] = await Promise.all([
    listTokens(c.env, user.id),
    userWitnessStats(c.env, user.id),
  ])
  return c.html(profilePage(user, tokens, null, witnesses))
})

app.post('/profile/tokens', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const form = await c.req.parseBody()
  const name = String(form.name ?? '').trim().slice(0, 100) || null
  const newToken = await generateApiToken(c.env, user.id, name)
  const [tokens, witnesses] = await Promise.all([
    listTokens(c.env, user.id),
    userWitnessStats(c.env, user.id),
  ])
  return c.html(profilePage(user, tokens, newToken, witnesses))
})

app.post('/profile/tokens/:id/revoke', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const id = Number(c.req.param('id'))
  if (Number.isInteger(id)) {
    await c.env.DB.prepare(
      'UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    )
      .bind(id, user.id)
      .run()
  }
  return c.redirect('/profile', 302)
})

app.post('/profile/name', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const form = await c.req.parseBody()
  const name = String(form.name ?? '').trim().slice(0, 100)
  if (name) {
    await c.env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, user.id).run()
    await updateSessionUser(c, { display_name: name })
  }
  return c.redirect('/profile', 302)
})

function verifyFromText(nText: string, elementsText: string): VerifyResult {
  if (elementsText.length > MAX_ELEMENTS_TEXT_BYTES) {
    return { ok: false, error: 'submission too large' }
  }
  const nTrimmed = nText.trim()
  if (!/^\d+$/.test(nTrimmed)) {
    return { ok: false, error: 'N must be a positive integer' }
  }
  const N = Number(nTrimmed)
  const parsed = parseElements(elementsText)
  if (!Array.isArray(parsed)) {
    return { ok: false, error: parsed.error }
  }
  return verify(N, parsed)
}

// A stray GET (old bookmark, stale OAuth return) lands home rather than 404.
app.get('/verify', (c) => c.redirect('/', 302))

// Verdict + form state stashed between the POST and the redirected GET.
// The element list is dropped from the stored result (the page never shows
// it; the form echo comes from the raw text in `form`).
interface ResultFlash {
  result: VerifyResult
  record?: RecordStatus
  form: FormState
}

const RESULT_FLASH_TTL_SEC = 10 * 60

// Post/Redirect/Get: a record-setting submission redirects to its new witness
// page; anything else stores a short-lived flash and redirects to /result/:key,
// so reloading the result never re-submits the form.
app.post('/verify', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github?return_to=/', 302)
  const rate = await checkSubmissionRateLimit(c.env, user.id)
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfter))
    return c.html(
      resultPage(
        user,
        { ok: false, error: `${rateLimitMessage}; retry in about ${rate.retryAfter} seconds` },
        undefined,
        {},
      ),
      429,
    )
  }
  const body = await c.req.parseBody()
  const nText = typeof body.N === 'string' ? body.N : ''
  const elementsText = typeof body.A === 'string' ? body.A : ''
  const result = verifyFromText(nText, elementsText)
  let record: RecordStatus | undefined
  if (result.ok && result.valid) {
    record = await recordWitness(c.env, result, user.id)
    if (record.recorded) {
      c.executionCtx.waitUntil(
        notifyNewBestExponent(c.env, record, result, user.display_name ?? null, new URL(c.req.url).origin),
      )
      return c.redirect(`/witness/${record.witnessId}?new=1`, 303)
    }
  }
  const flash: ResultFlash = {
    result: result.ok ? { ...result, elements: [] } : result,
    record,
    form: { nValue: nText, elementsValue: elementsText },
  }
  const key = crypto.randomUUID()
  await c.env.SESSIONS.put(`result:${key}`, JSON.stringify(flash), {
    expirationTtl: RESULT_FLASH_TTL_SEC,
  })
  return c.redirect(`/result/${key}`, 303)
})

app.get('/result/:key', async (c) => {
  const key = c.req.param('key')
  if (!/^[0-9a-f-]{36}$/.test(key)) return c.html(notFoundPage(c.get('user')), 404)
  const flash = (await c.env.SESSIONS.get(`result:${key}`, 'json')) as ResultFlash | null
  if (!flash) return c.redirect('/?expired=1', 302)
  return c.html(resultPage(c.get('user'), flash.result, flash.record, flash.form))
})

app.post('/api/verify', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ ok: false, error: 'authentication required' }, 401)
  const rate = await checkSubmissionRateLimit(c.env, user.id)
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfter))
    return c.json(
      {
        ok: false,
        error: `${rateLimitMessage}; retry in about ${rate.retryAfter} seconds`,
        rateLimit: {
          limit: SUBMISSION_RATE_LIMIT,
          period: SUBMISSION_RATE_PERIOD_SEC,
          retryAfter: rate.retryAfter,
        },
      },
      429,
    )
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'request body must be JSON' }, 400)
  }
  const { N, A, commentary } = (body ?? {}) as { N?: unknown; A?: unknown; commentary?: unknown }
  if (typeof N !== 'number' || !Array.isArray(A)) {
    return c.json(
      { ok: false, error: 'expected {"N": <integer>, "A": [<integers>]}' },
      400,
    )
  }
  if (commentary !== undefined) {
    if (typeof commentary !== 'string') {
      return c.json({ ok: false, error: 'commentary must be a string' }, 400)
    }
    if (commentary.length > COMMENT_MAX) {
      return c.json(
        { ok: false, error: `commentary may be at most ${COMMENT_MAX} characters` },
        400,
      )
    }
  }
  if (A.length > MAX_SET_SIZE) {
    return c.json({ ok: false, error: `the set may have at most ${MAX_SET_SIZE} elements` }, 400)
  }
  if (!A.every((x) => typeof x === 'number' && Number.isSafeInteger(x))) {
    return c.json({ ok: false, error: 'all elements of A must be integers' }, 400)
  }
  const result = verify(N, A as number[])
  if (!result.ok) return c.json(result, 400)
  let record: RecordStatus | undefined
  // Commentary rides along only when the submission sets a record: the new
  // witness is the submitter's own row, so nobody else's notes are at risk.
  let commentaryApplied: boolean | undefined
  if (result.valid) {
    record = await recordWitness(c.env, result, user.id)
    if (record.recorded) {
      c.executionCtx.waitUntil(
        notifyNewBestExponent(c.env, record, result, user.display_name ?? null, new URL(c.req.url).origin),
      )
    }
    if (typeof commentary === 'string' && commentary.trim() !== '') {
      commentaryApplied = record.recorded
      if (record.recorded) {
        await postCommentary(c.env, record.witnessId, user.id, commentary)
      }
    }
  }
  // Echoing the (possibly large) element list back is redundant for API users.
  const { elements: _elements, ...rest } = result
  return c.json(
    record
      ? { ...rest, record, ...(commentaryApplied !== undefined ? { commentaryApplied } : {}) }
      : rest,
  )
})

// ---------------------------------------------------------------------------
// OAuth authorization endpoint for MCP clients (Claude.ai, ChatGPT, etc.).
//
// The OAuthProvider wrapper (bottom of this file) owns the token, metadata,
// and registration endpoints and validates bearer tokens on /mcp. This
// endpoint is the one piece it delegates to the application: authenticate the
// user (via the existing GitHub-backed session) and ask for consent.

// --- ChatGPT client pre-registration ----------------------------------------
// Most MCP clients (Claude.ai, MCP Inspector, ...) register themselves via
// dynamic client registration at /oauth/register. ChatGPT instead identifies
// itself with a Client ID Metadata Document: its client_id is a URL like
// https://chatgpt.com/oauth/<slug>/client.json. Serving that the intended way
// is blocked twice over — workers-oauth-provider (0.10.1) rejects CIMD clients
// that declare private_key_jwt (ChatGPT does, though it supports plain PKCE
// too), and chatgpt.com's CDN 403s metadata fetches from the Workers runtime
// anyway. Fortunately ChatGPT's client_id and redirect URI are rigidly paired
// by the slug (client.json above ↔ /connector/oauth/<slug>), so its
// registration can be derived without fetching anything. With the provider's
// own CIMD support off, URL-shaped client ids resolve through the ordinary
// OAUTH_KV registration lookup — so pre-register ChatGPT's identity on sight.
//
// Safe: authorization codes can only redirect back to chatgpt.com, PKCE binds
// them to the flow's real initiator, and the provider still enforces exact
// redirect-URI matching. Revisit if the provider's CIMD support learns to
// accept clients like ChatGPT (then delete this and enable CIMD instead).
async function seedChatGptClient(env: Bindings, clientId: string | null): Promise<void> {
  const m = clientId?.match(/^https:\/\/chatgpt\.com\/oauth\/([A-Za-z0-9_-]+)\/client\.json$/)
  if (!m) return
  await env.OAUTH_KV.put(
    `client:${clientId}`,
    JSON.stringify({
      clientId,
      redirectUris: [`https://chatgpt.com/connector/oauth/${m[1]}`],
      clientName: 'ChatGPT',
      clientUri: 'https://chatgpt.com/',
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      registrationDate: Math.floor(Date.now() / 1000),
      tokenEndpointAuthMethod: 'none',
    }),
    // The provider's default TTL for dynamically registered clients; refreshed
    // on every authorize, so an actively used connector never expires.
    { expirationTtl: 90 * 24 * 60 * 60 },
  )
}

// An OAuth error redirect back to the client, per the provider README: only
// safe when parseAuthRequest attached a redirectUri (client + URI validated).
function oauthErrorRedirect(
  redirectUri: string,
  code: string,
  description: string,
  state?: string | null,
  issuer?: string | null,
): Response {
  const redirect = new URL(redirectUri)
  redirect.searchParams.set('error', code)
  redirect.searchParams.set('error_description', description)
  if (state) redirect.searchParams.set('state', state)
  if (issuer) redirect.searchParams.set('iss', issuer)
  return Response.redirect(redirect.toString(), 302)
}

app.get('/oauth/authorize', async (c) => {
  await seedChatGptClient(c.env, c.req.query('client_id') ?? null)
  let oauthRequest: AuthRequest
  try {
    oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error
    if (!error.redirectUri) return c.text(error.description, 400)
    return oauthErrorRedirect(
      error.redirectUri,
      error.code,
      error.description,
      error.state,
      error.issuer,
    )
  }
  const user = c.get('user')
  if (!user) {
    const url = new URL(c.req.url)
    const returnTo = encodeURIComponent(url.pathname + url.search)
    return c.redirect(`/auth/github?return_to=${returnTo}`, 302)
  }
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId)
  if (!client) return c.text('Unknown OAuth client', 400)
  const clientName = client.clientName || oauthRequest.clientId
  const redirectHost = new URL(oauthRequest.redirectUri).host
  const query = new URL(c.req.url).search.slice(1)
  return c.html(consentPage(user, clientName, redirectHost, query))
})

app.post('/oauth/authorize', async (c) => {
  const user = c.get('user')
  if (!user) return c.text('Session expired — please retry from the client.', 401)
  const form = await c.req.parseBody()
  if (typeof form.query !== 'string' || typeof form.decision !== 'string') {
    return c.text('malformed consent form', 400)
  }
  // Re-parse the original authorization query rather than trusting hidden
  // fields for individual OAuth parameters; parseAuthRequest re-validates
  // the client, redirect URI, and PKCE from scratch.
  const synthetic = new Request(`${new URL(c.req.url).origin}/oauth/authorize?${form.query}`)
  // Rare, but the seeded client record may have expired between GET and POST.
  await seedChatGptClient(c.env, new URLSearchParams(form.query).get('client_id'))
  let oauthRequest: AuthRequest
  try {
    oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(synthetic)
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error
    return c.text(error.description, 400)
  }
  if (form.decision !== 'approve') {
    return oauthErrorRedirect(
      oauthRequest.redirectUri,
      'access_denied',
      'The user denied the authorization request.',
      oauthRequest.state,
      oauthRequest.issuer,
    )
  }
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId)
  const props: McpProps = { userId: user.id, displayName: user.display_name ?? null }
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: String(user.id),
    metadata: { clientName: client?.clientName ?? null },
    scope: oauthRequest.scope,
    props,
  })
  return c.redirect(redirectTo, 302)
})

// Help text for a person who opens the MCP endpoint in a browser. Only
// reachable via the front-door check below — the OAuth provider otherwise
// answers every unauthenticated /mcp request itself with a bare 401.
app.get('/mcp', (c) => c.html(mcpInfoPage(c.get('user'))))

app.notFound((c) => c.html(notFoundPage(c.get('user')), 404))

// The provider owns /mcp (bearer-token validation → mcpApiHandler),
// /oauth/token, /oauth/register, and the /.well-known metadata endpoints.
// Everything else — the site, plus /oauth/authorize above — falls through to
// the Hono app.
const provider = new OAuthProvider<Bindings>({
  apiRoute: '/mcp',
  apiHandler: mcpApiHandler,
  defaultHandler: { fetch: (req, env, ctx) => app.fetch(req, env, ctx) },
  authorizeEndpoint: '/oauth/authorize',
  tokenEndpoint: '/oauth/token',
  scopesSupported: ['submit'],
  // Long-lived tokens: the connector is low-stakes (additive submissions to a
  // public leaderboard, attributed to the grantee) and short TTLs just cause
  // re-auth friction in clients. Refresh outlives access by 60 days so a
  // client that refreshes only at access-token expiry never finds its refresh
  // token already dead.
  accessTokenTTL: 30 * 24 * 60 * 60,
  refreshTokenTTL: 90 * 24 * 60 * 60,
  // Preferred registration path for MCP clients (2026 spec); DCR kept for
  // compatibility with clients that predate CIMD.
  // The provider's own CIMD support is deliberately OFF — it can't serve
  // ChatGPT (see seedChatGptClient above), and every other known client uses
  // dynamic client registration. With it off, URL-shaped client ids resolve
  // through the ordinary OAUTH_KV lookup, which is what makes the ChatGPT
  // pre-registration work.
  clientIdMetadataDocumentEnabled: false,
  clientRegistrationEndpoint: '/oauth/register',
})

// Front door: a person opening /mcp in a browser (GET, wants HTML, no bearer
// token) gets the help page instead of the provider's empty 401. MCP clients
// never ask for text/html, so their discovery flow — including the 401 with
// the WWW-Authenticate challenge — is untouched.
export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url)
    if (
      url.pathname === '/mcp' &&
      request.method === 'GET' &&
      !request.headers.has('authorization') &&
      (request.headers.get('accept') ?? '').includes('text/html')
    ) {
      return app.fetch(request, env, ctx)
    }
    return provider.fetch(request, env, ctx)
  },
}
