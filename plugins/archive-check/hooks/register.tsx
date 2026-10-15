import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BackgroundTask, FollowUp, Reason, ReasonAction, Report, Verdict } from '../types'
import {
  askReasons,
  cardReasons,
  endedTaskIds,
  expandHome,
  FOLLOWUP_PREFIX,
  followupReasons,
  isFollowUp,
  parsePrStatus,
  pendingAsks,
  prHref,
  recordPrs,
  replayPlan,
  sortReasons,
  verdictOf,
} from './logic'
import type { MessageLite, PrStatus, RecordPr, SessionRecord } from './logic'
import { langOf, MESSAGES } from './messages'
import type { Messages } from './messages'

const report = atom({ plugin: 'archive-check', key: 'report' } as const, null)
const tasks = atom({ plugin: 'archive-check', key: 'tasks' } as const, [])

const PANE = 'archive-check'
// hook の matcher は、このファイルの中の文字列でないと validate が読めない（logic.ts の同名の値と同じ）
const FOLLOWUP_TOOL = 'mcp__archive-check__followup'

// 設定（register が読み込むたびに入れ直す）
let m: Messages = MESSAGES.en
let guideSetting = ''

// SVG は画像として描かれ、アプリのテーマに追従しない。usage-bars と同じ、Desktop のダークテーマに合わせた色
const TRACK = '#2C2C2A'
const TONES: Record<Verdict, { fill: string; text: string }> = {
  ok: { fill: '#1D9E75', text: '#5DCAA5' },
  caution: { fill: '#BA7517', text: '#EF9F27' },
  blocked: { fill: '#E24B4A', text: '#F09595' },
}
const FONT = "'Segoe UI', 'Yu Gothic UI', 'Hiragino Sans', system-ui, sans-serif"
const HEIGHT = 19

// PR の状態（gh）はこれより新しければ読み直さない
const PR_CACHE_MS = 3 * 60_000
// 枠のボタンの依頼が入ったかを待つ長さ（hook の持ち時間 10 秒より短く）
const SUBMIT_WAIT_MS = 8_000

function badgeSvg(verdict: Verdict): string {
  const tone = TONES[verdict]
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${m.badgeWidth}" height="${HEIGHT}">`,
    `<rect width="100%" height="${HEIGHT}" rx="6" fill="${TRACK}"/>`,
    `<rect width="100%" height="${HEIGHT}" rx="6" fill="${tone.fill}" fill-opacity="0.22"/>`,
    `<text x="50%" y="14" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="${tone.text}">${m.badge[verdict]}</text>`,
    `</svg>`,
  ].join('')
}

function unread(what: string): Reason {
  return { level: 'caution', kind: 'unread', text: m.unread(what) }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// ---- 置き場（Windows は %APPDATA%、macOS は ~/Library/Application Support）

type Places = { home: string; sep: string; recordRoot: string | null }

async function places($: EngineInterface): Promise<Places> {
  const appData = await $.env.get('APPDATA')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  if (appData) return { home, sep: '\\', recordRoot: `${appData}\\Claude\\claude-code-sessions` }
  return { home, sep: '/', recordRoot: home ? `${home}/Library/Application Support/Claude/claude-code-sessions` : null }
}

// ---- Claude への指示（設定 guide の Markdown があればそれ、無ければ既定の文）

async function readGuide($: EngineInterface): Promise<string | null> {
  if (guideSetting === '') return null
  const { home } = await places($)
  try {
    const text = await $.fs.read(expandHome(guideSetting, home))
    return text.trim() === '' ? null : text
  } catch {
    return null
  }
}

// ---- 後続（$.store にセッションごとに置く。CLI が止まって開き直しても残る。全セッション共通）

async function loadFollowupsOf($: EngineInterface, cliId: string): Promise<FollowUp[]> {
  const value = await $.store.get(`${FOLLOWUP_PREFIX}${cliId}`)
  return Array.isArray(value) ? value.filter(isFollowUp) : []
}

async function saveFollowupsOf($: EngineInterface, cliId: string, list: FollowUp[]): Promise<void> {
  const key = `${FOLLOWUP_PREFIX}${cliId}`
  if (list.length === 0) await $.store.delete(key)
  else await $.store.set(key, list)
}

async function removeFollowupOf($: EngineInterface, cliId: string, id: string): Promise<FollowUp | null> {
  const list = await loadFollowupsOf($, cliId)
  const found = list.find(f => f.id === id) ?? null
  if (found !== null) await saveFollowupsOf($, cliId, list.filter(f => f.id !== id))
  return found
}

// 枠のボタンから Claude に頼む。届いたかを $.store の lastSubmit:<CLI のセッション id> に残す（道具の list で読める）。
// 依頼文の本文は残さない（store は全セッション共通）
async function submitPrompt($: EngineInterface, action: ReasonAction): Promise<void> {
  const at = await $.clock.now()
  const key = `lastSubmit:${await $.session.id()}`
  const record = (result: string, detail: string) =>
    $.store.set(key, { at, label: action.label, result, ...(detail ? { detail: detail.slice(0, 300) } : {}) }).catch(() => undefined)
  try {
    const submitting = $.prompt.submit({ text: action.prompt, asUser: true })
    void submitting.then(
      done => (done.drop !== undefined ? record('dropped', String(done.drop)) : record('submitted', '')),
      err => record('error', String(err)),
    )
    const settled = await Promise.race([
      submitting.then(done => ('drop' in done && done.drop !== undefined ? 'dropped' : 'submitted')),
      $.clock.sleep(SUBMIT_WAIT_MS).then(() => 'waiting'),
    ])
    if (settled === 'waiting') await record('waiting', '')
    $.ui.toast(settled === 'dropped' ? m.notSent(action.label) : m.asked(action.label))
  } catch (err) {
    await record('error', String(err))
    $.ui.toast(m.notSent(action.label, String(err).slice(0, 120)))
  }
}

async function handleFollowupTool($: EngineInterface, input: Record<string, unknown>): Promise<{ result: string }> {
  const action = asString(input.action)
  const cliId = await $.session.id()
  const list = await loadFollowupsOf($, cliId)
  if (action === 'add') {
    const what = asString(input.what)
    if (what === '') return { result: JSON.stringify({ error: 'what is empty' }) }
    const now = await $.clock.now()
    const dueAt = asString(input.due_at)
    const followup: FollowUp = {
      id: `f${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
      what,
      when: asString(input.when),
      how: asString(input.how),
      ...(dueAt ? { dueAt } : {}),
      createdAt: now,
    }
    list.push(followup)
    await saveFollowupsOf($, cliId, list)
    evaluateSoon($, 0)
    return { result: JSON.stringify({ added: followup, followups: list }) }
  }
  if (action === 'done') {
    const id = asString(input.id)
    const removed = await removeFollowupOf($, cliId, id)
    evaluateSoon($, 0)
    return { result: JSON.stringify(removed === null ? { error: `no follow-up with id ${id}`, followups: list } : { removed, followups: list.filter(f => f.id !== id) }) }
  }
  return { result: JSON.stringify({ followups: list, lastSubmit: await $.store.get(`lastSubmit:${cliId}`) }) }
}

// ---- この CLI のプロセスで起きた背景タスク

async function trackTask($: EngineInterface, e: Record<string, unknown>, result: unknown): Promise<void> {
  const tool = String(e.tool)
  const record = (typeof result === 'object' && result !== null ? (result as { result?: unknown }).result : undefined) as
    | Record<string, unknown>
    | undefined
  let task: BackgroundTask | null = null
  const now = await $.clock.now()
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof record?.backgroundTaskId === 'string') {
    const label = asString(e.description) || asString(e.command).slice(0, 80)
    task = { id: record.backgroundTaskId, kind: 'shell', label, startedAt: now }
  } else if (tool === 'Monitor' && typeof record?.taskId === 'string') {
    task = { id: record.taskId, kind: 'monitor', label: asString(e.description), startedAt: now }
  }
  if (task !== null) {
    const added = task
    await update($, tasks, prev => [...(prev ?? []).filter(t => t.id !== added.id), added].slice(-50))
  }
}

// ---- Desktop の記録（アプリの状態ファイル。読むだけ）

let recordPath: string | null = null

async function findRecordPath($: EngineInterface): Promise<string | null> {
  if (recordPath !== null) return recordPath
  const hostId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  const { sep, recordRoot } = await places($)
  if (!hostId || recordRoot === null) return null
  for (const account of await $.fs.list(recordRoot)) {
    if (account.kind !== 'dir') continue
    for (const profile of await $.fs.list(`${recordRoot}${sep}${account.name}`)) {
      if (profile.kind !== 'dir') continue
      const path = `${recordRoot}${sep}${account.name}${sep}${profile.name}${sep}${hostId}.json`
      if (await $.fs.exists(path)) {
        recordPath = path
        return path
      }
    }
  }
  return null
}

async function readRecord($: EngineInterface): Promise<SessionRecord | null> {
  try {
    const path = await findRecordPath($)
    if (path === null) return null
    const body: unknown = JSON.parse(await $.fs.read(path))
    return typeof body === 'object' && body !== null ? (body as SessionRecord) : null
  } catch {
    return null
  }
}

// この CLI が起きた時刻。~/.claude/sessions/<pid>.json の startedAt（背景タスクの記録から、前のプロセスの分を外す）
let processStartedAt: number | null = null

async function readProcessStartedAt($: EngineInterface, cliId: string): Promise<number | null> {
  if (processStartedAt !== null) return processStartedAt
  const { home, sep } = await places($)
  if (home === '') return null
  const dir = `${home}${sep}.claude${sep}sessions`
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const body = JSON.parse(await $.fs.read(`${dir}${sep}${entry.name}`)) as { sessionId?: unknown; startedAt?: unknown }
      if (body.sessionId === cliId && typeof body.startedAt === 'number') {
        processStartedAt = body.startedAt
        return processStartedAt
      }
    } catch {
      // 書きかけの記録は飛ばす
    }
  }
  return null
}

// ---- PR（gh）

const prCache = new Map<string, { at: number; status: PrStatus | null }>()

async function prStatus($: EngineInterface, pr: RecordPr, now: number): Promise<PrStatus | null> {
  const key = `${pr.repo}#${pr.number}`
  const cached = prCache.get(key)
  if (cached !== undefined && now - cached.at < PR_CACHE_MS) return cached.status
  let status: PrStatus | null = null
  try {
    const run = await $.process.run(
      ['gh', 'pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'state,headRefOid,statusCheckRollup'],
      { timeoutMs: 20_000 },
    )
    status = run.exitCode === 0 ? parsePrStatus(run.stdout) : null
  } catch {
    status = null
  }
  prCache.set(key, { at: now, status })
  return status
}

// ---- 作業ツリー（未コミット・remote に無いコミット）

async function workTreeReasons(
  $: EngineInterface,
  cwd: string,
  mergedHeads: () => Promise<string[] | null>,
): Promise<Reason[]> {
  // 失敗（時間切れ・起動できない）は null。どれも「読めなかった」にして、Done にしない
  const git = (args: string[]) =>
    $.process.run(['git', '-C', cwd, ...args], { env: { LC_ALL: 'C', LANG: 'C' } }).catch(() => null)

  const top = await git(['rev-parse', '--show-toplevel'])
  if (top === null) return [unread(m.unreadWhat.git)]
  if (top.exitCode !== 0) {
    // git の管理外のフォルダなら、失う変更もコミットも無い。それ以外の失敗（所有者の不一致など）は読めなかった扱い
    return /not a git repository/i.test(top.stderr) ? [] : [unread(m.unreadWhat.git)]
  }

  const reasons: Reason[] = []
  const status = await git(['status', '--porcelain'])
  if (status === null || status.exitCode !== 0) {
    reasons.push(unread(m.unreadWhat.dirty))
  } else {
    const dirty = status.stdout.split('\n').filter(line => line.trim() !== '').length
    if (dirty > 0) {
      reasons.push({ level: 'blocked', kind: 'dirty', text: m.dirty(dirty), actions: [{ label: m.commitLabel, prompt: m.commitPrompt }] })
    }
  }

  const count = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'])
  const unpushed = count !== null && count.exitCode === 0 ? Number.parseInt(count.stdout.trim(), 10) : Number.NaN
  if (Number.isNaN(unpushed)) {
    reasons.push(unread(m.unreadWhat.unpushed))
  } else if (unpushed > 0) {
    // squash マージ済みで、HEAD がマージ済みの PR の head と同じなら失うものは無い
    const head = (await git(['rev-parse', 'HEAD']))?.stdout.trim() ?? ''
    const heads = await mergedHeads()
    if (heads === null) reasons.push(unread(m.unreadWhat.mergedPrs))
    if (!(heads ?? []).includes(head)) {
      reasons.push({ level: 'blocked', kind: 'unpushed', text: m.unpushed(unpushed), actions: [{ label: m.pushLabel, prompt: m.pushPrompt }] })
    }
  }
  return reasons
}

// ---- 判定

async function evaluate($: EngineInterface): Promise<Report> {
  const now = await $.clock.now()
  const cwd = await $.session.cwd()
  const cliId = await $.session.id()
  const reasons: Reason[] = []

  const record = await readRecord($)
  if (record === null) reasons.push(unread(m.unreadWhat.record))
  const prs = record === null ? [] : recordPrs(record)
  if (record !== null) reasons.push(...cardReasons(record, m, now))

  // 開いている PR と CI。状態は gh で引き直し、読めなければ記録の値で判断する
  let isPrUnread = false
  for (const pr of prs.filter(p => p.state === 'OPEN')) {
    const status = await prStatus($, pr, now)
    if (status === null) isPrUnread = true
    const state = status?.state || pr.state
    if (state !== 'OPEN') continue
    const name = `${pr.repo}#${pr.number}`
    const href = prHref(pr.repo, pr.number)
    reasons.push({ level: 'caution', kind: 'pr', text: m.openPr(name), href })
    if (status?.isCiPending) reasons.push({ level: 'caution', kind: 'ci', text: m.ciPending(name), href })
  }

  const mergedHeads = async (): Promise<string[] | null> => {
    const heads: string[] = []
    for (const pr of prs.filter(p => p.state === 'MERGED')) {
      const status = await prStatus($, pr, now)
      if (status === null) return null
      heads.push(status.headRefOid)
    }
    return heads
  }
  reasons.push(...(await workTreeReasons($, cwd, mergedHeads)))
  if (isPrUnread) reasons.push(unread(m.unreadWhat.prState))

  let messages: MessageLite[] = []
  try {
    messages = await $.session.messages()
  } catch {
    reasons.push(unread(m.unreadWhat.messages))
  }

  // 背景タスク: この CLI のプロセスで起きて、まだ終わりの知らせが来ていないもの
  const ended = endedTaskIds(messages)
  const startedAt = await readProcessStartedAt($, cliId).catch(() => null)
  for (const task of (await read($, tasks)) ?? []) {
    if (ended.has(task.id) || (startedAt !== null && task.startedAt < startedAt)) continue
    reasons.push({ level: 'blocked', kind: 'task', text: m.backgroundTask(task.label || task.id) })
  }
  try {
    for (const agent of await $.agent.list()) {
      if (agent.status === 'running') {
        reasons.push({ level: 'blocked', kind: 'task', text: m.agent(agent.description || agent.type) })
      }
    }
  } catch {
    reasons.push(unread(m.unreadWhat.agents))
  }

  reasons.push(...followupReasons(await loadFollowupsOf($, cliId), m))
  reasons.push(...askReasons(pendingAsks(messages, m)))
  const plan = replayPlan(messages)
  if (plan.left > 0) reasons.push({ level: 'caution', kind: 'plan', text: m.planLeft(plan.left, plan.next) })
  if (guideSetting !== '' && (await readGuide($)) === null) reasons.push(unread(m.unreadWhat.guide))

  const sorted = sortReasons(reasons)
  return { verdict: verdictOf(sorted), reasons: sorted, checkedAt: now }
}

let isEvaluating = false
let isQueued = false
let isScheduled = false

async function runEvaluate($: EngineInterface): Promise<void> {
  if (isEvaluating) {
    isQueued = true
    return
  }
  isEvaluating = true
  try {
    // 判定ごと落ちたら、前の札を残さず「読めなかった」の Check にする
    const next = await evaluate($).catch(async (): Promise<Report> => ({
      verdict: 'caution',
      reasons: [unread(m.unreadWhat.evaluate)],
      checkedAt: await $.clock.now(),
    }))
    const prev = await read($, report)
    const same =
      prev !== null && prev.verdict === next.verdict && JSON.stringify(prev.reasons) === JSON.stringify(next.reasons)
    if (!same) await update($, report, () => next)
  } finally {
    isEvaluating = false
    if (isQueued) {
      isQueued = false
      evaluateSoon($, 1_000)
    }
  }
}

function evaluateSoon($: EngineInterface, delayMs: number): void {
  if (isScheduled) return
  isScheduled = true
  void $.clock.after(delayMs, () => {
    isScheduled = false
    void runEvaluate($).catch(() => undefined)
  })
}

// 帯を押すたびに枠を開く / 閉じる
async function togglePane($: EngineInterface): Promise<void> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane !== undefined && pane.isShown) {
    await $.ui.close({ id: PANE })
    return
  }
  evaluateSoon($, 0)
  const opened = await $.ui.open({ id: PANE, title: m.paneTitle })
  if (!opened.isPlaced) $.ui.toast(m.paneNotPlaced(opened.reason))
}

export const register: Register = (on, options) => {
  m = MESSAGES[langOf(options.language)]
  guideSetting = typeof options.guide === 'string' ? options.guide.trim() : ''

  on('session.start', async ($, e, next) => {
    await $.tool
      .register({
        name: 'followup',
        description: m.toolDescription,
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'done', 'list'] },
            what: { type: 'string', description: m.toolFields.what },
            when: { type: 'string', description: m.toolFields.when },
            how: { type: 'string', description: m.toolFields.how },
            due_at: { type: 'string', description: m.toolFields.dueAt },
            id: { type: 'string', description: m.toolFields.id },
          },
          required: ['action'],
        },
      })
      .catch(() => undefined)
    evaluateSoon($, 0)
    $.clock.every(60_000, () => evaluateSoon($, 0))
    return next(e)
  })

  on('tool.call', { tool: FOLLOWUP_TOOL }, ($, e) => handleFollowupTool($, e as unknown as Record<string, unknown>))

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    void trackTask($, e as unknown as Record<string, unknown>, result).catch(() => undefined)
    evaluateSoon($, 2_000)
    return result
  })

  on('turn.complete', ($, e, next) => {
    evaluateSoon($, 500)
    return next(e)
  })

  // 後続を書き出す基準を Claude に渡す。設定 guide の Markdown があればそれ、無ければ既定の文
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(FOLLOWUP_TOOL)) return composed
    const text = (await readGuide($)) ?? m.guide(FOLLOWUP_TOOL)
    return { sections: [...composed.sections, { id: 'archive-check:followups', text, scope: 'session' as const }] }
  })

  // 帯に重ねた hit.ts が、押されたことを知らせてくる
  on('ui.message', async ($, e, next) => {
    const data = e.data as { source?: unknown } | null
    if (typeof data !== 'object' || data === null || data.source !== 'archive-check') return next(e)
    await togglePane($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // ターミナルには描かない（Desktop の帯だけ）
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
    const below = await next(e)
    const current = await read($, report)
    if (current === null) return below

    const { Box, Client, Svg } = $.ui.resolve(e)

    // 札。下の mod（usage-bars など）の木があれば、その左に並べる
    const badge = (
      <Box position="relative" flexShrink={0}>
        <Svg source={badgeSvg(current.verdict)} alt={m.alt[current.verdict]} width={m.badgeWidth} height={HEIGHT} />
        <Box position="absolute" top={0} left={0} right={0} bottom={0}>
          <Client key="hit-archive-check" module="./hit.ts" props={{}} width="100%" height="100%" />
        </Box>
      </Box>
    )
    const hasBelow = (below as { type?: unknown }).type !== 'engine'
    if (!hasBelow) return badge
    return (
      <Box flexDirection="row" gap={1}>
        {badge}
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {below}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const current = await read($, report)
    const cliId = await $.session.id()

    if (current === null) return <Text dimColor>{m.checking}</Text>

    const tag = (r: Reason) => (r.kind === 'followup' || r.kind === 'ci' ? m.tagFollowup : r.kind === 'ask' ? m.tagAsk : null)
    const row = (r: Reason, i: number) => (
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexDirection="column" flexShrink={1}>
          <Box flexDirection="row" gap={1}>
            {tag(r) ? <Text dimColor>{tag(r)}</Text> : null}
            <Text>{r.text}</Text>
          </Box>
          {r.note ? <Text dimColor>{r.note}</Text> : null}
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {r.href ? <Link href={r.href} label={m.open} /> : null}
          {r.followupId ? (
            <Button
              key={`done:${r.followupId}`}
              label={m.markDone}
              onPress={async () => {
                await removeFollowupOf($, cliId, r.followupId ?? '')
                await runEvaluate($)
              }}
            />
          ) : null}
          {(r.actions ?? []).map((a, j) => (
            <Button key={`act:${i}:${j}`} label={a.label} onPress={() => submitPrompt($, a)} />
          ))}
        </Box>
      </Box>
    )

    const blocked = current.reasons.filter(r => r.level === 'blocked')
    const caution = current.reasons.filter(r => r.level === 'caution')
    const section = (title: string, color: 'error' | 'warning', list: Reason[], offset: number) =>
      list.length === 0 ? null : (
        <Box flexDirection="column">
          <Text bold color={color}>
            {title}
          </Text>
          {list.map((r, i) => row(r, offset + i))}
        </Box>
      )

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color={current.verdict === 'ok' ? 'success' : current.verdict === 'caution' ? 'warning' : 'error'}>
          {m.verdict[current.verdict]}
        </Text>
        {current.reasons.length === 0 ? <Text dimColor>{m.nothingLeft}</Text> : null}
        {section(m.sectionBlocked, 'error', blocked, 0)}
        {section(m.sectionCaution, 'warning', caution, blocked.length)}
      </Box>
    )
  })
}
