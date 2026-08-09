# Ruzsa's genus-one problem

A record-keeping site for a problem of Ruzsa: live at
[ruzsa-genus-one.icarm.cloud](https://ruzsa-genus-one.icarm.cloud).

## The problem

Fix a modulus N and hunt for a large subset A ⊆ Z/NZ with no nontrivial
solutions to

    a + 3b ≡ 2c + 2d (mod N)

(nontrivial: not all of a, b, c, d equal). This is a genus-one equation in
the sense of Ruzsa, [*Solving a linear equation in a set of integers I*,
Acta Arith. 65 (1993)](https://matwbn.icm.edu.pl/ksiazki/aa/aa65/aa6537.pdf).
Best known constructions have |A| = Θ(√N); the conjecture is that
|A| = N^(1−o(1)) is possible. The challenge: a *witness* — a verified
solution-free set — with |A| > √N, i.e. exponent log |A| / log N > 1/2.

## The site

- **Submit witnesses** (GitHub login required). Verification is pure
  TypeScript, O(|A|²) time and O(N) memory via a counting argument
  (`src/verify.ts`). Limits: N ≤ 50,000 and |A| ≤ 10,000.
- **Records.** A submission that strictly beats the record for its modulus
  is saved and attributed; beaten records are kept as history. The landing
  page plots r(N) against N on log-log axes with the √N barrier drawn in.
- **Witness pages** with a single editable commentary each (full edit
  history kept), plus a paginated recent-activity feed.
- **Zulip announcements.** A submission whose exponent strictly beats every
  previously recorded witness's is announced to Zulip via an incoming
  webhook (`src/zulip.ts`); skipped when the secret is unset.
- **JSON API** (`POST /api/verify`, bearer tokens managed on the profile
  page) and a full database download (`GET /database.json`). Docs at
  [/api](https://ruzsa-genus-one.icarm.cloud/api).
- **MCP server** (`/mcp`): a remote Model Context Protocol endpoint so AI
  chat clients (Claude.ai custom connectors, ChatGPT, Claude Code, …) can
  verify and submit witnesses mid-conversation. Tools: `list_records`,
  `get_record`, `verify_witness`, `submit_witness`. Auth is OAuth
  (`@cloudflare/workers-oauth-provider`) with consent at `/oauth/authorize`,
  delegating identity to the same GitHub login as the site; submissions are
  attributed to the connected account.

## Architecture

[Cloudflare Workers](https://developers.cloudflare.com/workers/) with
[Hono](https://hono.dev). Users, witnesses, commentary, and API tokens live
in D1 (`migrations/`); login sessions and post-submit result flashes live in
KV. Session cookies and API tokens are stored only as SHA-256 hashes.

The worker's default export is an `OAuthProvider` wrapper: it owns `/mcp`
(bearer-token validation → the MCP handler in `src/mcp.ts`), `/oauth/token`,
`/oauth/register`, and the `/.well-known` OAuth metadata; everything else
falls through to the Hono app, including the `/oauth/authorize` consent
screen. OAuth grants/tokens live in a dedicated KV namespace (`OAUTH_KV`).

## Development

    npm install
    npx wrangler d1 migrations apply ruzsa-genus-one --local
    npm run dev        # local server
    npm run typecheck

GitHub login needs a dev OAuth app (callback
`http://localhost:8787/auth/github/callback`) with its credentials in
`.dev.vars`:

    GITHUB_CLIENT_ID=...
    GITHUB_CLIENT_SECRET=...

## Deploy

    npx wrangler d1 migrations apply ruzsa-genus-one --remote
    npm run deploy

One-time setup: create the D1 database and KV namespace (ids in
`wrangler.jsonc`), and set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` via
`wrangler secret put` from a GitHub OAuth app whose callback URL is
`https://ruzsa-genus-one.icarm.cloud/auth/github/callback`.

Optionally set `ZULIP_WEBHOOK_URL` (also via `wrangler secret put`) to a
Zulip [Slack-compatible incoming webhook](https://zulip.com/integrations/doc/slack_incoming)
URL — from an *Incoming webhook* bot's API key, with the target channel and
topic baked in:

    https://icarm.zulipchat.com/api/v1/external/slack_incoming?api_key=<BOT_API_KEY>&stream=general&topic=Ruzsa+Genus+One

New-best-exponent records are then announced there. Unset, notifications
are skipped.
