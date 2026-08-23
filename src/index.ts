/**
 * @dsh-external/ui-usage-stats — host half.
 * Reads session logs through session-query/session-persistence and returns a
 * workspace -> session -> period -> model usage/cost tree sorted by last
 * activity time. Per-session results are cached in the project storage domain
 * keyed by the session's persistence revision; unchanged sessions reuse cached
 * results without re-reading their logs.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const name = '@dsh-external/ui-usage-stats'
export const inject = ['webServer', 'sessionQuery', 'sessionPersistence', 'storageDomain', 'credentials']

const API_PREFIX = '/@dsh-external/ui-usage-stats/api'
const STATS_PATH = '/@dsh-external/ui-usage-stats/api/stats'
const FILTERS_PATH = '/@dsh-external/ui-usage-stats/api/filters'
const BALANCE_PATH = '/@dsh-external/ui-usage-stats/api/balance'
const PARALLEL_SESSIONS = 4
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const PRICING_VERSION = 2

/** DeepSeek official pricing in CNY per 1M tokens. */
const PRICES: Record<string, {
  offPeak: { cacheHit: number; cacheMiss: number; output: number }
  peak: { cacheHit: number; cacheMiss: number; output: number }
}> = {
  'deepseek-v4-flash': {
    offPeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
    peak: { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 },
  },
  'deepseek-v4-flash-vision-exp': {
    offPeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
    peak: { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 },
  },
  'deepseek-v4-pro': {
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 },
  },
}

type PeriodId = 'peak' | 'off-peak'
type SessionType = 'normal' | 'subagent' | 'fork' | 'other'

interface TokenTotals {
  cacheMissTokens: number
  cacheHitTokens: number
  outputTokens: number
  cost: number
}

interface ModelStat extends TokenTotals {
  model: string
}

interface PeriodStat extends TokenTotals {
  id: PeriodId
  label: string
  models: ModelStat[]
}

interface SessionStat extends TokenTotals {
  sessionId: string
  title: string
  cwd?: string
  sessionType: SessionType
  lastActiveAt: number
  periods: PeriodStat[]
}

interface WorkspaceStat extends TokenTotals {
  path: string
  lastActiveAt: number
  sessions: SessionStat[]
}

interface SessionAccumulator {
  periodMap: Map<PeriodId, Map<string, TokenTotals>>
  lastActiveAt: number
  title: string
  titleSeq: number
}

const tokenTotalsSchema = z.object({
  cacheMissTokens: z.number(),
  cacheHitTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
})

const modelStatSchema = tokenTotalsSchema.extend({ model: z.string() })

const periodStatSchema = tokenTotalsSchema.extend({
  id: z.enum(['peak', 'off-peak']),
  label: z.string(),
  models: z.array(modelStatSchema),
})

const sessionTypeSchema = z.enum(['normal', 'subagent', 'fork', 'other'])

const sessionStatSchema = tokenTotalsSchema.extend({
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string().optional(),
  sessionType: sessionTypeSchema.optional(),
  lastActiveAt: z.number(),
  periods: z.array(periodStatSchema),
})

const cachedSessionStatSchema = z.object({
  fingerprint: z.string(),
  stat: sessionStatSchema,
})

const sessionTypeFiltersSchema = z.object({
  normal: z.boolean(),
  subagent: z.boolean(),
  fork: z.boolean(),
  other: z.boolean(),
})

const DEFAULT_SESSION_TYPE_FILTERS = {
  normal: true,
  subagent: false,
  fork: false,
  other: false,
}

const STATS_DOMAIN_SPEC = defineDomain({
  name: 'dsh_external_usage_stats',
  version: 1,
  tables: {
    session_stats: domainTable<string, z.infer<typeof cachedSessionStatSchema>>(cachedSessionStatSchema),
    ui_state: domainTable<string, z.infer<typeof sessionTypeFiltersSchema>>(sessionTypeFiltersSchema),
  },
})

const emptyTotals = (): TokenTotals => ({
  cacheMissTokens: 0,
  cacheHitTokens: 0,
  outputTokens: 0,
  cost: 0,
})

function addTotals(target: TokenTotals, source: TokenTotals): void {
  target.cacheMissTokens += source.cacheMissTokens
  target.cacheHitTokens += source.cacheHitTokens
  target.outputTokens += source.outputTokens
  target.cost += source.cost
}

function periodOf(time: number): PeriodId {
  const beijing = new Date(time + 8 * 3600 * 1000)
  const day = beijing.getUTCDay()
  // 周六（6）和周日（0）全天执行谷价，不再设置峰价。
  if (day === 0 || day === 6) return 'off-peak'
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'off-peak'
}

function modelCost(model: string, period: PeriodId, totals: TokenTotals): number {
  const modelId = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  const price = period === 'peak' ? PRICES[modelId]?.peak : PRICES[modelId]?.offPeak
  if (price === undefined) return 0
  return (
    (totals.cacheMissTokens / 1_000_000) * price.cacheMiss
    + (totals.cacheHitTokens / 1_000_000) * price.cacheHit
    + (totals.outputTokens / 1_000_000) * price.output
  )
}

function sessionTypeOf(header: any): SessionType {
  if (header?.origin === 'subagent') return 'subagent'
  if (header?.parentSession !== undefined) return 'fork'
  if (header?.origin === undefined && header?.parentSession === undefined) return 'normal'
  return 'other'
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer | string) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

async function fetchBalance(ctx: Context): Promise<unknown> {
  const credentials = (ctx as any).credentials
  const resolved = await credentials?.resolve?.('DEEPSEEK_API_KEY')
  const apiKey = typeof resolved?.value === 'string' ? resolved.value : ''
  if (apiKey === '') {
    return { ok: false, error: 'DEEPSEEK_API_KEY is not configured' }
  }
  const response = await fetch(DEEPSEEK_BALANCE_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  })
  const data = await response.json() as {
    is_available?: boolean
    balance_infos?: Array<{
      currency?: string
      total_balance?: string | number
      granted_balance?: string | number
      topped_up_balance?: string | number
    }>
  }
  if (!response.ok) {
    return { ok: false, error: `DeepSeek balance API ${response.status}` }
  }
  return {
    ok: true,
    isAvailable: data.is_available ?? false,
    balances: (data.balance_infos ?? []).map(info => ({
      currency: info.currency ?? 'CNY',
      totalBalance: info.total_balance ?? 0,
      grantedBalance: info.granted_balance ?? 0,
      toppedUpBalance: info.topped_up_balance ?? 0,
    })),
  }
}

function createAccumulator(): SessionAccumulator {
  return {
    periodMap: new Map(),
    lastActiveAt: 0,
    title: '',
    titleSeq: -1,
  }
}

function processEvent(acc: SessionAccumulator, event: any, seedLength?: number): void {
  if (event === null || typeof event !== 'object') return
  if (event.type === 'session/title') {
    const title = event.data?.title
    const seq = typeof event.seq === 'number' ? event.seq : -1
    if (typeof title === 'string' && title !== '' && seq >= acc.titleSeq) {
      acc.title = title
      acc.titleSeq = seq
    }
    return
  }
  if (seedLength !== undefined && typeof event.seq === 'number' && event.seq < seedLength) return
  if (typeof event.time === 'number' && event.time > acc.lastActiveAt) {
    acc.lastActiveAt = event.time
  }
  if (event.type !== 'assistant/message') return
  const data = event.data
  const source = data.message?.source
  if (source?.kind !== 'model') return
  const model = `${source.provider}/${source.model}`
  const usage = data.usage
  if (usage === undefined) return
  const totals: TokenTotals = {
    cacheMissTokens: Number(usage.inputTokens ?? 0),
    cacheHitTokens: Number(usage.cacheReadTokens ?? 0),
    outputTokens: Number(usage.outputTokens ?? 0),
    cost: 0,
  }
  if (totals.cacheMissTokens === 0 && totals.cacheHitTokens === 0 && totals.outputTokens === 0) return
  const period = periodOf(event.time)
  let modelMap = acc.periodMap.get(period)
  if (modelMap === undefined) {
    modelMap = new Map()
    acc.periodMap.set(period, modelMap)
  }
  let stat = modelMap.get(model)
  if (stat === undefined) {
    stat = emptyTotals()
    modelMap.set(model, stat)
  }
  addTotals(stat, totals)
}

function aggregateRawContent(content: string, seedLength?: number): SessionAccumulator {
  const acc = createAccumulator()
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    try {
      processEvent(acc, JSON.parse(line), seedLength)
    } catch {
      // A torn trailing line is not a usable event; skip it.
    }
  }
  return acc
}

function aggregateEvents(events: readonly any[], seedLength?: number): SessionAccumulator {
  const acc = createAccumulator()
  for (const event of events) processEvent(acc, event, seedLength)
  return acc
}

async function readSessionAccumulator(
  sessionQuery: any,
  sessionPersistence: any,
  sessionId: string,
  seedLength?: number,
): Promise<SessionAccumulator | undefined> {
  if (sessionPersistence !== undefined) {
    try {
      const artifact = await sessionPersistence.readRaw(sessionId)
      if (artifact?.content) return aggregateRawContent(artifact.content, seedLength)
    } catch {
      // Fall back to the validated query path below.
    }
  }
  if (sessionQuery === undefined) return undefined
  const snapshot = await sessionQuery.readSession(sessionId)
  return aggregateEvents(snapshot.events, seedLength)
}

async function buildSessionStat(
  sessionQuery: any,
  sessionPersistence: any,
  record: any,
): Promise<SessionStat | null> {
  const header = record.header
  const sessionId = String(header.id)
  const cwd = typeof header.cwd === 'string' ? header.cwd : ''
  const seedLength = typeof header.seedLength === 'number' ? header.seedLength : undefined
  const accumulator = await readSessionAccumulator(sessionQuery, sessionPersistence, sessionId, seedLength)
  if (accumulator === undefined || accumulator.periodMap.size === 0) return null

  let title = accumulator.title
  if (title === '' && sessionQuery !== undefined) {
    try {
      const titleSnapshot = await sessionQuery.readTitle(header.id)
      if (titleSnapshot?.title) title = titleSnapshot.title
    } catch {
      title = ''
    }
  }

  const sessionStat: SessionStat = {
    sessionId,
    title,
    ...cwd === '' ? {} : { cwd },
    sessionType: sessionTypeOf(header),
    lastActiveAt: accumulator.lastActiveAt,
    periods: [],
    ...emptyTotals(),
  }
  for (const [periodId, modelMap] of accumulator.periodMap) {
    const periodTotals = emptyTotals()
    const models: ModelStat[] = []
    for (const [model, totals] of modelMap) {
      const cost = modelCost(model, periodId, totals)
      const modelStat: ModelStat = { model, ...totals, cost }
      models.push(modelStat)
      addTotals(periodTotals, modelStat)
      addTotals(sessionStat, modelStat)
    }
    models.sort((a, b) => b.cost - a.cost)
    sessionStat.periods.push({
      id: periodId,
      label: periodId === 'peak' ? '高峰时段' : '空闲时段',
      ...periodTotals,
      models,
    })
  }
  sessionStat.periods.sort((a, b) => (a.id === 'peak' ? -1 : 1) - (b.id === 'peak' ? -1 : 1))
  return sessionStat
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index])
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

export async function apply(ctx: Context): Promise<void> {
  const storageDomain = (ctx as any).storageDomain
  let statsDomain: any
  if (storageDomain !== undefined) {
    try {
      statsDomain = await storageDomain.open(STATS_DOMAIN_SPEC)
      ctx.effect(() => () => { void statsDomain?.close?.() }, '@dsh-external/ui-usage-stats: storage domain')
    } catch {
      // Persistence is best-effort; the stats route still works without it.
      statsDomain = undefined
    }
  }

  ctx.effect(() => (ctx as any).webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname

      if (req.method === 'GET' && pathname === BALANCE_PATH) {
        try {
          const result = await fetchBalance(ctx)
          sendJson(res, 200, result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(res, 200, { ok: false, error: message })
        }
        return
      }

      if (req.method === 'GET' && pathname === FILTERS_PATH) {
        const saved = statsDomain?.table('ui_state').get('main')
        sendJson(res, 200, { filters: saved ?? DEFAULT_SESSION_TYPE_FILTERS })
        return
      }

      if (req.method === 'POST' && pathname === FILTERS_PATH) {
        let body: any
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const parsed = sessionTypeFiltersSchema.safeParse(body.filters)
        if (!parsed.success) {
          sendJson(res, 400, { error: 'invalid filters' })
          return
        }
        await statsDomain?.table('ui_state').put('main', parsed.data)
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method !== 'GET' || pathname !== STATS_PATH) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const sessionQuery = (ctx as any).sessionQuery
      const sessionPersistence = (ctx as any).sessionPersistence
      if (sessionQuery === undefined) {
        sendJson(res, 503, { error: 'session-query is unavailable' })
        return
      }
      try {
        const sessions = await sessionQuery.listSessions()
        const cacheTable = statsDomain?.table?.('session_stats')

        let revisionById = new Map<string, string>()
        if (sessionPersistence?.listSnapshots !== undefined) {
          try {
            const snapshots = await sessionPersistence.listSnapshots()
            revisionById = new Map(snapshots.map((snapshot: any) => [String(snapshot.header?.id ?? snapshot.header.id), String(snapshot.revision)]))
          } catch {
            revisionById = new Map()
          }
        }

        const sessionStats = await mapLimit(
          sessions,
          PARALLEL_SESSIONS,
          async (record: any) => {
            const sessionId = String(record.header.id)
            const fingerprint = `${PRICING_VERSION}:${revisionById.get(sessionId) ?? `live:${sessionId}:${record.header.createdAt ?? 0}`}`
            const cached = cacheTable?.get?.(sessionId)
            if (cached !== undefined && cached.fingerprint === fingerprint && cached.stat.sessionType !== undefined) return cached.stat

            const stat = await buildSessionStat(sessionQuery, sessionPersistence, record)
            if (stat !== null) {
              await cacheTable?.put?.(sessionId, { fingerprint, stat })
            } else if (cacheTable !== undefined) {
              await cacheTable.delete(sessionId).catch(() => {})
            }
            return stat
          },
        )

        if (cacheTable !== undefined) {
          const known = new Set(sessions.map((record: any) => String(record.header.id)))
          for (const key of [...cacheTable.keys()]) {
            if (!known.has(String(key))) {
              await cacheTable.delete(String(key)).catch(() => {})
            }
          }
        }

        const workspaceMap = new Map<string, WorkspaceStat>()
        for (const sessionStat of sessionStats) {
          if (sessionStat === null) continue
          const path = sessionStat.cwd ?? '(无工作区)'
          let workspace = workspaceMap.get(path)
          if (workspace === undefined) {
            workspace = {
              path,
              lastActiveAt: sessionStat.lastActiveAt,
              sessions: [],
              ...emptyTotals(),
            }
            workspaceMap.set(path, workspace)
          }
          if (sessionStat.lastActiveAt > workspace.lastActiveAt) workspace.lastActiveAt = sessionStat.lastActiveAt
          workspace.sessions.push(sessionStat)
          addTotals(workspace, sessionStat)
        }
        const workspaces = [...workspaceMap.values()]
          .map(workspace => ({
            ...workspace,
            sessions: [...workspace.sessions]
              .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
              .map(session => ({
                ...session,
                periods: session.periods.map(period => ({
                  ...period,
                  models: [...period.models].sort((a, b) => b.cost - a.cost),
                })),
              })),
          }))
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        sendJson(res, 200, { generatedAt: Date.now(), workspaces })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 500, { error: message })
      }
    },
  }), '@dsh-external/ui-usage-stats: stats route')
}
