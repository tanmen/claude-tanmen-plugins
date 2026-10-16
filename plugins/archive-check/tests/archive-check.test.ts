import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { endedInNotification, endedTaskIds, parsePrStatus, pendingAsks, publishedArtifacts, replayPlan } from '../hooks/logic'
import type { MessageLite } from '../hooks/logic'
import { MESSAGES } from '../hooks/messages'

// 日本語の文言で確かめるテスト（既定は英語）
const JA = { options: { language: 'ja' } }
const JA_M = MESSAGES.ja

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'archive-check',
  props: {
    title: 'アーカイブ',
    isFocused: false,
    bodyColumns: 87,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 66 },
    view: {},
  },
} as const

const RECORD = 'C:\\appdata\\Claude\\claude-code-sessions\\acc\\prof\\local_1.json'
const PID_FILE = 'C:\\home\\.claude\\sessions\\100.json'

type World = {
  dirty?: string
  unpushed?: number
  head?: string
  record?: object | null
  files?: Record<string, string>
  store?: Record<string, unknown>
  messages?: MessageLite[]
  gh?: Record<string, object>
  isRepo?: boolean
  gitError?: string
  cwdFails?: boolean
  submitted?: string[]
  opened?: string[]
}

const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
const file = (name: string) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })

// この mod の下にあるもの（git・gh・Desktop の記録・transcript）をまとめて答える
function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, w.store ?? {})
  mock.env(on, { USERPROFILE: 'C:\\home', APPDATA: 'C:\\appdata', CLAUDE_CODE_HOST_SESSION_ID: 'local_1' })
  const files: Record<string, string> = {
    [PID_FILE]: JSON.stringify({ sessionId: 'cli-1', startedAt: 500_000 }),
  }
  if (w.record !== null) files[RECORD] = JSON.stringify(w.record ?? {})
  Object.assign(files, w.files ?? {})

  // 枠を開いた・閉じた・Claude に頼んだ記録
  const panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
  on('ui.open', ($, e) => {
    w.opened?.push(`open:${e.id}`)
    if (!panes.some(p => p.id === e.id)) panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    w.opened?.push(`close:${e.id}`)
    const i = panes.findIndex(p => p.id === e.id)
    if (i >= 0) panes.splice(i, 1)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes] }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    w.submitted?.push(e.text)
    return { text: e.text }
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'cli-1' }))
  on('session.cwd', () => (w.cwdFails ? { deny: 'unavailable' } : { value: 'C:\\work' }))
  on('session.messages', () => ({ value: (w.messages ?? []) as never }))
  on('agent.list', () => ({ value: [] }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__archive-check__${e.name}` } }))
  on('fs.list', ($, e) => {
    if (e.path === 'C:\\appdata\\Claude\\claude-code-sessions') return { value: [dir('acc')] }
    if (e.path.endsWith('\\acc')) return { value: [dir('prof')] }
    if (e.path === 'C:\\home\\.claude\\sessions') return { value: [file('100.json')] }
    return { value: [] }
  })
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  const run = (exitCode: number, stdout: string, stderr = '') => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    const ok = (stdout: string) => run(0, stdout)
    if (argv.includes('--show-toplevel')) {
      if (w.gitError) return run(128, '', w.gitError)
      return w.isRepo === false ? run(128, '', 'fatal: not a git repository (or any of the parent directories): .git') : ok('C:/work\n')
    }
    if (argv.includes('status --porcelain')) return ok(w.dirty ?? '')
    if (argv.includes('rev-list --count')) return ok(`${w.unpushed ?? 0}\n`)
    if (argv.endsWith('rev-parse HEAD')) return ok(`${w.head ?? 'aaa'}\n`)
    if (e.argv[0] === 'gh') {
      const key = `${e.argv[5]}#${e.argv[3]}`
      const body = w.gh?.[key]
      return body ? ok(JSON.stringify(body)) : run(1, '', 'not found')
    }
    return ok('')
  })
  return clock
}

async function start($: Engine, clock: MockClock) {
  await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true } as never)
  await clock.advance(0)
  await clock.settle()
}

// このセッションの後続と、枠のボタンが最後に頼んだ結果（道具の list で読む）
async function listFollowups($: Engine): Promise<unknown> {
  const called = (await $.tool.call({ tool: 'mcp__archive-check__followup', action: 'list' } as never)) as { result?: unknown }
  return JSON.parse(String(called.result))
}

async function badge(ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) {
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(1)
  return { source: String(svgs[0]?.props.source), alt: String(svgs[0]?.props.alt) }
}

test('未コミットの変更があれば「作」にして、下の mod の木の左に並べる', JA, async ($, on) => {
  const clock = world(on, { dirty: ' M a.ts\n?? b.ts\n' })
  on('ui.render', () => ({ type: 'Box' }))
  await start($, clock)

  const ui = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  const { source, alt } = await badge(ui)
  expect(source).toContain('>作<')
  expect(source).toContain('#F09595')
  expect(alt).toBe('作業中（アーカイブすると作業を失う）')
  // 札と、下の mod の木（ここでは空の Box）が横に並ぶ
  const drawn = (await ui.drawn()) as { type: string; props?: { flexDirection?: string }; children?: unknown[] }
  expect(drawn.props?.flexDirection).toBe('row')
  expect(drawn.children).toHaveLength(2)
  await ui.unmount()
})

test('どれも無ければ「済」。git の管理外のフォルダでも「済」', JA, async ($, on) => {
  const clock = world(on, { isRepo: false })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const ui = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  const { source, alt } = await badge(ui)
  expect(source).toContain('>済<')
  expect(source).toContain('#5DCAA5')
  expect(alt).toBe('作業済み（アーカイブしてよい）')
  await ui.unmount()
})

test('帯を押すと右側の枠を開き、もう一度押すと閉じる', JA, async ($, on) => {
  const opened: string[] = []
  const clock = world(on, { dirty: ' M a.ts\n', opened })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const band = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  await band.post({ source: 'archive-check' })
  await clock.advance(0)
  await clock.settle()
  expect(opened).toEqual(['open:archive-check'])

  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: '作業中' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'アーカイブすると失うもの' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /未コミットの変更 1 件/ })).toBeDefined()
  expect((await pane.findAll({ type: 'Button' })).map(b => String(b.props.label))).toEqual(['コミットを頼む'])
  await pane.unmount()

  await band.post({ source: 'archive-check' })
  expect(opened).toEqual(['open:archive-check', 'close:archive-check'])
  await band.unmount()
})

test('Desktop の記録が読めなければ「済」にせず、枠に読めなかったと出す', JA, async ($, on) => {
  const clock = world(on, { record: null })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const ui = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  expect((await badge(ui)).source).toContain('>注<')
  await ui.unmount()
  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: /読めなかった: Desktop の記録/ })).toBeDefined()
  await pane.unmount()
})

test('未起動の提案カードは「作」で起動を頼める。開いた PR は注意でリンクが付き、CI 待ちは後続に数える', JA, async ($, on) => {
  const submitted: string[] = []
  const clock = world(on, {
    submitted,
    record: {
      backgroundTaskSuggestions: [{ id: 'task_1', title: '続きの作業' }],
      prs: [{ prNumber: 12, repo: 'tanmen/x', state: 'OPEN' }],
    },
    gh: {
      'tanmen/x#12': { state: 'OPEN', headRefOid: 'bbb', statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }] },
    },
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const ui = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  expect((await badge(ui)).source).toContain('>作<')
  await ui.unmount()

  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: /未起動の提案カード「続きの作業」/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /開いている PR tanmen\/x#12/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /CI が終わっていない/ })).toBeDefined()
  const links = await pane.findAll({ type: 'Link' })
  expect(links.map(l => String(l.props.href))).toContain('https://github.com/tanmen/x/pull/12')

  const launch = (await pane.findAll({ type: 'Button' })).find(b => String(b.props.label) === '起動を頼む')
  expect(launch).toBeDefined()
  await pane.press({ key: String(launch?.props.key) })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('提案カード「続きの作業」（task_1）を起動して')
  expect(await listFollowups($)).toMatchObject({ lastSubmit: { label: '起動を頼む', result: 'submitted' } })
  await pane.unmount()
})

test('remote に無いコミットも、マージ済みの PR の head と同じなら失うものは無い', JA, async ($, on) => {
  const clock = world(on, {
    unpushed: 3,
    head: 'ccc',
    record: { prs: [{ prNumber: 5, repo: 'tanmen/x', state: 'MERGED' }] },
    gh: { 'tanmen/x#5': { state: 'MERGED', headRefOid: 'ccc', statusCheckRollup: [] } },
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const ui = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  expect((await badge(ui)).source).toContain('>済<')
  await ui.unmount()
})

test('後続を書き出すと「注」になり、枠で予定に移すと Claude に頼み、済みにすると消える', JA, async ($, on) => {
  const submitted: string[] = []
  const clock = world(on, { submitted })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  await $.tool.call({
    tool: 'mcp__archive-check__followup',
    action: 'add',
    what: '出品の反応を見て値下げを決める',
    when: '10/18 以降',
    how: '閲覧数といいねを見る',
  } as never)
  await clock.advance(0)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  expect((await badge(ui)).source).toContain('>注<')

  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: '出品の反応を見て値下げを決める（10/18 以降）' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '閲覧数といいねを見る' })).toBeDefined()

  const buttons = await pane.findAll({ type: 'Button' })
  const schedule = buttons.find(b => String(b.props.label) === '予定に移す')
  await pane.press({ key: String(schedule?.props.key) })
  expect(submitted[0]).toContain('後続「出品の反応を見て値下げを決める」を予定タスクに移して')

  const done = buttons.find(b => String(b.props.label) === '済みにする')
  await pane.press({ key: String(done?.props.key) })
  await clock.settle()
  expect((await badge(ui)).source).toContain('>済<')
  expect(await listFollowups($)).toMatchObject({ followups: [] })
  await pane.unmount()
  await ui.unmount()
})

test('承認待ちの wrap_up の選択肢を、枠から返事として送れる', JA, async ($, on) => {
  const submitted: string[] = []
  const wrap = {
    tool: 'mcp__ccd_turn__wrap_up',
    input: {
      recap: 'x',
      ask: 'どちらを先に直しますか？',
      actions: [{ label: '1 を直す', message: '1 から直して' }, { label: '2 を直す' }, { action: 'commit' }, { action: 'archive' }],
    },
    text: 'shown',
  }
  const clock = world(on, { submitted, messages: [{ role: 'assistant', text: '', toolUses: [wrap] }, { role: 'user', text: '', toolUses: [] }] })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: 'どちらを先に直しますか？' })).toBeDefined()
  const labels = (await pane.findAll({ type: 'Button' })).map(b => String(b.props.label))
  expect(labels).toEqual(['1 を直す', '2 を直す', 'コミット'])
  const first = (await pane.findAll({ type: 'Button' }))[0]
  await pane.press({ key: String(first?.props.key) })
  expect(submitted).toEqual(['1 から直して'])
  await pane.unmount()
})

test('枠にはこのセッションの後続だけを出し、他のセッションの後続は出さない', JA, async ($, on) => {
  const clock = world(on, {
    store: {
      'followups:cli-1': [{ id: 'f1', what: '効いたか確かめる', when: '数日後', how: '', createdAt: 1 }],
      // 0.1.0 が書いた形（記録の名前と題つき）の、他のセッションの後続
      'followups:cli-2': [
        { id: 'f2', what: '値下げを決める', when: '3 日後', how: 'いいねを見る', createdAt: 2, hostId: 'local_2', sessionTitle: 'メルカリの出品' },
      ],
    },
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: '効いたか確かめる（数日後）' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '値下げを決める（3 日後）' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'メルカリの出品' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'いいねを見る' })).toBeUndefined()
  const keys = (await pane.findAll({ type: 'Button' })).map(b => String(b.props.key))
  expect(keys).toContain('done:f1')
  expect(keys.some(k => k.includes('f2'))).toBe(false)
  await pane.unmount()
})

// Artifact ツールの公開の記録（result は transcript の toolUseResult と同じ形）
const publish = (id: string, title: string) => ({
  tool: 'Artifact',
  input: { file_path: `C:\\scratch\\${id}.html`, icon: 'compare' },
  result: { url: `https://claude.ai/artifact/${id}`, title, updated: false, seq: 1 },
  text: `Published C:\\scratch\\${id}.html at https://claude.ai/artifact/${id} (Version 1, version id 1-a)`,
})

test('作った Artifact があれば「注」にし、片付けを頼むと Claude に URL ごと頼んで枠から外す', JA, async ($, on) => {
  const submitted: string[] = []
  const clock = world(on, {
    isRepo: false,
    submitted,
    messages: [{ role: 'assistant', text: '', toolUses: [publish('AAA111', '前後の絵'), publish('BBB222', '比べたページ')] }],
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const ui = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  expect((await badge(ui)).source).toContain('>注<')

  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: 'アーカイブする前に確かめること' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '作った Artifact 2 件' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '「前後の絵」「比べたページ」' })).toBeDefined()
  const buttons = await pane.findAll({ type: 'Button' })
  expect(buttons.map(b => String(b.props.label))).toEqual(['片付けを頼む', '残す'])

  await pane.press({ key: String(buttons[0]?.props.key) })
  await clock.settle()
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('このセッションで作った Artifact 2 件を artifact-sweep で調べて、要らないものを消して')
  expect(submitted[0]).toContain('- 「前後の絵」 https://claude.ai/artifact/AAA111')
  expect(submitted[0]).toContain('https://claude.ai/artifact/BBB222')
  // 頼んだ分は枠から外れ、ほかに何も無いので「済」に戻る
  expect((await badge(ui)).source).toContain('>済<')
  await pane.unmount()
  await ui.unmount()
})

test('作った Artifact は「残す」で枠から外れ、Claude には何も送らない', JA, async ($, on) => {
  const submitted: string[] = []
  const clock = world(on, {
    isRepo: false,
    submitted,
    messages: [{ role: 'assistant', text: '', toolUses: [publish('AAA111', '計画')] }],
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  // 1 件ならその Artifact を開くリンクが付く
  expect((await pane.findAll({ type: 'Link' })).map(l => String(l.props.href))).toEqual(['https://claude.ai/artifact/AAA111'])
  const keep = (await pane.findAll({ type: 'Button' })).find(b => String(b.props.label) === '残す')
  await pane.press({ key: String(keep?.props.key) })
  await clock.settle()
  expect(submitted).toEqual([])
  expect(await pane.find({ type: 'Text', text: /作った Artifact/ })).toBeUndefined()

  const ui = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  expect((await badge(ui)).source).toContain('>済<')
  await ui.unmount()
  await pane.unmount()
})

test('作った Artifact の行は英語の既定でも出る（Ask to tidy up / Keep）', async ($, on) => {
  const submitted: string[] = []
  const clock = world(on, { isRepo: false, submitted, messages: [{ role: 'assistant', text: '', toolUses: [publish('AAA111', 'Plan')] }] })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: '1 artifact created' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '“Plan”' })).toBeDefined()
  const buttons = await pane.findAll({ type: 'Button' })
  expect(buttons.map(b => String(b.props.label))).toEqual(['Ask to tidy up', 'Keep'])
  await pane.press({ key: String(buttons[0]?.props.key) })
  expect(submitted[0]).toContain('Check the 1 artifact created in this session with artifact-sweep')
  expect(submitted[0]).toContain('- “Plan” https://claude.ai/artifact/AAA111')
  await pane.unmount()
})

test('ターミナルとアンケート中は帯に描かない', JA, async ($, on) => {
  const clock = world(on, { dirty: ' M a.ts\n' })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const terminal = await $.ui.mount({ plugin: 'archive-check', surface: 'terminal', ...BAND })
  expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
  await terminal.unmount()
  const survey = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await survey.findAll({ type: 'Svg' })).toHaveLength(0)
  await survey.unmount()
})

test('既定は英語（Busy / Check / Done）', async ($, on) => {
  const clock = world(on, { dirty: ' M a.ts\n' })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const ui = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  const { source, alt } = await badge(ui)
  expect(source).toContain('>Busy<')
  expect(source).toContain('width="46"')
  expect(alt).toBe('Busy (archiving loses work)')
  await ui.unmount()
  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: 'Lost if you archive' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '1 uncommitted change' })).toBeDefined()
  expect((await pane.findAll({ type: 'Button' })).map(b => String(b.props.label))).toEqual(['Ask to commit'])
  await pane.unmount()
})

test('git の管理外以外の失敗（所有者の不一致など）は Done にせず、読めなかったと出す', async ($, on) => {
  const clock = world(on, { gitError: "fatal: detected dubious ownership in repository at 'C:/work'" })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: 'Check first' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: "Couldn't read: git" })).toBeDefined()
  await pane.unmount()
})

test('判定ごと落ちたら、前の札を残さず Check にする', async ($, on) => {
  const clock = world(on, { cwdFails: true })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const ui = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  expect((await badge(ui)).source).toContain('>Check<')
  await ui.unmount()
  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: "Couldn't read: what the check needs" })).toBeDefined()
  await pane.unmount()
})

test('期限（expiresAt）を過ぎた提案カードは数えない', async ($, on) => {
  const clock = world(on, {
    isRepo: false,
    record: {
      backgroundTaskSuggestions: [
        { id: 'task_old', title: '期限切れ', expiresAt: 999_999 },
        { id: 'task_new', title: 'まだ有効', expiresAt: 2_000_000 },
      ],
    },
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: 'Unstarted suggested task “まだ有効”' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /期限切れ/ })).toBeUndefined()
  await pane.unmount()
})

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['desktop'], tools: ['mcp__archive-check__followup'], outputStyle: null, traits: [] }

test('Claude への指示は、設定 guide の Markdown があればその中身に差し替える', { options: { guide: '~/guide.md' } }, async ($, on) => {
  const clock = world(on, { files: { 'C:\\home\\guide.md': '# 自分の基準\n予定タスクは fireAt で作る' } })
  on('prompt.compose', () => ({ sections: [] }))
  await start($, clock)

  const composed = (await $.prompt.compose(COMPOSE as never)) as unknown as { sections: { id: string; text: string }[] }
  expect(composed.sections.find(s => s.id === 'archive-check:followups')?.text).toBe('# 自分の基準\n予定タスクは fireAt で作る')
})

test('guide の Markdown が読めなければ既定の文を渡し、枠に読めなかったと出す', { options: { guide: '~/missing.md' } }, async ($, on) => {
  const clock = world(on, { isRepo: false })
  on('prompt.compose', () => ({ sections: [] }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await start($, clock)

  const composed = (await $.prompt.compose(COMPOSE as never)) as unknown as { sections: { id: string; text: string }[] }
  expect(composed.sections.find(s => s.id === 'archive-check:followups')?.text).toContain('# Follow-ups (archive-check)')
  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: "Couldn't read: guide file" })).toBeDefined()
  await pane.unmount()
})

// 背景タスクの知らせ（transcript に残る形と同じ並び）
const notification = (id: string, status: string) =>
  [
    '<task-notification>',
    `<task-id>${id}</task-id>`,
    '<tool-use-id>toolu_1</tool-use-id>',
    `<output-file>C:\\temp\\tasks\\${id}.output</output-file>`,
    `<status>${status}</status>`,
    `<summary>Background command "待つ" ${status}</summary>`,
    '</task-notification>',
  ].join('\n')

test('ターン中に届いた背景タスクの知らせで、動いている背景タスクから外れる', JA, async ($, on) => {
  const clock = world(on, { isRepo: false })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  // 背景で走らせた Bash は、記録に backgroundTaskId を持って返る
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' } as never }))
  await start($, clock)

  await $.tool.call({ tool: 'Bash', command: 'sleep 30', description: '待つ', run_in_background: true } as never)
  await clock.advance(2_000)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...BAND })
  expect((await badge(ui)).source).toContain('>作<')

  // まだ動いている知らせ（Monitor の途中経過など）では外さない
  await $.prompt.submit({ text: notification('bg1', 'running'), origin: { kind: 'task-notification' }, turnId: 'turn-1', wait: false } as never)
  await clock.advance(0)
  await clock.settle()
  expect((await badge(ui)).source).toContain('>作<')

  // 走っているターンに届いた知らせ（turnId あり）は会話の行にならない。ここでも $.session.messages() は空のまま
  await $.prompt.submit({ text: notification('bg1', 'completed'), origin: { kind: 'task-notification' }, turnId: 'turn-1', wait: false } as never)
  await clock.advance(0)
  await clock.settle()
  expect((await badge(ui)).source).toContain('>済<')
  await ui.unmount()
})

test('知らせ以外の入力に知らせの形の文があっても、背景タスクは外さない', JA, async ($, on) => {
  const clock = world(on, { isRepo: false })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' } as never }))
  await start($, clock)

  await $.tool.call({ tool: 'Bash', command: 'sleep 30', description: '待つ', run_in_background: true } as never)
  // 本人が知らせを貼り付けて送った
  await $.prompt.submit({ text: notification('bg1', 'completed'), origin: { kind: 'composer' }, wait: false } as never)
  await clock.advance(2_000)
  await clock.settle()
  const pane = await $.ui.mount({ plugin: 'archive-check', surface: 'desktop', ...PANE })
  expect(await pane.find({ type: 'Text', text: '動いている背景タスク「待つ」' })).toBeDefined()
  await pane.unmount()
})

// ---- 判定の部品

const use = (tool: string, input: Record<string, unknown>, text?: string) => ({ tool, input, ...(text === undefined ? {} : { text }) })
const assistant = (...toolUses: ReturnType<typeof use>[]): MessageLite => ({ role: 'assistant', text: '', toolUses })
const user = (text = ''): MessageLite => ({ role: 'user', text, toolUses: [] })

test('タスク一覧を再生して残りの手順を数える', () => {
  const items = [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'pending' },
  ]
  const plan = 'mcp__ccd_turn__update_plan'
  expect(replayPlan([assistant(use(plan, { items }, 'ok'))])).toEqual({ left: 3, next: 'a' })
  expect(replayPlan([assistant(use(plan, { items }, 'ok'), use(plan, { advance: true }, 'ok'))])).toEqual({ left: 2, next: 'b' })
  expect(replayPlan([assistant(use(plan, { items }, 'ok'), use(plan, { done: [1, 2], start: 3 }, 'ok'))])).toEqual({ left: 1, next: 'c' })
  // 最後の手順は wrap_up が済ませる
  const finished = [use(plan, { items }, 'ok'), use(plan, { done: [1, 2], start: 3 }, 'ok'), use('mcp__ccd_turn__wrap_up', { recap: 'x' }, 'ok')]
  expect(replayPlan([assistant(...finished)])).toEqual({ left: 0, next: null })
})

test('最後の wrap_up の ask は、そのあとに何も無いときだけ承認待ち', () => {
  const wrap = use('mcp__ccd_turn__wrap_up', { recap: 'x', ask: '進めてよいですか？', blocked: true, actions: [{ label: 'はい' }] }, 'shown')
  expect(pendingAsks([assistant(wrap), user()], JA_M)).toEqual([{ text: '進めてよいですか？', actions: [{ label: 'はい', prompt: 'はい' }] }])
  expect(pendingAsks([assistant(wrap), user(), user('進めて')], JA_M)).toEqual([])
  expect(pendingAsks([assistant(wrap), user(), assistant(use('Bash', {}, 'ok'))], JA_M)).toEqual([])
  expect(pendingAsks([assistant(use('mcp__ccd_turn__wrap_up', { recap: 'x' }, 'shown'))], JA_M)).toEqual([])
  // 返事待ちの offer と AskUserQuestion（結果がまだ無い）は、枠から答えられないのでボタンは無い
  expect(pendingAsks([assistant(use('mcp__ccd_session__start_session', { initiation: 'offer', title: '別件' }))], JA_M)).toEqual([
    { text: '新しいセッションか、ここでやるか「別件」', actions: [] },
  ])
  expect(pendingAsks([assistant(use('AskUserQuestion', {}))], JA_M)).toEqual([{ text: '質問への回答', actions: [] }])
})

test('作った Artifact を公開の記録から拾い、消したもの・資産・前の会話の更新は数えない', () => {
  const art = (input: Record<string, unknown>, result?: unknown, text?: string, isError?: true) => ({
    tool: 'Artifact',
    input,
    ...(result === undefined ? {} : { result }),
    ...(text === undefined ? {} : { text }),
    ...(isError ? { isError } : {}),
  })
  const messages: MessageLite[] = [
    assistant(
      // 記録の url と title から
      art({ file_path: 'a.html' }, { url: 'https://claude.ai/artifact/AAA', title: 'A' }, 'Published a.html at https://claude.ai/artifact/AAA'),
      // 同じ file_path の再公開は 1 件のまま（題は新しいほう）
      art({ file_path: 'a.html' }, { url: 'https://claude.ai/artifact/AAA', title: 'A2' }, 'Published a.html at https://claude.ai/artifact/AAA'),
      // 記録が無ければ本文の URL から（action: publish を明示した形）
      art({ action: 'publish', file_path: 'b.html' }, undefined, 'Published b.html at https://claude.ai/artifact/BBB (Version 1)'),
      // 型から作った Artifact も数える
      art({ type_url: 'https://claude.ai/artifact/TYPE', title: 'From type' }, { url: 'https://claude.ai/artifact/CCC' }, 'Created'),
      // 前の会話の Artifact の更新・資産の上げ下ろし・読む・一覧・失敗した公開は数えない
      art({ url: 'https://claude.ai/artifact/OLD', file_path: 'o.html' }, { url: 'https://claude.ai/artifact/OLD', title: 'old' }, 'Published'),
      art({ url: 'https://claude.ai/artifact/AAA', asset: true, file_path: 'x.png' }, { url: 'https://claude.ai/artifact/AAA/assets/x' }, 'Uploaded'),
      art({ action: 'read', url: 'https://claude.ai/artifact/RRR' }, undefined, 'https://claude.ai/artifact/RRR'),
      art({ action: 'list' }, undefined, '- x — https://claude.ai/artifact/LLL'),
      art({ file_path: 'e.html' }, undefined, 'Error: https://claude.ai/artifact/EEE', true),
      // BBB は消した。AAA の資産だけを消した呼び出しでは AAA は残る
      art({ action: 'delete', url: 'https://claude.ai/artifact/BBB' }, undefined, 'Deleted'),
      art({ action: 'delete', url: 'https://claude.ai/artifact/AAA', path: '0123456789abcdef0123456789abcdef' }, undefined, 'Deleted asset'),
    ),
  ]
  expect(publishedArtifacts(messages)).toEqual([
    { id: 'AAA', url: 'https://claude.ai/artifact/AAA', title: 'A2' },
    { id: 'CCC', url: 'https://claude.ai/artifact/CCC', title: 'From type' },
  ])
  // 確認待ち（結果がまだ無い）の削除と、本人が断った削除（isError）では消えない
  const made = art({ file_path: 'b.html' }, { url: 'https://claude.ai/artifact/BBB' }, 'Published')
  expect(publishedArtifacts([assistant(made, art({ action: 'delete', url: 'https://claude.ai/artifact/BBB' }))])).toHaveLength(1)
  expect(publishedArtifacts([assistant(made, art({ action: 'delete', url: 'https://claude.ai/artifact/BBB' }, undefined, 'denied', true))])).toHaveLength(1)
})

test('背景タスクの終わりを知らせと TaskStop から引く', () => {
  const note = [
    '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>',
    '<task-notification>\n<task-id>m1</task-id>\n<status>running</status>\n</task-notification>',
  ].join('\n')
  const ended = endedTaskIds([user(note), assistant(use('TaskStop', { task_id: 'b2' }, 'ok'))])
  expect([...ended].sort()).toEqual(['b1', 'b2'])
  // 知らせの本文 1 つに複数のタスク（idle の間に溜まった分）
  expect(endedInNotification(`${notification('a1', 'completed')}\n${notification('a2', 'failed')}\n${notification('a3', 'running')}`)).toEqual(['a1', 'a2'])
  expect(endedInNotification('ただの文')).toEqual([])
})

test('PR の CI が終わっていないかを statusCheckRollup から読む', () => {
  expect(parsePrStatus(JSON.stringify({ state: 'OPEN', headRefOid: 'a', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED' }] }))?.isCiPending).toBe(false)
  expect(parsePrStatus(JSON.stringify({ state: 'OPEN', headRefOid: 'a', statusCheckRollup: [{ __typename: 'StatusContext', state: 'PENDING' }] }))?.isCiPending).toBe(true)
  expect(parsePrStatus('not json')).toBeNull()
})
