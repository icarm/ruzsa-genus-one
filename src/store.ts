// D1 persistence for record witnesses. The witnesses table is append-only:
// every record-setting witness is kept, so the history of records for a
// modulus survives being beaten.

import type { Bindings } from './auth'
import type { RecordPoint, TokenRow } from './pages'
import type { VerifyResult } from './verify'

export const COMMENT_MAX = 4000

export interface CommentView {
  id: number
  content: string
  created_at: string
  author: string | null
}

/** One witness row as shown on its page. */
export interface WitnessView {
  id: number
  n: number
  size: number
  elements: string // JSON array text
  created_at: string
  submitter_name: string | null
  current_comment_id: number | null
  record_size: number // MAX(size) for this n — equal to size when still the record
  record_id: number // witness id holding that record — the row's own id when current
}

export async function loadWitness(
  env: Bindings,
  id: number,
): Promise<{ witness: WitnessView; comment: CommentView | null } | null> {
  const witness = await env.DB.prepare(
    `SELECT w.id, w.n, w.size, w.elements, w.created_at, w.current_comment_id,
            u.display_name AS submitter_name,
            (SELECT MAX(size) FROM witnesses WHERE n = w.n) AS record_size,
            (SELECT id FROM witnesses WHERE n = w.n ORDER BY size DESC LIMIT 1) AS record_id
       FROM witnesses w LEFT JOIN users u ON u.id = w.submitter_user_id
       WHERE w.id = ?`,
  )
    .bind(id)
    .first<WitnessView>()
  if (!witness) return null
  let comment: CommentView | null = null
  if (witness.current_comment_id != null) {
    comment = await env.DB.prepare(
      `SELECT cl.id, cl.content, cl.created_at, u.display_name AS author
         FROM commentary_log cl LEFT JOIN users u ON u.id = cl.user_id
         WHERE cl.id = ?`,
    )
      .bind(witness.current_comment_id)
      .first<CommentView>()
  }
  return { witness, comment }
}

// Record an edit to a witness's commentary and point the witness at it.
export async function postCommentary(
  env: Bindings,
  witnessId: number,
  userId: number,
  content: string,
): Promise<void> {
  const ins = await env.DB.prepare(
    'INSERT INTO commentary_log (witness_id, user_id, content) VALUES (?, ?, ?)',
  )
    .bind(witnessId, userId, content)
    .run()
  await env.DB.prepare('UPDATE witnesses SET current_comment_id = ? WHERE id = ?')
    .bind(ins.meta.last_row_id, witnessId)
    .run()
}

// Full edit history for a witness, newest first.
export function commentaryHistory(env: Bindings, witnessId: number): Promise<CommentView[]> {
  return env.DB.prepare(
    `SELECT cl.id, cl.content, cl.created_at, u.display_name AS author
       FROM commentary_log cl LEFT JOIN users u ON u.id = cl.user_id
       WHERE cl.witness_id = ? ORDER BY cl.id DESC`,
  )
    .bind(witnessId)
    .all<CommentView>()
    .then((r) => r.results)
}

// One row in the recent-activity feed: a record-setting witness or a
// commentary edit. Both carry the witness's n/size for context.
export interface ActivityItem {
  kind: 'record' | 'commentary'
  ts: string
  witness_id: number
  n: number
  size: number
  user: string | null
  content: string | null
}

export const ACTIVITY_PAGE_SIZE = 30

// Recent activity, newest first, paginated. Merges record witnesses and
// commentary edits in one timeline. `hasOlder` reports whether a further page
// exists (we fetch one extra row to find out).
export async function recentActivity(
  env: Bindings,
  page = 0,
): Promise<{ items: ActivityItem[]; page: number; hasOlder: boolean }> {
  const size = ACTIVITY_PAGE_SIZE
  const { results } = await env.DB.prepare(
    `SELECT kind, ts, witness_id, n, size, user, content FROM (
         SELECT 'record' AS kind, w.created_at AS ts, w.id AS witness_id,
                w.n, w.size, u.display_name AS user, NULL AS content
           FROM witnesses w LEFT JOIN users u ON u.id = w.submitter_user_id
         UNION ALL
         SELECT 'commentary' AS kind, cl.created_at AS ts, cl.witness_id AS witness_id,
                w.n, w.size, cu.display_name AS user, cl.content AS content
           FROM commentary_log cl
           LEFT JOIN users cu ON cu.id = cl.user_id
           JOIN witnesses w ON w.id = cl.witness_id
       )
       -- kind ASC tiebreak: at the same second-precision timestamp a
       -- commentary edit sorts above its witness in this newest-first feed,
       -- since the commentary logically follows the record.
       ORDER BY ts DESC, kind ASC
       LIMIT ? OFFSET ?`,
  )
    .bind(size + 1, page * size)
    .all<ActivityItem>()
  return { items: results.slice(0, size), page, hasOlder: results.length > size }
}

export function listTokens(env: Bindings, userId: number): Promise<TokenRow[]> {
  return env.DB.prepare(
    `SELECT id, name, prefix, created_at, last_used_at, revoked_at
       FROM api_tokens WHERE user_id = ? ORDER BY id DESC`,
  )
    .bind(userId)
    .all<TokenRow>()
    .then((r) => r.results)
}

/** Summary of one user's submissions: rows they set and how many still stand. */
export interface UserWitnessStats {
  submitted: number // record-setting witnesses attributed to the user
  held: number // of those, how many are still the record for their modulus
}

export function userWitnessStats(env: Bindings, userId: number): Promise<UserWitnessStats> {
  return env.DB.prepare(
    `SELECT COUNT(*) AS submitted,
            COALESCE(SUM(w.size = (SELECT MAX(size) FROM witnesses WHERE n = w.n)), 0) AS held
       FROM witnesses w WHERE w.submitter_user_id = ?`,
  )
    .bind(userId)
    .first<UserWitnessStats>()
    .then((r) => r ?? { submitted: 0, held: 0 })
}

/** One submitter's line on /leaderboard. */
export interface LeaderboardRow {
  user_id: number | null // null groups the anonymous submissions
  display_name: string | null
  submitted: number // record-setting witnesses attributed to the submitter
  held: number // of those, how many are still the record for their modulus
  best_exponent: number // max of log|A| / log N over their witnesses
  best_id: number // witness id achieving best_exponent
  best_n: number
  best_size: number
  last_submitted: string
}

/**
 * Every submitter with at least one record-setting witness, ranked by records
 * currently held, then best exponent, then total submitted. One grouped query;
 * the correlated subqueries pick out the witness that achieved the best exponent.
 * (`IS` rather than `=` so the anonymous NULL group matches itself.)
 */
export function leaderboard(env: Bindings): Promise<LeaderboardRow[]> {
  return env.DB.prepare(
    `SELECT w.submitter_user_id AS user_id, u.display_name,
            COUNT(*) AS submitted,
            COALESCE(SUM(w.size = (SELECT MAX(size) FROM witnesses WHERE n = w.n)), 0) AS held,
            MAX(log(w.size) / log(w.n)) AS best_exponent,
            b.id AS best_id, b.n AS best_n, b.size AS best_size,
            MAX(w.created_at) AS last_submitted
       FROM witnesses w
       LEFT JOIN users u ON u.id = w.submitter_user_id
       JOIN witnesses b ON b.id = (SELECT id FROM witnesses x
                                    WHERE x.submitter_user_id IS w.submitter_user_id
                                    ORDER BY log(x.size) / log(x.n) DESC, x.n LIMIT 1)
       GROUP BY w.submitter_user_id
       ORDER BY held DESC, best_exponent DESC, submitted DESC, last_submitted DESC`,
  )
    .all<LeaderboardRow>()
    .then((r) => r.results)
}

/** Display name for the submitter filter heading on /witnesses; null if no such user. */
export function userDisplayName(env: Bindings, userId: number): Promise<string | null> {
  return env.DB.prepare('SELECT display_name FROM users WHERE id = ?')
    .bind(userId)
    .first<{ display_name: string | null }>()
    .then((r) => (r ? r.display_name ?? '(unnamed)' : null))
}

/** One row on the /witnesses listing page. */
export interface WitnessListRow {
  id: number
  n: number
  size: number
  created_at: string
  submitter: string | null
  is_current: number // SQLite boolean: 1 when still the record for n
}

/** Sortable columns on the /witnesses listing. */
export type WitnessSort = 'id' | 'n' | 'size' | 'exponent' | 'date'

// ORDER BY expression per sort key. SQLite log() is base 10, but the base
// cancels in the quotient, so it orders identically to log|A| / log N.
const WITNESS_ORDER_BY: Record<WitnessSort, string> = {
  id: 'w.id',
  n: 'w.n',
  size: 'w.size',
  exponent: '(log(w.size) / log(w.n))',
  date: 'w.created_at',
}

export interface WitnessListQuery {
  sort: WitnessSort
  dir: 'asc' | 'desc'
  currentOnly: boolean // only rows that are still the record for their modulus
  n: number | null // restrict to one modulus
  submitter: number | null // restrict to one user's submissions
  limit: number
  offset: number
}

/**
 * One page of the witness listing plus the total row count for the filter.
 * Filtering, sorting, and pagination happen in SQL so a request never loads
 * the whole table (tens of thousands of rows and growing).
 */
export async function listWitnesses(
  env: Bindings,
  q: WitnessListQuery,
): Promise<{ rows: WitnessListRow[]; total: number }> {
  const where: string[] = []
  const binds: number[] = []
  if (q.n !== null) {
    where.push('w.n = ?')
    binds.push(q.n)
  }
  if (q.submitter !== null) {
    where.push('w.submitter_user_id = ?')
    binds.push(q.submitter)
  }
  if (q.currentOnly) where.push('w.size = (SELECT MAX(size) FROM witnesses WHERE n = w.n)')
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  const order = `${WITNESS_ORDER_BY[q.sort]} ${q.dir === 'asc' ? 'ASC' : 'DESC'}, w.n, w.size`
  const [count, page] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM witnesses w${whereSql}`).bind(...binds),
    env.DB.prepare(
      `SELECT w.id, w.n, w.size, w.created_at,
              u.display_name AS submitter,
              (w.size = (SELECT MAX(size) FROM witnesses WHERE n = w.n)) AS is_current
         FROM witnesses w LEFT JOIN users u ON u.id = w.submitter_user_id${whereSql}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
    ).bind(...binds, q.limit, q.offset),
  ])
  return {
    rows: page.results as WitnessListRow[],
    total: (count.results[0] as { total: number }).total,
  }
}

/** The current record witness for one modulus, with its element list. */
export interface RecordDetail {
  id: number
  n: number
  size: number
  ratio: number
  elements: string // JSON array text
  created_at: string
  submitter: string | null
}

export function currentRecordForModulus(env: Bindings, n: number): Promise<RecordDetail | null> {
  return env.DB.prepare(
    `SELECT w.id, w.n, w.size, w.ratio, w.elements, w.created_at,
            u.display_name AS submitter
       FROM witnesses w LEFT JOIN users u ON u.id = w.submitter_user_id
       WHERE w.n = ? ORDER BY w.size DESC LIMIT 1`,
  )
    .bind(n)
    .first<RecordDetail>()
}

export type ValidResult = Extract<VerifyResult, { ok: true }>

export interface RecordStatus {
  /** True when this submission set a new record for its modulus. */
  recorded: boolean
  /** Size of the current record after the attempt (>= the submission's size). */
  recordSize: number
  /** Row id of the current record witness (the new row when recorded). */
  witnessId: number
  /**
   * Only set on a tie (recorded false, recordSize equal): true when the
   * submitted set is element-for-element the current record witness, false
   * when it is a different set of the same size.
   */
  tiedExact?: boolean
}


/** The current record witness (id, n, size) for every modulus that has one. */
export async function currentRecords(env: Bindings): Promise<RecordPoint[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, n, size FROM witnesses w
       WHERE size = (SELECT MAX(size) FROM witnesses WHERE n = w.n)
       ORDER BY n`,
  ).all<RecordPoint>()
  return results
}

// Insert only when strictly larger than every stored witness for this
// modulus. D1 serializes writes, so the NOT EXISTS guard is race-free; the
// unique (n, size) index additionally rules out duplicate same-size rows.
export async function recordWitness(
  env: Bindings,
  result: ValidResult,
  userId: number,
): Promise<RecordStatus> {
  const ins = await env.DB.prepare(
    `INSERT INTO witnesses (n, size, ratio, elements, submitter_user_id)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE NOT EXISTS (SELECT 1 FROM witnesses WHERE n = ?1 AND size >= ?2)`,
  )
    .bind(result.N, result.size, result.ratio, JSON.stringify(result.elements), userId)
    .run()
  if ((ins.meta.changes ?? 0) > 0) {
    return { recorded: true, recordSize: result.size, witnessId: ins.meta.last_row_id as number }
  }
  const row = await env.DB.prepare(
    'SELECT id, size, elements FROM witnesses WHERE n = ? ORDER BY size DESC LIMIT 1',
  )
    .bind(result.N)
    .first<{ id: number; size: number; elements: string }>()
  const status: RecordStatus = {
    recorded: false,
    recordSize: row?.size ?? result.size,
    witnessId: row?.id ?? 0,
  }
  // On a tie, distinguish "resubmitted the record itself" from "a different
  // set of the same size". Both are stored sorted and reduced mod n, so
  // element-for-element equality is a string comparison.
  if (row && row.size === result.size) {
    status.tiedExact = row.elements === JSON.stringify(result.elements)
  }
  return status
}
