import { expect, mock, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'

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

const HOUR = 3_600_000

test('Desktop の帯に context・5h・7d の 3 本を SVG で出す', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))

  const now = clock.now()
  await $.session.measure({
    context: { tokens: 340_000, window: 1_000_000, percent: 34 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(now + 3 * HOUR + 20 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 81.5, resetsAt: new Date(now + 52 * HOUR).toISOString() },
    ],
    changed: ['context', 'rateLimits'],
  })

  const ui = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  const bars = await ui.findAll({ type: 'Svg' })
  expect(bars).toHaveLength(3)

  const [context, fiveHour, sevenDay] = bars.map(bar => ({
    source: String(bar.props.source),
    alt: String(bar.props.alt),
  }))
  expect(context?.source).toContain('>34%<')
  expect(context?.source).toContain('width="34%"')
  expect(context?.alt).toContain('340K / 1M')
  expect(fiveHour?.source).toContain('>12%<')
  expect(fiveHour?.source).toContain('>3h20m<')
  expect(fiveHour?.source).toContain('#5DCAA5')
  expect(sevenDay?.source).toContain('>82%<')
  expect(sevenDay?.source).toContain('>2d4h<')
  // 80% 以上は赤
  expect(sevenDay?.source).toContain('#F09595')
  await ui.unmount()
})

test('ターミナルとアンケート中は帯を描かない', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))
  await $.session.measure({
    context: { tokens: 1_000, window: 200_000, percent: 1 },
    rateLimits: [],
    changed: ['context'],
  })

  const desktop = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(3)
  await desktop.unmount()

  const terminal = await $.ui.mount({ plugin: 'usage-bars', surface: 'terminal', ...BAND })
  expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
  await terminal.unmount()

  const survey = await $.ui.mount({
    plugin: 'usage-bars',
    surface: 'desktop',
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
  })
  expect(await survey.findAll({ type: 'Svg' })).toHaveLength(0)
  await survey.unmount()
})

test('下に別の mod の木があればバーの左に並べ、無ければバーだけを出す', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  let beneath: unknown = { type: 'Text', props: {}, children: ['下の mod'] }
  on('ui.render', () => beneath as never)
  await $.session.measure({
    context: { tokens: 1_000, window: 200_000, percent: 1 },
    rateLimits: [],
    changed: ['context'],
  })

  const withBelow = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  const drawn = (await withBelow.drawn()) as { props?: { flexDirection?: string }; children?: unknown[] }
  expect(drawn.props?.flexDirection).toBe('row')
  expect(drawn.children).toHaveLength(2)
  expect(await withBelow.find({ type: 'Text', text: '下の mod' })).toBeDefined()
  expect(await withBelow.findAll({ type: 'Svg' })).toHaveLength(3)
  await withBelow.unmount()

  // エンジン自身の帯（下に何も無い）は出さず、バーだけ
  beneath = { type: 'engine', ref: 0 }
  const alone = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  expect(await alone.find({ type: 'Text', text: '下の mod' })).toBeUndefined()
  const bars = (await alone.drawn()) as { children?: unknown[] }
  expect(bars.children).toHaveLength(3)
  await alone.unmount()
})

test('5h / 7d が無い間は前回の値を色を落として出す', async ($, on) => {
  const clock = mock.clock(on)
  const now = clock.now()
  mock.store(on, {
    windows: {
      windows: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(now + HOUR).toISOString() }],
      readAt: now - 10 * 60_000,
    },
  })
  on('session.usage', () => ({ value: { startedAt: now, context: { window: 200_000 }, rateLimits: [] } }))
  // サブスクリプションでログインしているが、使用量 API は読めない（通信の失敗）
  on('session.authorize', () => ({ value: { handle: 'credential-handle', kind: 'bearer' } }))
  usageApi(on, 503, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'Box' }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  const [, fiveHour, sevenDay] = (await ui.findAll({ type: 'Svg' })).map(bar => ({
    source: String(bar.props.source),
    alt: String(bar.props.alt),
  }))
  expect(fiveHour?.source).toContain('>40%<')
  expect(fiveHour?.source).not.toContain('#5DCAA5')
  expect(fiveHour?.alt).toContain('前回のセッションの値')
  expect(sevenDay?.source).toContain('>--<')
  await ui.unmount()
})

test('色は表示する数字で決める（79.6 は「80%」で赤）', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))

  const now = clock.now()
  await $.session.measure({
    context: { tokens: 1_000, window: 200_000, percent: 1 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 79.6, resetsAt: new Date(now + HOUR).toISOString() },
      { kind: 'seven_day', percentUsed: 49.5, resetsAt: new Date(now + 24 * HOUR).toISOString() },
    ],
    changed: ['context', 'rateLimits'],
  })

  const ui = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  const [, fiveHour, sevenDay] = (await ui.findAll({ type: 'Svg' })).map(bar => String(bar.props.source))
  expect(fiveHour).toContain('>80%<')
  expect(fiveHour).toContain('#F09595')
  expect(sevenDay).toContain('>50%<')
  expect(sevenDay).toContain('#EF9F27')
  await ui.unmount()
})

test('応答が来ても 5h / 7d が空なら、持ち越した値を消す（API キーなど）', async ($, on) => {
  const clock = mock.clock(on)
  const now = clock.now()
  mock.store(on, {
    windows: {
      windows: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(now + HOUR).toISOString() }],
      readAt: now - 10 * 60_000,
    },
  })
  on('session.usage', () => ({ value: { startedAt: now, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.authorize', () => ({ value: { handle: 'credential-handle', kind: 'bearer' } }))
  usageApi(on, 503, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { tokens: 5_000, window: 200_000, percent: 3 },
    rateLimits: [],
    changed: ['context'],
  })

  const ui = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  const [, fiveHour] = (await ui.findAll({ type: 'Svg' })).map(bar => String(bar.props.source))
  expect(fiveHour).toContain('>--<')
  expect(fiveHour).not.toContain('>40%<')
  await ui.unmount()
})

async function barHeights($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) {
  mock.clock(on)
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))
  await $.session.measure({ context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  const heights = (await ui.findAll({ type: 'Svg' })).map(bar => /<svg [^>]*height="(\d+)"/.exec(String(bar.props.source))?.[1])
  await ui.unmount()
  return heights
}

test('大きさの既定は compact（バー 19px）', async ($, on) => {
  expect(await barHeights($, on)).toEqual(['19', '19', '19'])
})

test('size=regular ならバー 26px', { options: { size: 'regular' } }, async ($, on) => {
  expect(await barHeights($, on)).toEqual(['26', '26', '26'])
})

test('選択肢に無い size は既定の compact に戻る', { options: { size: 'huge' } }, async ($, on) => {
  expect(await barHeights($, on)).toEqual(['19', '19', '19'])
})

// mock.store は外から書き足せないので、別のセッションの書き込みを再現できる形で自前に持つ
function sharedStore(on: Parameters<TestBody>[1], entries: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(entries))
  on('store.get', ($, e) => ({ value: values.get(e.key) }))
  on('store.set', ($, e) => {
    values.set(e.key, e.value)
    return { value: undefined }
  })
  return values
}

type Fetched = { url: string; auth: string | undefined; beta: string | undefined }

function usageApi(on: Parameters<TestBody>[1], status: number, body: unknown) {
  const requests: Fetched[] = []
  on('http.fetch', ($, e) => {
    requests.push({ url: e.url, auth: e.init?.auth, beta: e.init?.headers?.['anthropic-beta'] })
    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body) } }
  })
  return requests
}

async function barSources($: Parameters<TestBody>[0]) {
  const ui = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  const sources = (await ui.findAll({ type: 'Svg' })).map(bar => String(bar.props.source))
  await ui.unmount()
  return sources
}

test('最初の応答を待たずに、使用量 API で 5h / 7d を読む', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 13, 8, 0) })
  const now = clock.now()
  const store = sharedStore(on, {
    windows: { windows: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(now + HOUR).toISOString() }], readAt: now - 3 * HOUR },
  })
  on('session.usage', () => ({ value: { startedAt: now, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.authorize', () => ({ value: { handle: 'credential-handle', kind: 'bearer' } }))
  const requests = usageApi(on, 200, {
    // 使用量 API は小数秒 6 桁・59.9 秒で返す
    five_hour: { utilization: 23.0, resets_at: '2026-10-13T10:59:59.943648+00:00' },
    seven_day: { utilization: 61.0, resets_at: '2026-10-18T02:59:59.943679+00:00' },
    seven_day_opus: null,
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'Box' }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(requests).toEqual([
    { url: 'https://api.anthropic.com/api/oauth/usage', auth: 'credential-handle', beta: 'oauth-2025-04-20' },
  ])
  const [, fiveHour, sevenDay] = await barSources($)
  expect(fiveHour).toContain('>23%<')
  // 灰色（前回の値）ではなく、今の値の色
  expect(fiveHour).toContain('#5DCAA5')
  // 10:59:59.9 を 11:00 に丸めて、8:00 から 3 時間
  expect(fiveHour).toContain('>3h0m<')
  expect(sevenDay).toContain('>61%<')
  expect(sevenDay).toContain('#EF9F27')
  // 次のセッションと別のセッションのために記録する
  expect(store.get('windows')).toMatchObject({ readAt: now, windows: [{ kind: 'five_hour', percentUsed: 23 }, { kind: 'seven_day', percentUsed: 61 }] })
})

test('別のセッションが少し前に読んだ値があれば、API を読まずにそれを出す', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 13, 8, 0) })
  const now = clock.now()
  sharedStore(on, {
    windows: { windows: [{ kind: 'five_hour', percentUsed: 12, resetsAt: new Date(now + HOUR).toISOString() }], readAt: now - 60_000 },
  })
  on('session.usage', () => ({ value: { startedAt: now, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.authorize', () => ({ value: { handle: 'credential-handle', kind: 'bearer' } }))
  const requests = usageApi(on, 200, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'Box' }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(requests).toHaveLength(0)
  const [, fiveHour] = await barSources($)
  expect(fiveHour).toContain('>12%<')
  expect(fiveHour).toContain('#5DCAA5')
})

test('1 分ごとに、別のセッションが記録した新しい値を取り込む', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 13, 8, 0) })
  const now = clock.now()
  const store = sharedStore(on, {
    windows: { windows: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(now + HOUR).toISOString() }], readAt: now - 3 * HOUR },
  })
  on('session.usage', () => ({ value: { startedAt: now, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.authorize', () => ({ value: { handle: 'credential-handle', kind: 'bearer' } }))
  // API は読めない（通信の失敗）。前回の値を灰色のまま残す
  usageApi(on, 503, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'Box' }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect((await barSources($))[1]).not.toContain('#5DCAA5')

  store.set('windows', {
    windows: [{ kind: 'five_hour', percentUsed: 55, resetsAt: new Date(now + HOUR).toISOString() }],
    readAt: now + 30_000,
  })
  await clock.advance(60_000)

  const [, fiveHour] = await barSources($)
  expect(fiveHour).toContain('>55%<')
  expect(fiveHour).toContain('#EF9F27')
})

// API キーと、資格情報の無いセッション（3P プロバイダ・ゲートウェイ）。同じマシンのサブスクリプションのセッションが
// 記録した値を、関係の無い今の値として出さない
for (const [name, authorization] of [
  ['API キー', { handle: 'credential-handle', kind: 'api-key' }],
  ['3P プロバイダ・ゲートウェイ', null],
] as const) {
  test(`${name}のセッションでは、共有の 5h / 7d も API も使わない`, async ($, on) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 9, 13, 8, 0) })
    const now = clock.now()
    const store = sharedStore(on, {
      windows: { windows: [{ kind: 'five_hour', percentUsed: 12, resetsAt: new Date(now + HOUR).toISOString() }], readAt: now - 60_000 },
    })
    on('session.usage', () => ({ value: { startedAt: now, context: { window: 200_000 }, rateLimits: [] } }))
    on('session.authorize', () => ({ value: authorization }))
    const requests = usageApi(on, 200, {})
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('ui.render', () => ({ type: 'Box' }))

    await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
    await clock.settle()
    store.set('windows', {
      windows: [{ kind: 'five_hour', percentUsed: 55, resetsAt: new Date(now + HOUR).toISOString() }],
      readAt: now + 30_000,
    })
    await clock.advance(60_000)

    expect(requests).toHaveLength(0)
    expect((await barSources($))[1]).toContain('>--<')
  })
}

test('バーを押すとリセットの日時を出し、同じバーをもう一度押すと閉じる', async ($, on) => {
  // 日時は手元の時間帯で組む（どの時間帯の CI でも同じ表示になる）
  const clock = mock.clock(on, { now: new Date(2026, 9, 13, 17, 0).getTime() })
  sharedStore(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))
  await $.session.measure({
    context: { tokens: 1_000, window: 200_000, percent: 1 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23, resetsAt: new Date(2026, 9, 13, 18, 30).toISOString() },
      { kind: 'seven_day', percentUsed: 92, resetsAt: new Date(2026, 9, 18, 12, 0).toISOString() },
    ],
    changed: ['context', 'rateLimits'],
  })

  const ui = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  expect(await ui.findAll({ type: 'Client' })).toHaveLength(3)

  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'hit-seven_day' })
  // 押した 7d だけを 1 行で（名前と日時）。使用率とバーは出さない
  expect(await texts(ui)).toEqual(['7 日の利用枠', '10月18日（日）12:00 にリセット'])
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  // 押したバーを縁取りで示す
  const outlined = (await ui.findAll({ type: 'Svg' })).map(bar => String(bar.props.source).includes('fill="none" stroke='))
  expect(outlined).toEqual([false, false, true])

  // 5h を押すと 5h の 1 行（名前と時刻）に切り替わり、縁取りが 5h に移る
  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'hit-five_hour' })
  expect(await texts(ui)).toEqual(['5 時間の利用枠', '今日 18:30 にリセット'])
  expect((await ui.findAll({ type: 'Svg' })).map(bar => String(bar.props.source).includes('fill="none" stroke='))).toEqual([false, true, false])

  // 同じバーをもう一度押すと閉じる
  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'hit-five_hour' })
  expect(await texts(ui)).toEqual([])

  // 閉じるボタンでも閉じる
  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'hit-seven_day' })
  await ui.press({ key: 'close' })
  expect(await texts(ui)).toEqual([])
  await ui.unmount()
})

// findAll の形は描く部品によらない。mount の戻り値の型をそのまま書くと、tsc が帯の型を全部品の型に当てようとして落ちる
async function texts(ui: Pick<Mounted, 'findAll'>) {
  return (await ui.findAll({ type: 'Text' })).map(text => text.text)
}

test('context のバーを押すと、トークン数と内訳を出す', async ($, on) => {
  mock.clock(on)
  sharedStore(on)
  on('session.usage', ($, e) => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 340_000,
        window: 1_000_000,
        percent: 34,
        ...(e.breakdown === undefined
          ? {}
          : {
              breakdown: {
                categories: [
                  { name: 'System tools', tokens: 15_000, color: 'inactive', isDeferred: false, kind: 'used' },
                  { name: 'Messages', tokens: 300_000, color: 'permission', isDeferred: false, kind: 'used' },
                  { name: 'MCP tools', tokens: 0, color: 'inactive', isDeferred: false, kind: 'used' },
                  { name: 'Free space', tokens: 660_000, color: 'inactive', isDeferred: false, kind: 'free' },
                ],
                autoCompactThreshold: 800_000,
              } as never,
            }),
      },
      rateLimits: [],
    },
  }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))
  await $.session.measure({ context: { tokens: 340_000, window: 1_000_000, percent: 34 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'hit-context' })

  // context を押したときだけ、見出し・内訳を色分けしたバー・凡例・自動 compact を出す。使用率は出さない
  expect(await texts(ui)).toEqual([])
  const section = (await ui.findAll({ type: 'Svg' })).find(svg => String(svg.props.alt).startsWith('コンテキスト'))
  expect(String(section?.props.alt).split('\n')).toEqual([
    'コンテキスト 340K / 1M',
    '800K で自動 compact',
    // 使っている分だけを多い順に。0 の行と空きは出さない
    'Messages 300K・System tools 15K',
  ])
  const source = String(section?.props.source)
  expect(source).not.toContain('34%')
  // 自動 compact は見出しの行で、使っている量の左に並べる（右寄せの 1 かたまり）
  expect(source).toContain('<tspan font-size="11">800K で自動 compact</tspan><tspan dx="14">340K / 1M</tspan>')
  // 多い順に 1 色目・2 色目。幅は窓に対する割合
  expect(source).toContain('width="30.000%" height="4" fill="#4C8BF5"')
  expect(source).toContain('x="30.000%" y="22" width="1.500%" height="4" fill="#E8833A"')
  await ui.unmount()
})

test('右クリックでは開かない', async ($, on) => {
  mock.clock(on)
  sharedStore(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))
  await $.session.measure({ context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'right', in: 'hit-context' })
  expect(await texts(ui)).toEqual([])
  await ui.unmount()
})

// session.usage の答え。breakdown を頼まれたときだけ、手元の見積もり（totalTokens）を付ける
function contextUsage(live: { tokens: number; percent: number } | null, estimatedTokens: number) {
  return (e: { breakdown?: string }) => ({
    startedAt: 0,
    context: {
      window: 1_000_000,
      ...(live ?? {}),
      ...(e.breakdown === undefined ? {} : { breakdown: { totalTokens: estimatedTokens } as never }),
    },
    rateLimits: [],
  })
}

async function contextBar($: Parameters<TestBody>[0]) {
  const ui = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  const [bar] = await ui.findAll({ type: 'Svg' })
  await ui.unmount()
  return { source: String(bar?.props.source), alt: String(bar?.props.alt) }
}

test('最初の応答の前は、context を手元の見積もりで灰色に出し、応答が来たら置き換える', async ($, on) => {
  const clock = mock.clock(on)
  sharedStore(on)
  const asked: string[] = []
  const usage = contextUsage(null, 46_844)
  on('session.usage', ($, e) => {
    if (e.breakdown !== undefined) asked.push(e.breakdown)
    return { value: usage(e) }
  })
  on('session.authorize', () => ({ value: null }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await clock.settle()

  // 通信しない summary で数える
  expect(asked).toEqual(['summary'])
  const estimated = await contextBar($)
  expect(estimated.source).toContain('>5%<')
  expect(estimated.source).not.toContain('#5DCAA5')
  expect(estimated.alt).toBe('context 5%（47K / 1M・応答の前の見積もり）')

  // 詳細では使っている量に「約」を付ける
  const ui = await $.ui.mount({ plugin: 'usage-bars', surface: 'desktop', ...BAND })
  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'hit-context' })
  const section = (await ui.findAll({ type: 'Svg' })).find(svg => String(svg.props.alt).startsWith('コンテキスト'))
  expect(String(section?.props.alt)).toBe('コンテキスト 約 47K / 1M')
  await ui.press({ key: 'close' })
  await ui.unmount()

  await $.session.measure({ context: { tokens: 85_968, window: 1_000_000, percent: 9 }, rateLimits: [], changed: ['context'] })
  const live = await contextBar($)
  expect(live.source).toContain('>9%<')
  expect(live.source).toContain('#5DCAA5')
  expect(live.alt).toBe('context 9%（86K / 1M）')
})

test('応答の値が先に届いていれば、遅れて返った見積もりで上書きしない', async ($, on) => {
  const clock = mock.clock(on)
  sharedStore(on)
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const usage = contextUsage(null, 46_844)
  on('session.usage', async ($, e) => {
    if (e.breakdown !== undefined) await gate
    return { value: usage(e) }
  })
  on('session.authorize', () => ({ value: null }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { tokens: 85_968, window: 1_000_000, percent: 9 }, rateLimits: [], changed: ['context'] })
  release()
  await clock.settle()

  const bar = await contextBar($)
  expect(bar.source).toContain('>9%<')
  expect(bar.source).toContain('#5DCAA5')
})

test('compact の直後で応答の値が無くなったら、見積もりに戻す（開いた時点の差は足さない）', async ($, on) => {
  const clock = mock.clock(on)
  // compact の後は MCP もメッセージも数えに入っているので、差を足すと多く出る
  sharedStore(on, { contextGap: 27_340 })
  const usage = contextUsage({ tokens: 300_000, percent: 30 }, 60_000)
  on('session.usage', ($, e) => ({ value: usage(e) }))
  on('session.authorize', () => ({ value: null }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))

  // 応答の値があるうちは数えない
  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect((await contextBar($)).source).toContain('>30%<')

  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })
  await clock.settle()
  const bar = await contextBar($)
  expect(bar.source).toContain('>6%<')
  expect(bar.source).not.toContain('#5DCAA5')
})

test('応答が届くまでは 5 秒ごとに見積もりを数え直し、届いたら数えない', async ($, on) => {
  const clock = mock.clock(on)
  sharedStore(on)
  let estimatedTokens = 58_523
  let asked = 0
  on('session.usage', ($, e) => {
    if (e.breakdown !== undefined) asked += 1
    return { value: contextUsage(null, estimatedTokens)(e) }
  })
  on('session.authorize', () => ({ value: null }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect((await contextBar($)).source).toContain('>6%<')

  // 開始のあとに MCP のツールが繋がった
  estimatedTokens = 80_557
  await clock.advance(5_000)
  const later = await contextBar($)
  expect(later.source).toContain('>8%<')
  expect(later.source).not.toContain('#5DCAA5')

  await $.session.measure({ context: { tokens: 85_859, window: 1_000_000, percent: 9 }, rateLimits: [], changed: ['context'] })
  const before = asked
  await clock.advance(15_000)
  expect(asked).toBe(before)
  expect((await contextBar($)).source).toContain('>9%<')
})

test('最初の応答で、開いた時点の見積もりとの差を共有の記録に残す', async ($, on) => {
  const clock = mock.clock(on)
  const store = sharedStore(on)
  on('session.usage', ($, e) => ({ value: contextUsage(null, 58_523)(e) }))
  on('session.authorize', () => ({ value: null }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await clock.settle()
  // 応答が失敗した（値が無い）回では記録しない
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })
  expect(store.get('contextGap')).toBeUndefined()

  await $.session.measure({ context: { tokens: 85_863, window: 1_000_000, percent: 9 }, rateLimits: [], changed: ['context'] })
  expect(store.get('contextGap')).toBe(27_340)
  // 2 回目の応答では記録し直さない
  await $.session.measure({ context: { tokens: 97_442, window: 1_000_000, percent: 10 }, rateLimits: [], changed: ['context'] })
  expect(store.get('contextGap')).toBe(27_340)
})

test('前のセッションの差を、開いた時点の見積もりに足す', async ($, on) => {
  const clock = mock.clock(on)
  sharedStore(on, { contextGap: 27_340 })
  let estimatedTokens = 58_523
  on('session.usage', ($, e) => ({ value: contextUsage(null, estimatedTokens)(e) }))
  on('session.authorize', () => ({ value: null }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Box' }))

  await $.session.start({ cwd: 'C:/work', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const atStart = await contextBar($)
  expect(atStart.source).toContain('>9%<')
  expect(atStart.source).not.toContain('#5DCAA5')
  expect(atStart.alt).toBe('context 9%（86K / 1M・応答の前の見積もり）')

  // MCP のツールが繋がって数えた値が増えても、差を二重に足さない
  estimatedTokens = 79_367
  await clock.advance(5_000)
  expect((await contextBar($)).source).toContain('>9%<')

  // 最初のターンで差より増えたら、数えた値を出す
  estimatedTokens = 120_000
  await clock.advance(5_000)
  expect((await contextBar($)).source).toContain('>12%<')
})
