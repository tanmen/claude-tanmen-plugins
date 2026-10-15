// $ を使わない判定。register.tsx が集めた材料から理由を組み立てる（テストはここを直接呼ぶ）
import type { FollowUp, OtherSession, Reason, ReasonAction, Verdict } from '../types'
import type { Messages } from './messages'

export type ToolUseLite = { tool: string; input: Record<string, unknown>; text?: string; result?: unknown }
export type MessageLite = { role: 'user' | 'assistant'; text: string; toolUses: readonly ToolUseLite[] }

export const FOLLOWUP_TOOL = 'mcp__archive-check__followup'

const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
const START_SESSION = 'mcp__ccd_session__start_session'

type Step = { content: string; status: string }

// タスク一覧（update_plan）を頭から再生して、残りの手順を数える。wrap_up は進行中の手順を済ませる
export function replayPlan(messages: readonly MessageLite[]): { left: number; next: string | null } {
  let steps: Step[] = []
  for (const m of messages) {
    for (const u of m.toolUses) {
      if (u.tool === UPDATE_PLAN) {
        const input = u.input
        if (Array.isArray(input.items)) {
          steps = input.items.map(item => {
            const i = (typeof item === 'object' && item !== null ? item : {}) as { content?: unknown; status?: unknown }
            return { content: String(i.content ?? ''), status: String(i.status ?? 'pending') }
          })
        }
        if (Array.isArray(input.done)) {
          for (const n of input.done) {
            const step = typeof n === 'number' ? steps[n - 1] : undefined
            if (step) step.status = 'completed'
          }
        }
        if (input.advance === true) {
          const current = steps.find(s => s.status === 'in_progress')
          if (current) current.status = 'completed'
          const pending = steps.find(s => s.status === 'pending')
          if (pending) pending.status = 'in_progress'
        }
        const start = typeof input.start === 'number' ? steps[input.start - 1] : undefined
        if (start) start.status = 'in_progress'
      } else if (u.tool === WRAP_UP) {
        for (const s of steps) if (s.status === 'in_progress') s.status = 'completed'
      }
    }
  }
  const left = steps.filter(s => s.status !== 'completed')
  return { left: left.length, next: left[0]?.content ?? null }
}

// wrap_up のボタンのうち、アプリの操作（commit など）は mod から押せないので、同じことを Claude に頼む
function wrapActions(input: Record<string, unknown>, m: Messages): ReasonAction[] {
  const actions: ReasonAction[] = []
  for (const raw of Array.isArray(input.actions) ? input.actions : []) {
    const a = (typeof raw === 'object' && raw !== null ? raw : {}) as { label?: unknown; message?: unknown; action?: unknown }
    if (typeof a.action === 'string') {
      const app = m.appActions[a.action]
      if (app) actions.push(app)
      continue
    }
    const label = typeof a.label === 'string' ? a.label.trim() : ''
    const message = typeof a.message === 'string' && a.message.trim() !== '' ? a.message.trim() : label
    if (label !== '') actions.push({ label, prompt: message })
  }
  return actions
}

export type PendingAsk = { text: string; actions: ReasonAction[] }

// 本人の返事を待っているもの: 最後の wrap_up の ask（そのあと本人も Claude も何も書いていない）・
// 答えを待っている AskUserQuestion・「新しいセッションか、ここでやるか」の offer
export function pendingAsks(messages: readonly MessageLite[], m: Messages): PendingAsk[] {
  const asks: PendingAsk[] = []
  let lastWrap: { index: number; ask: string; actions: ReasonAction[] } | null = null
  messages.forEach((msg, index) => {
    for (const u of msg.toolUses) {
      if (u.tool === WRAP_UP) {
        lastWrap = { index, ask: typeof u.input.ask === 'string' ? u.input.ask.trim() : '', actions: wrapActions(u.input, m) }
      } else if (u.tool === 'AskUserQuestion' && u.text === undefined) {
        asks.push({ text: m.askQuestion, actions: [] })
      } else if (u.tool === START_SESSION && u.input.initiation === 'offer' && u.text === undefined) {
        asks.push({ text: m.askOffer(typeof u.input.title === 'string' ? u.input.title : ''), actions: [] })
      }
    }
  })
  const wrap = lastWrap as { index: number; ask: string; actions: ReasonAction[] } | null
  if (wrap !== null && wrap.ask !== '') {
    const isAnswered = messages
      .slice(wrap.index + 1)
      .some(msg => msg.role === 'assistant' || msg.text.trim() !== '')
    if (!isAnswered) asks.unshift({ text: wrap.ask, actions: wrap.actions })
  }
  return asks
}

export function askReasons(asks: readonly PendingAsk[]): Reason[] {
  return asks.map(a => ({
    level: 'caution',
    kind: 'ask',
    text: a.text,
    ...(a.actions.length > 0 ? { actions: a.actions } : {}),
  }))
}

// 終わった背景タスクの id: <task-notification> の status と、TaskStop で止めたもの
const RUNNING_STATUSES = new Set(['running', 'started', 'pending', 'event'])

export function endedTaskIds(messages: readonly MessageLite[]): Set<string> {
  const ended = new Set<string>()
  for (const m of messages) {
    if (m.role === 'user' && m.text.includes('<task-notification>')) {
      for (const block of m.text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const body = block[1] ?? ''
        const id = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1]?.trim()
        const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim().toLowerCase()
        if (id && status && !RUNNING_STATUSES.has(status)) ended.add(id)
      }
    }
    for (const u of m.toolUses) {
      if (u.tool === 'TaskStop') {
        const id = u.input.task_id ?? u.input.shell_id
        if (typeof id === 'string') ended.add(id)
      }
    }
  }
  return ended
}

// Desktop の記録（<host session id>.json）のうち、判定に使う欄
export type SessionRecord = {
  title?: unknown
  isArchived?: unknown
  backgroundTaskSuggestions?: { id?: unknown; title?: unknown; expiresAt?: unknown }[]
  prs?: { prNumber?: unknown; repo?: unknown; state?: unknown }[]
}

export type RecordPr = { number: number; repo: string; state: string }

export function recordPrs(record: SessionRecord): RecordPr[] {
  const prs: RecordPr[] = []
  for (const pr of record.prs ?? []) {
    if (typeof pr.prNumber === 'number' && typeof pr.repo === 'string') {
      prs.push({ number: pr.prNumber, repo: pr.repo, state: typeof pr.state === 'string' ? pr.state : '' })
    }
  }
  return prs
}

export function prHref(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`
}

// 未起動の提案カード。期限（expiresAt）を過ぎたカードはもう起動できないので数えない
export function cardReasons(record: SessionRecord, m: Messages, now: number): Reason[] {
  const live = (record.backgroundTaskSuggestions ?? []).filter(card => typeof card.expiresAt !== 'number' || card.expiresAt > now)
  return live.map(card => {
    const id = typeof card.id === 'string' ? card.id : ''
    const title = typeof card.title === 'string' ? card.title : id
    return {
      level: 'blocked',
      kind: 'card',
      text: m.card(title),
      actions: [{ label: m.launchLabel, prompt: m.launchPrompt(title, id) }],
    }
  })
}

// gh pr view --json state,headRefOid,statusCheckRollup の応答
export type PrStatus = { state: string; headRefOid: string; isCiPending: boolean }

export function parsePrStatus(stdout: string): PrStatus | null {
  let body: unknown
  try {
    body = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const v = body as { state?: unknown; headRefOid?: unknown; statusCheckRollup?: unknown }
  const checks = Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : []
  const isCiPending = checks.some(c => {
    const check = (typeof c === 'object' && c !== null ? c : {}) as { status?: unknown; state?: unknown; __typename?: unknown }
    if (check.__typename === 'StatusContext' || (check.status === undefined && check.state !== undefined)) {
      return check.state === 'PENDING' || check.state === 'EXPECTED'
    }
    return typeof check.status === 'string' && check.status !== 'COMPLETED'
  })
  return {
    state: typeof v.state === 'string' ? v.state : '',
    headRefOid: typeof v.headRefOid === 'string' ? v.headRefOid : '',
    isCiPending,
  }
}

export function followupReasons(followups: readonly FollowUp[], m: Messages): Reason[] {
  return followups.map(f => ({
    level: 'caution',
    kind: 'followup',
    text: m.followup(f.what, f.when),
    ...(f.how ? { note: f.how } : {}),
    followupId: f.id,
    actions: [{ label: m.scheduleLabel, prompt: m.schedulePrompt(f, FOLLOWUP_TOOL) }],
  }))
}

export function isFollowUp(value: unknown): value is FollowUp {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<FollowUp>
  return typeof v.id === 'string' && typeof v.what === 'string'
}

export const FOLLOWUP_PREFIX = 'followups:'

// $.store の全キーから、ほかのセッションの後続を束ねる（記録の isArchived は register.tsx が埋める）
export function groupOthers(
  entries: readonly { key: string; value: unknown }[],
  ownCliId: string,
  m: Messages,
): Omit<OtherSession, 'isArchived'>[] {
  const others: Omit<OtherSession, 'isArchived'>[] = []
  for (const { key, value } of entries) {
    if (!key.startsWith(FOLLOWUP_PREFIX)) continue
    const cliId = key.slice(FOLLOWUP_PREFIX.length)
    if (cliId === ownCliId || cliId === '') continue
    const followups = Array.isArray(value) ? value.filter(isFollowUp) : []
    if (followups.length === 0) continue
    // 題と記録の名前は、いちばん新しく書き出した後続のもの
    const latest = [...followups].reverse().find(f => f.hostId !== undefined || f.sessionTitle !== undefined)
    others.push({
      cliId,
      ...(latest?.hostId ? { hostId: latest.hostId } : {}),
      title: latest?.sessionTitle || m.sessionFallback(cliId.slice(0, 8)),
      followups,
    })
  }
  return others
}

// 設定のパスの頭の ~ をホームに置き換える
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return `${home}${path.slice(1)}`
  return path
}

export function verdictOf(reasons: readonly Reason[]): Verdict {
  if (reasons.some(r => r.level === 'blocked')) return 'blocked'
  return reasons.length > 0 ? 'caution' : 'ok'
}

// 作を先に、注は後続・承認待ち・その他の順に並べる
const ORDER: Record<Reason['kind'], number> = {
  dirty: 0,
  unpushed: 1,
  card: 2,
  task: 3,
  followup: 4,
  ci: 5,
  ask: 6,
  plan: 7,
  pr: 8,
  unread: 9,
}

export function sortReasons(reasons: readonly Reason[]): Reason[] {
  return [...reasons].sort((a, b) => {
    if (a.level !== b.level) return a.level === 'blocked' ? -1 : 1
    return ORDER[a.kind] - ORDER[b.kind]
  })
}
