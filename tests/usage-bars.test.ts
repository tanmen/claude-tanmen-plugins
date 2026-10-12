import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

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
