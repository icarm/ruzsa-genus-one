// MCP endpoint: exposes verification and record submission as tools for MCP
// clients (Claude.ai custom connectors, ChatGPT connectors, MCP-aware CLIs).
//
// Auth is handled by the OAuthProvider wrapper in index.ts: it validates the
// bearer token before this handler runs and delivers the authenticated user
// via ctx.props (the props stored at authorization time in /oauth/authorize).
// The handler itself never sees or parses tokens.

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { Bindings } from './auth'
import { checkSubmissionRateLimit } from './rateLimit'
import {
  COMMENT_MAX,
  currentRecordForModulus,
  currentRecords,
  postCommentary,
  recordWitness,
} from './store'
import { MAX_N, MAX_SET_SIZE, verify } from './verify'
import { notifyNewBestExponent } from './zulip'

/** Stored in the OAuth grant at consent time; decrypted into ctx.props. */
export interface McpProps extends Record<string, unknown> {
  userId: number
  displayName: string | null
}

const PROBLEM_BLURB =
  `Ruzsa's genus-one problem: fix a modulus N and find a large subset A of Z/NZ ` +
  `with no nontrivial solutions to a + 3b ≡ 2c + 2d (mod N) — nontrivial meaning ` +
  `not all of a, b, c, d equal. Two measures are reported for a valid set: ratio = |A|/√N ` +
  `and exponent = log|A|/log N. Best known constructions sit at the √N barrier ` +
  `(ratio ≈ 1, exponent ≈ 0.5); the conjecture is that exponents approaching 1 are ` +
  `possible, so anything with ratio > 1 (exponent > 0.5) would be a breakthrough. ` +
  `The site records the largest known valid set for each N. ` +
  `Limits: 2 ≤ N ≤ ${MAX_N}, |A| ≤ ${MAX_SET_SIZE}.`

/** log|A| / log N — the site's "exponent" (√N barrier = 0.5). */
function exponentOf(n: number, size: number): number {
  return Math.log(size) / Math.log(n)
}

const setInputSchema = z.object({
  n: z.number().int().describe(`The modulus N (2 ≤ N ≤ ${MAX_N}).`),
  elements: z
    .array(z.number().int())
    .describe(
      `The elements of A as integers (reduced mod N on the server; duplicates after reduction are rejected). At most ${MAX_SET_SIZE} elements.`,
    ),
})

function jsonResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    isError,
  }
}

// Both verification and submission run the O(|A|²) check, so both draw from
// the same per-user rate-limit budget as web and API submissions.
async function rateLimited(env: Bindings, userId: number) {
  const rate = await checkSubmissionRateLimit(env, userId)
  if (rate.allowed) return null
  return jsonResult(
    {
      ok: false,
      error: `rate limit exceeded: ${rate.limit} verifications per ${rate.retryAfter} seconds; retry in about ${rate.retryAfter} seconds`,
    },
    true,
  )
}

function buildServer(env: Bindings, props: McpProps, ctx: ExecutionContext): McpServer {
  const server = new McpServer({ name: 'ruzsa-genus-one', version: '1.0.0' })

  server.registerTool(
    'list_records',
    {
      title: 'List current records',
      description:
        `List the current record witness for every modulus that has one. ${PROBLEM_BLURB} ` +
        `Returns one entry per modulus: the record size, the ratio and exponent, and the witness id. ` +
        `Use get_record to fetch a record's elements.`,
      inputSchema: z.object({}),
    },
    async () => {
      const records = await currentRecords(env)
      return jsonResult({
        count: records.length,
        records: records.map((r) => ({
          n: r.n,
          size: r.size,
          ratio: r.size / Math.sqrt(r.n),
          exponent: exponentOf(r.n, r.size),
          witnessId: r.id,
          url: `https://ruzsa-genus-one.icarm.cloud/witness/${r.id}`,
        })),
      })
    },
  )

  server.registerTool(
    'get_record',
    {
      title: 'Get the record for a modulus',
      description:
        `Fetch the current record witness for one modulus N, including its full element list — ` +
        `useful as a starting point for constructing something larger. Returns null when no ` +
        `witness has been recorded for that N yet.`,
      inputSchema: z.object({
        n: z.number().int().describe(`The modulus N (2 ≤ N ≤ ${MAX_N}).`),
      }),
    },
    async ({ n }) => {
      const record = await currentRecordForModulus(env, n)
      if (!record) return jsonResult({ n, record: null })
      return jsonResult({
        n,
        record: {
          witnessId: record.id,
          size: record.size,
          ratio: record.ratio,
          exponent: exponentOf(record.n, record.size),
          elements: JSON.parse(record.elements) as number[],
          submitter: record.submitter,
          created_at: record.created_at,
          url: `https://ruzsa-genus-one.icarm.cloud/witness/${record.id}`,
        },
      })
    },
  )

  server.registerTool(
    'verify_witness',
    {
      title: 'Verify a candidate set',
      description:
        `Check whether a set A is solution-free for a + 3b ≡ 2c + 2d (mod N), without ` +
        `submitting it. ${PROBLEM_BLURB} Returns valid/invalid, the size, ratio, and exponent, and a ` +
        `concrete counterexample (a, b, c, d) when invalid.`,
      inputSchema: setInputSchema,
    },
    async ({ n, elements }) => {
      const limited = await rateLimited(env, props.userId)
      if (limited) return limited
      const result = verify(n, elements)
      if (!result.ok) return jsonResult(result, true)
      // The reduced element list is redundant for tool output (the caller
      // already has the set); dropping it keeps responses small.
      const { elements: _elements, ...rest } = result
      return jsonResult({ ...rest, exponent: exponentOf(result.N, result.size) })
    },
  )

  server.registerTool(
    'submit_witness',
    {
      title: 'Submit a witness',
      description:
        `Verify a set A and, when it is valid and strictly larger than the current record ` +
        `for its modulus, record it as the new record attributed to the authenticated user ` +
        `(${props.displayName ?? 'unnamed user'}). Anything else — invalid, or valid but not ` +
        `record-setting — is reported but not stored. Verify locally with verify_witness ` +
        `first if unsure; both tools share the submission rate limit. Optional commentary ` +
        `(how the set was constructed, search method, etc.) is attached to the new witness ` +
        `page when — and only when — the submission sets a record.`,
      inputSchema: setInputSchema.extend({
        commentary: z
          .string()
          .max(COMMENT_MAX)
          .optional()
          .describe(
            `Optional public commentary for the new witness page — e.g. how the set was found. ` +
              `Applied only when the submission sets a record; editable later on the website. ` +
              `Plain text, except that "witness#123" is rendered as a link to that witness. ` +
              `At most ${COMMENT_MAX} characters.`,
          ),
      }),
    },
    async ({ n, elements, commentary }) => {
      const limited = await rateLimited(env, props.userId)
      if (limited) return limited
      const result = verify(n, elements)
      if (!result.ok) return jsonResult(result, true)
      const { elements: _elements, ...withoutElements } = result
      const rest = { ...withoutElements, exponent: exponentOf(result.N, result.size) }
      if (!result.valid) return jsonResult(rest)
      const record = await recordWitness(env, result, props.userId)
      if (record.recorded) {
        ctx.waitUntil(
          notifyNewBestExponent(
            env,
            record,
            result,
            props.displayName,
            'https://ruzsa-genus-one.icarm.cloud',
          ),
        )
      }
      // Commentary only lands on a record-setting submission: the new witness
      // is the submitter's own row, so nobody else's notes are at risk.
      let commentaryApplied: boolean | undefined
      if (typeof commentary === 'string' && commentary.trim() !== '') {
        commentaryApplied = record.recorded
        if (record.recorded) {
          await postCommentary(env, record.witnessId, props.userId, commentary)
        }
      }
      return jsonResult({
        ...rest,
        record,
        ...(commentaryApplied !== undefined ? { commentaryApplied } : {}),
        ...(record.recorded
          ? { url: `https://ruzsa-genus-one.icarm.cloud/witness/${record.witnessId}` }
          : {}),
      })
    },
  )

  return server
}

// The OAuthProvider invokes this like an ExportedHandler, with the grant's
// props on ctx. A fresh handler per request keeps concurrent requests from
// sharing any state; construction is cheap and the transport is stateless.
export const mcpApiHandler = {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const props = ctx.props as McpProps | undefined
    if (!props || typeof props.userId !== 'number') {
      return Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }))
    }
    return createMcpHandler(() => buildServer(env, props, ctx)).fetch(request)
  },
}
