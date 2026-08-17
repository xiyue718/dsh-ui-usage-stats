/**
 * @dsh-external/ui-usage-stats — browser half.
 * Registers a "用量统计" settings page that renders token usage grouped by
 * workspace -> session -> period -> model and DeepSeek cost totals.
 */
import React, { useEffect, useState } from 'react'

export const inject = ['slots']

const API_PREFIX = '/@dsh-external/ui-usage-stats/api'
const API_PATH = `${API_PREFIX}/stats`
const FILTERS_PATH = `${API_PREFIX}/filters`

type SessionType = 'normal' | 'subagent' | 'fork' | 'other'

interface SessionTypeFilters {
  normal: boolean
  subagent: boolean
  fork: boolean
  other: boolean
}

const DEFAULT_SESSION_TYPE_FILTERS: SessionTypeFilters = {
  normal: true,
  subagent: false,
  fork: false,
  other: false,
}

const SESSION_TYPE_OPTIONS: { key: SessionType; label: string }[] = [
  { key: 'normal', label: '普通用户会话' },
  { key: 'subagent', label: '子代理会话' },
  { key: 'fork', label: '分叉会话' },
  { key: 'other', label: '其他会话' },
]

interface Totals {
  cacheMissTokens: number
  cacheHitTokens: number
  outputTokens: number
  cost: number
}

interface ModelStat extends Totals {
  model: string
}

interface PeriodStat extends Totals {
  id: 'peak' | 'off-peak'
  label: string
  models: ModelStat[]
}

interface SessionStat extends Totals {
  sessionId: string
  title: string
  cwd?: string
  sessionType?: SessionType
  lastActiveAt: number
  periods: PeriodStat[]
}

interface WorkspaceStat extends Totals {
  path: string
  lastActiveAt: number
  sessions: SessionStat[]
}

interface StatsResponse {
  generatedAt?: number
  workspaces: WorkspaceStat[]
}

function fmtTokens(value: number): string {
  return Math.round(value).toLocaleString('zh-CN')
}

function fmtCost(value: number): string {
  return `¥${value.toFixed(4)}`
}

function TotalsRow({ totals }: { totals: Totals }) {
  return React.createElement(
    'div',
    { style: { display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)' } },
    React.createElement('span', null, `未命中缓存：${fmtTokens(totals.cacheMissTokens)}`),
    React.createElement('span', null, `命中缓存：${fmtTokens(totals.cacheHitTokens)}`),
    React.createElement('span', null, `输出：${fmtTokens(totals.outputTokens)}`),
    React.createElement('span', null, `费用：${fmtCost(totals.cost)}`),
  )
}

function ModelsTable({ models }: { models: ModelStat[] }) {
  const head = React.createElement(
    'tr',
    null,
    React.createElement('th', { style: thStyle }, '模型'),
    React.createElement('th', { style: thStyle }, '未命中缓存'),
    React.createElement('th', { style: thStyle }, '命中缓存'),
    React.createElement('th', { style: thStyle }, '输出'),
    React.createElement('th', { style: thStyle }, '费用'),
  )
  const rows = models.map(model => React.createElement(
    'tr',
    { key: model.model },
    React.createElement('td', { style: tdStyle }, model.model),
    React.createElement('td', { style: tdStyle }, fmtTokens(model.cacheMissTokens)),
    React.createElement('td', { style: tdStyle }, fmtTokens(model.cacheHitTokens)),
    React.createElement('td', { style: tdStyle }, fmtTokens(model.outputTokens)),
    React.createElement('td', { style: tdStyle }, fmtCost(model.cost)),
  ))
  return React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%', marginTop: 8 } },
    React.createElement('thead', null, head),
    React.createElement('tbody', null, rows),
  )
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  borderBottom: '1px solid var(--dsw-alias-border-primary, #ddd)',
  fontSize: 12,
}

const tdStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  borderBottom: '1px solid var(--dsw-alias-border-primary, #eee)',
  fontSize: 12,
  verticalAlign: 'top',
}

function toggleInSet(current: Set<string>, key: string): Set<string> {
  const next = new Set(current)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

function UsageStatsSection() {
  const [data, setData] = useState<StatsResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [filters, setFilters] = useState<SessionTypeFilters>(DEFAULT_SESSION_TYPE_FILTERS)
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set())
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set())
  const [expandedPeriods, setExpandedPeriods] = useState<Set<string>>(new Set())

  async function saveFilters(next: SessionTypeFilters) {
    try {
      await fetch(FILTERS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filters: next }),
      })
    } catch {
      // Persistence is best-effort.
    }
  }

  function updateFilter(key: SessionType) {
    const next = { ...filters, [key]: !filters[key] }
    setFilters(next)
    void saveFilters(next)
  }

  async function load() {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(API_PATH)
      const json = await response.json()
      if (!response.ok) throw new Error(json.error ?? '加载用量统计失败')
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    void fetch(FILTERS_PATH)
      .then(response => response.json())
      .then((json: any) => {
        const next = json?.filters
        if (next === undefined) return
        setFilters(current => ({
          normal: typeof next.normal === 'boolean' ? next.normal : current.normal,
          subagent: typeof next.subagent === 'boolean' ? next.subagent : current.subagent,
          fork: typeof next.fork === 'boolean' ? next.fork : current.fork,
          other: typeof next.other === 'boolean' ? next.other : current.other,
        }))
      })
      .catch(() => { /* Keep defaults when filters cannot be loaded. */ })
  }, [])

  const pageStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: '4px 2px',
    fontSize: 13,
    lineHeight: 1.6,
  }

  const filterBar = React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto', flexWrap: 'wrap' } },
    ...SESSION_TYPE_OPTIONS.map(option =>
      React.createElement('label', {
        key: option.key,
        style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' },
      },
      React.createElement('input', {
        type: 'checkbox',
        checked: filters[option.key],
        onChange: () => updateFilter(option.key),
      }),
      option.label,
      ),
    ),
  )

  const header = React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
    React.createElement('h2', { style: { margin: 0, fontSize: 16 } }, '用量统计'),
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: () => void load(),
        disabled: loading,
        style: {
          padding: '4px 10px',
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-primary, #ccc)',
          background: 'transparent',
          cursor: loading ? 'default' : 'pointer',
        },
      },
      loading ? '加载中…' : '刷新',
    ),
    filterBar,
  )

  if (loading && data === null) {
    return React.createElement('div', { style: pageStyle }, header, React.createElement('div', null, '加载中…'))
  }
  if (error !== '') {
    return React.createElement('div', { style: pageStyle }, header, React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary, #d33)' } }, error))
  }
  if (data === null || data.workspaces.length === 0) {
    return React.createElement('div', { style: pageStyle }, header, React.createElement('div', null, '暂无用量数据'))
  }

  const selectedTypes = new Set<SessionType>(
    SESSION_TYPE_OPTIONS.filter(option => filters[option.key]).map(option => option.key),
  )
  const visibleWorkspaces = data.workspaces
    .map(workspace => {
      const sessions = workspace.sessions.filter(session => selectedTypes.has(session.sessionType ?? 'other'))
      if (sessions.length === 0) return null
      const totals = sessions.reduce(
        (acc, session) => ({
          cacheMissTokens: acc.cacheMissTokens + session.cacheMissTokens,
          cacheHitTokens: acc.cacheHitTokens + session.cacheHitTokens,
          outputTokens: acc.outputTokens + session.outputTokens,
          cost: acc.cost + session.cost,
        }),
        { cacheMissTokens: 0, cacheHitTokens: 0, outputTokens: 0, cost: 0 },
      )
      return {
        ...workspace,
        sessions,
        ...totals,
        lastActiveAt: sessions.reduce((max, session) => Math.max(max, session.lastActiveAt), 0),
      }
    })
    .filter((workspace): workspace is WorkspaceStat => workspace !== null)

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    userSelect: 'none',
  }

  const grandTotals = visibleWorkspaces.reduce(
    (acc, workspace) => ({
      cacheMissTokens: acc.cacheMissTokens + workspace.cacheMissTokens,
      cacheHitTokens: acc.cacheHitTokens + workspace.cacheHitTokens,
      outputTokens: acc.outputTokens + workspace.outputTokens,
      cost: acc.cost + workspace.cost,
    }),
    { cacheMissTokens: 0, cacheHitTokens: 0, outputTokens: 0, cost: 0 },
  )

  const grandTotalsCard = React.createElement(
    'div',
    { style: { border: '1px solid var(--dsw-alias-border-primary, #e5e5e5)', borderRadius: 8, padding: 12 } },
    React.createElement('div', { style: { fontWeight: 700, fontSize: 14 } }, '总计'),
    React.createElement('div', { style: { marginTop: 4 } }, React.createElement(TotalsRow, { totals: grandTotals })),
  )

  const workspaceNodes = visibleWorkspaces.map(workspace => {
    const workspaceExpanded = expandedWorkspaces.has(workspace.path)
    const workspaceHeader = React.createElement(
      'div',
      {
        style: headerStyle,
        onClick: () => setExpandedWorkspaces(current => toggleInSet(current, workspace.path)),
      },
      React.createElement('span', null, workspaceExpanded ? '▾' : '▸'),
      React.createElement('span', { style: { fontWeight: 700, fontSize: 14 } }, `工作区：${workspace.path}`),
    )
    const workspaceTotals = React.createElement('div', { style: { marginTop: 4 } }, React.createElement(TotalsRow, { totals: workspace }))
    if (!workspaceExpanded) {
      return React.createElement(
        'div',
        { key: workspace.path, style: { border: '1px solid var(--dsw-alias-border-primary, #e5e5e5)', borderRadius: 8, padding: 12 } },
        workspaceHeader,
        workspaceTotals,
      )
    }

    const sessionNodes = workspace.sessions.map(session => {
      const sessionKey = `${workspace.path}\u0000${session.sessionId}`
      const sessionExpanded = expandedSessions.has(sessionKey)
      const sessionHeader = React.createElement(
        'div',
        {
          style: headerStyle,
          onClick: () => setExpandedSessions(current => toggleInSet(current, sessionKey)),
        },
        React.createElement('span', null, sessionExpanded ? '▾' : '▸'),
        React.createElement('span', { style: { fontWeight: 600 } }, `会话：${session.title || '(无标题)'}`),
      )
      const sessionMeta = React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)' } },
        `会话 ID：${session.sessionId} · 工作区：${session.cwd ?? '(无工作区)'}`,
      )
      const sessionTotals = React.createElement('div', { style: { marginTop: 4 } }, React.createElement(TotalsRow, { totals: session }))
      if (!sessionExpanded) {
        return React.createElement(
          'div',
          { key: session.sessionId, style: { marginTop: 12, padding: '10px 12px', border: '1px solid var(--dsw-alias-border-primary, #e5e5e5)', borderRadius: 8 } },
          sessionHeader,
          sessionMeta,
          sessionTotals,
        )
      }

      const periodNodes = session.periods.map(period => {
        const periodKey = `${sessionKey}\u0000${period.id}`
        const periodExpanded = expandedPeriods.has(periodKey)
        const periodHeader = React.createElement(
          'div',
          {
            style: headerStyle,
            onClick: () => setExpandedPeriods(current => toggleInSet(current, periodKey)),
          },
          React.createElement('span', null, periodExpanded ? '▾' : '▸'),
          React.createElement('span', { style: { fontWeight: 600 } }, period.label),
        )
        const periodTotals = React.createElement(TotalsRow, { totals: period })
        const modelsTable = periodExpanded && period.models.length > 0
          ? React.createElement(ModelsTable, { models: period.models })
          : null
        return React.createElement(
          'div',
          { key: period.id, style: { borderLeft: '3px solid var(--dsw-alias-border-primary, #ccc)', paddingLeft: 12, marginTop: 8 } },
          periodHeader,
          periodTotals,
          modelsTable,
        )
      })

      return React.createElement(
        'div',
        { key: session.sessionId, style: { marginTop: 12, padding: '10px 12px', border: '1px solid var(--dsw-alias-border-primary, #e5e5e5)', borderRadius: 8 } },
        sessionHeader,
        sessionMeta,
        sessionTotals,
        periodNodes,
      )
    })

    return React.createElement(
      'div',
      { key: workspace.path, style: { border: '1px solid var(--dsw-alias-border-primary, #e5e5e5)', borderRadius: 8, padding: 12 } },
      workspaceHeader,
      workspaceTotals,
      sessionNodes,
    )
  })

  return React.createElement('div', { style: pageStyle },
    header,
    grandTotalsCard,
    visibleWorkspaces.length === 0
      ? React.createElement('div', null, '未选择任何会话类型或没有匹配的会话')
      : workspaceNodes,
  )
}

function billedInputTokens(usage: any): number {
  return (usage?.uncachedInputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0)
}

function CachePercentCorrector(props: any) {
  const usage = props.useProjection?.('tokenUsage')
  const denominator = billedInputTokens(usage)
  const percent = denominator === 0 ? null : (usage.cacheReadTokens / denominator * 100)
  const formatted = percent === null ? null : percent.toFixed(2)

  useEffect(() => {
    if (formatted === null) return
    const frame = requestAnimationFrame(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let current: Node | null = walker.nextNode()
      while (current !== null) {
        if (current.nodeType === Node.TEXT_NODE) {
          const text = current.textContent ?? ''
          const match = /^(缓存命中|Cache hit)\s+(\d+)%$/.exec(text)
          if (match !== null) {
            current.textContent = `${match[1]} ${formatted}%`
          }
        }
        current = walker.nextNode()
      }
    })
    return () => { cancelAnimationFrame(frame) }
  }, [formatted])

  return null
}

export function apply(ctx: any): void {
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'usage-stats-cache-percent-corrector',
      order: 10,
    }, CachePercentCorrector),
  )

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'usage-stats',
      order: 20,
      label: () => '用量统计',
    }, UsageStatsSection),
  )
}
