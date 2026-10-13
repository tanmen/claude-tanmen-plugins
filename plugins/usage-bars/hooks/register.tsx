import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Detail, DetailKind, UsageSnapshot, UsageWindow } from '../types'

const snapshot = atom({ plugin: 'usage-bars', key: 'snapshot' } as const, null)
// 押して開いたバーの詳細。閉じていれば null
const detail = atom({ plugin: 'usage-bars', key: 'detail' } as const, null)

// 5h / 7d の最後の値。マシンの中の全セッションで共有し、開いた直後の表示と、別のセッションへの受け渡しに使う
const STORED_WINDOWS = 'windows'
// 使用量 API を読みに行った時刻。全セッションが同じ時に読みに行かないよう、先に書いておく
const FETCH_CLAIM = 'fetchClaim'

// /usage が読むのと同じ口。応答を待たずに 5h / 7d が読める
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// 手元の値がこれより古ければ使用量 API を読み直す。詳細を開いたときはもっと短く
const REFRESH_MS = 5 * 60_000
const DETAIL_REFRESH_MS = 60_000
const CLAIM_MS = 60_000
// 帯がこの間描かれていなければ、見られていないとみて API は読みに行かない（別のセッションの値は取り込む）
const VISIBLE_MS = 2 * 60_000

const WINDOWS = [
  { kind: 'five_hour', label: '5h', title: '5 時間の利用枠' },
  { kind: 'seven_day', label: '7d', title: '7 日の利用枠' },
] as const

const DETAIL_KINDS: readonly DetailKind[] = ['context', 'five_hour', 'seven_day']

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

// context の詳細の色。Desktop 自身の使用量の popup（ダークテーマ）に合わせた
const DETAIL_COLORS = { text: '#E8E6DC', muted: '#9C9A92', track: '#3A3A37' } as const
// context の内訳の区切り。多い順に割り当てる
const SEGMENT_COLORS = ['#4C8BF5', '#E8833A', '#3FB27F', '#B07CF0', '#E05A9B', '#8A8A85']

// SVG は画像として描かれ、アプリのテーマに追従しない。Desktop のダークテーマに合わせた色
const TRACK = '#2C2C2A'
const LABEL = '#B4B2A9'
const MUTED = '#888780'
const TONES = {
  low: { fill: '#1D9E75', text: '#5DCAA5' },
  mid: { fill: '#BA7517', text: '#EF9F27' },
  high: { fill: '#E24B4A', text: '#F09595' },
  none: { fill: MUTED, text: MUTED },
} as const
const FONT = "'Segoe UI', 'Yu Gothic UI', 'Hiragino Sans', system-ui, sans-serif"
// 帯の上下の余白（11px / 10px）は Desktop の枠のもので、mod からは変えられない（負の margin は
// 検査を通るが Desktop では無視された）。縦幅はバーの高さで決まる。
// compact（既定）はバー 19px で帯が 40px になり、Desktop 自身の「週間使用量の上限」の枠と同じ高さになる
type Size = { height: number; fontSize: number; detailFontSize: number; baseline: number; detailDx: number }

const SIZES: Record<'compact' | 'regular', Size> = {
  compact: { height: 19, fontSize: 11, detailFontSize: 11, baseline: 13, detailDx: 44 },
  regular: { height: 26, fontSize: 12, detailFontSize: 11, baseline: 17, detailDx: 48 },
}

type Meter = {
  kind: DetailKind
  label: string
  percent: number | null
  // バーの右寄りに小さく出す補足（残り時間）。無ければ空
  detail: string
  // 読み上げ用の全文。削った情報（トークン数・リセット時刻）はここに残す
  alt: string
  isCarriedOver: boolean
}

type StoredWindows = { windows: UsageWindow[]; readAt: number }

function toWindows(limits: SessionRateLimit[]): UsageWindow[] {
  return limits.map(({ kind, percentUsed, resetsAt }) =>
    resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt },
  )
}

function isStoredWindows(value: unknown): value is StoredWindows {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<StoredWindows>
  return Array.isArray(v.windows) && typeof v.readAt === 'number'
}

// hit.ts が知らせてきた、押されたバー
function detailKindOf(data: unknown): DetailKind | null {
  if (typeof data !== 'object' || data === null) return null
  const kind = (data as { kind?: unknown }).kind
  return DETAIL_KINDS.find(k => k === kind) ?? null
}

// 使用量 API の応答から 5h / 7d を取り出す。utilization は 0〜100 の使用率、resets_at は ISO 8601
// （小数秒が 6 桁で来るので 3 桁に詰めてから読む）。形が違えば undefined
function parseUsage(text: string): UsageWindow[] | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null) return undefined

  const windows: UsageWindow[] = []
  for (const { kind } of WINDOWS) {
    const value = (body as Record<string, unknown>)[kind]
    if (typeof value !== 'object' || value === null) continue
    const { utilization, resets_at: resetsAt } = value as { utilization?: unknown; resets_at?: unknown }
    if (typeof utilization !== 'number') continue
    const percentUsed = Math.round(utilization * 10) / 10
    const at = typeof resetsAt === 'string' ? Date.parse(resetsAt.replace(/(\.\d{3})\d+/, '$1')) : NaN
    windows.push(Number.isNaN(at) ? { kind, percentUsed } : { kind, percentUsed, resetsAt: new Date(at).toISOString() })
  }
  return windows.length > 0 ? windows : undefined
}

// 読めなければ undefined（今の値を残す）。資格情報は host が持ったままで、mod には渡らない
async function fetchWindows($: EngineInterface): Promise<UsageWindow[] | undefined> {
  try {
    const auth = await $.session.authorize()
    if (auth === null || auth.kind !== 'bearer') return undefined
    const response = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    })
    return response.ok ? parseUsage(response.text) : undefined
  } catch {
    return undefined
  }
}

// 今の値より新しい読みだけを取り込む
async function adopt($: EngineInterface, reading: StoredWindows): Promise<void> {
  await update($, snapshot, prev => {
    if (prev === null || (prev.windowsReadAt !== null && prev.windowsReadAt >= reading.readAt)) return prev
    return { ...prev, windows: reading.windows, windowsReadAt: reading.readAt, isCarriedOver: false }
  })
}

function roundToMinute(ms: number): number {
  return Math.round(ms / 60_000) * 60_000
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return `${n}`
}

function formatRemaining(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

function hhmm(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function formatClock(at: Date, now: Date): string {
  if (at.toDateString() === now.toDateString()) return hhmm(at)
  return `${at.getMonth() + 1}/${at.getDate()} ${hhmm(at)}`
}

// 詳細に出すリセットの日時。今日なら「今日 20:30」、それ以外は「10月18日（日）12:00」
function formatResetAt(at: Date, now: Date): string {
  if (at.toDateString() === now.toDateString()) return `今日 ${hhmm(at)}`
  return `${at.getMonth() + 1}月${at.getDate()}日（${WEEKDAYS[at.getDay()]}）${hhmm(at)}`
}

function percentText(percent: number | null): string {
  return percent === null ? '--' : `${Math.round(percent)}%`
}

function contextMeter(snap: UsageSnapshot): Meter {
  const used = snap.contextTokens === null ? '--' : formatTokens(snap.contextTokens)
  return {
    kind: 'context',
    label: 'context',
    percent: snap.contextPercent,
    detail: '',
    alt: `context ${percentText(snap.contextPercent)}（${used} / ${formatTokens(snap.contextWindow)}）`,
    isCarriedOver: false,
  }
}

function windowMeter(snap: UsageSnapshot, kind: (typeof WINDOWS)[number]['kind'], label: string, now: number): Meter {
  const win = snap.windows.find(w => w.kind === kind)
  if (win === undefined) {
    return { kind, label, percent: null, detail: '', alt: `${label} まだ値がない`, isCarriedOver: false }
  }

  const isCarriedOver = snap.isCarriedOver
  const suffix = isCarriedOver ? '・前回のセッションの値' : ''
  if (win.resetsAt === undefined) {
    return { kind, label, percent: win.percentUsed, detail: '', alt: `${label} ${percentText(win.percentUsed)}${suffix}`, isCarriedOver }
  }

  // 使用量 API は 04:59:59.9 のような時刻で返すので、分に丸める
  const resetsAt = roundToMinute(Date.parse(win.resetsAt))
  // 持ち越した値の窓がもう切り替わっていれば、使用率は 0 から数え直しになっている
  if (resetsAt <= now) {
    return { kind, label, percent: 0, detail: '', alt: `${label} 0%（リセット済み）`, isCarriedOver }
  }

  const remaining = formatRemaining(resetsAt - now)
  const clock = formatClock(new Date(resetsAt), new Date(now))
  return {
    kind,
    label,
    percent: win.percentUsed,
    detail: remaining,
    alt: `${label} ${percentText(win.percentUsed)}（あと ${remaining}・${clock} にリセット${suffix}）`,
    isCarriedOver,
  }
}

// 詳細の 5h / 7d の 1 行（使用率の後ろに続ける部分）。リセットの日時と、前回のセッションの値ならその旨
function windowLine(snap: UsageSnapshot, kind: (typeof WINDOWS)[number]['kind'], now: number): string {
  const win = snap.windows.find(w => w.kind === kind)
  if (win === undefined) return 'まだ値がない'
  const suffix = snap.isCarriedOver ? '（前回のセッションの値）' : ''
  if (win.resetsAt === undefined) return suffix
  const at = roundToMinute(Date.parse(win.resetsAt))
  if (at <= now) return `リセット済み${suffix}`
  return `${formatResetAt(new Date(at), new Date(now))} にリセット${suffix}`
}

// 詳細の context。見出しの行に自動 compact の閾値と使っている量、/context と同じ分け方の内訳（手元での見積もり。通信しない）を色分けした細いバー、
// 多い順に 4 つの凡例。使用率は下のバーと重なるので出さない。幅は % で書き、帯の幅に合わせて伸び縮みさせる
function contextSvg(open: Detail, snap: UsageSnapshot): { source: string; alt: string } {
  const parts: string[] = []
  const alt: string[] = []
  const used = snap.contextTokens === null ? '--' : formatTokens(snap.contextTokens)
  const summary = `${used} / ${formatTokens(snap.contextWindow)}`
  // 右寄せの 1 かたまりで、自動 compact を使っている量の左に置く
  const compact = open.autoCompactAt === null ? null : `${formatTokens(open.autoCompactAt)} で自動 compact`
  const compactSpan = compact === null ? '' : `<tspan font-size="11">${escapeXml(compact)}</tspan><tspan dx="14">`
  parts.push(`<text x="0" y="14" font-size="13" font-weight="600" fill="${DETAIL_COLORS.text}">コンテキスト</text>`)
  parts.push(
    `<text x="100%" y="14" font-size="12" fill="${DETAIL_COLORS.muted}" text-anchor="end">${compactSpan}${escapeXml(summary)}${compact === null ? '' : '</tspan>'}</text>`,
  )
  alt.push(`コンテキスト ${summary}`)
  if (compact !== null) alt.push(compact)

  parts.push(`<rect y="22" width="100%" height="4" rx="2" fill="${DETAIL_COLORS.track}"/>`)
  const categories = open.categories ?? []
  if (categories.length > 0 && snap.contextWindow > 0) {
    let x = 0
    categories.forEach((c, i) => {
      const width = Math.min(100 - x, (c.tokens / snap.contextWindow) * 100)
      if (width <= 0) return
      const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length]
      parts.push(`<rect x="${x.toFixed(3)}%" y="22" width="${width.toFixed(3)}%" height="4" fill="${color}"/>`)
      x += width
    })
  } else if (snap.contextPercent !== null) {
    const fill = toneOf(contextMeter(snap)).fill
    parts.push(`<rect y="22" width="${Math.min(100, snap.contextPercent)}%" height="4" rx="2" fill="${fill}"/>`)
  }

  const lines: string[] = []
  if (open.categories === null) {
    lines.push(`<tspan fill="${DETAIL_COLORS.muted}">内訳を数えている…</tspan>`)
  } else if (categories.length > 0) {
    // 色はバーの区切りと同じ
    lines.push(
      categories
        .slice(0, 4)
        .map((c, i) => `<tspan fill="${SEGMENT_COLORS[i]}">●</tspan><tspan fill="${DETAIL_COLORS.muted}"> ${escapeXml(`${c.name} ${formatTokens(c.tokens)}`)}  </tspan>`)
        .join(''),
    )
    alt.push(categories.map(c => `${c.name} ${formatTokens(c.tokens)}`).join('・'))
  }
  lines.forEach((line, i) => parts.push(`<text x="0" y="${42 + i * 16}" font-size="11">${line}</text>`))

  const height = lines.length === 0 ? 30 : 42 + (lines.length - 1) * 16 + 6
  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${height}" font-family="${FONT}">`,
    ...parts,
    `</svg>`,
  ].join('')
  return { source, alt: alt.join('\n') }
}

function toneOf(meter: Meter) {
  // 前のセッションから持ち越した値は今の値と見分けられるよう、色を落とす
  if (meter.percent === null || meter.isCarriedOver) return TONES.none
  // 表示する数字（四捨五入）で判定する。79.6 を「80%」と出しながら黄にしない
  const shown = Math.round(meter.percent)
  if (shown >= 80) return TONES.high
  if (shown >= 50) return TONES.mid
  return TONES.low
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

type TextColors = { label: string; detail: string; percent: string }

function textLayer(meter: Meter, size: Size, colors: TextColors, attributes = ''): string {
  const detail = meter.detail
    ? `<text x="100%" dx="-${size.detailDx}" y="${size.baseline}" font-size="${size.detailFontSize}" fill="${colors.detail}" text-anchor="end">${escapeXml(meter.detail)}</text>`
    : ''
  return [
    `<g font-family="${FONT}" font-size="${size.fontSize}"${attributes}>`,
    `<text x="10" y="${size.baseline}" fill="${colors.label}">${escapeXml(meter.label)}</text>`,
    detail,
    `<text x="100%" dx="-10" y="${size.baseline}" font-weight="600" fill="${colors.percent}" text-anchor="end">${percentText(meter.percent)}</text>`,
    `</g>`,
  ].join('')
}

// 薄い色の塗り＋到達点に 2px の縦線。幅はすべて % で書き、枠の幅に合わせて伸び縮みさせる。
// 詳細を開いているバーは縁取りで示す
function meterSvg(meter: Meter, size: Size, isSelected: boolean): string {
  const tone = toneOf(meter)
  const width = meter.percent === null ? 0 : Math.min(100, Math.max(0, Math.round(meter.percent)))
  const h = size.height
  // 縦線が文字を横切らないよう、文字の形（太らせたもの）だけ線をくり抜く
  const knockout = textLayer(
    meter,
    size,
    { label: 'black', detail: 'black', percent: 'black' },
    ' stroke="black" stroke-width="5" stroke-linejoin="round"',
  )
  const edge =
    width > 0
      ? `<g mask="url(#k)"><rect x="${width}%" width="2" height="${h}" transform="translate(-2 0)" fill="${tone.text}"/></g>`
      : ''
  const outline = isSelected
    ? `<rect width="100%" height="${h}" rx="6" fill="none" stroke="${LABEL}" stroke-width="2" clip-path="url(#r)"/>`
    : ''

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${h}">`,
    `<defs><clipPath id="r"><rect width="100%" height="${h}" rx="6"/></clipPath>`,
    `<mask id="k" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="${h}">`,
    `<rect width="100%" height="${h}" fill="white"/>${knockout}</mask></defs>`,
    `<rect width="100%" height="${h}" rx="6" fill="${TRACK}"/>`,
    `<g clip-path="url(#r)"><rect width="${width}%" height="${h}" fill="${tone.fill}" fill-opacity="0.25"/>${edge}</g>`,
    outline,
    textLayer(meter, size, { label: LABEL, detail: MUTED, percent: tone.text }),
    `</svg>`,
  ].join('')
}

// サブスクリプションの資格情報が無いセッション（API キー・3P プロバイダ・ゲートウェイ）。5h / 7d は無いので、
// 共有の値も出さず、使用量 API も読まない
let isPlanless = false
let lastDrawnAt = 0

// 別のセッションが記録した新しい値を取り込み、それでも古ければ使用量 API を読む（maxAgeMs が null なら読まない）
async function refreshWindows($: EngineInterface, maxAgeMs: number | null): Promise<void> {
  if (isPlanless) return
  const stored = await $.store.get(STORED_WINDOWS)
  if (isStoredWindows(stored)) await adopt($, stored)
  if (maxAgeMs === null) return

  const snap = await read($, snapshot)
  const now = await $.clock.now()
  if (snap === null) return
  if (!snap.isCarriedOver && snap.windowsReadAt !== null && now - snap.windowsReadAt < maxAgeMs) return
  const claim = await $.store.get(FETCH_CLAIM)
  if (typeof claim === 'number' && now - claim < CLAIM_MS) return
  await $.store.set(FETCH_CLAIM, now)

  const windows = await fetchWindows($)
  if (windows === undefined) return
  const readAt = await $.clock.now()
  const value: StoredWindows = { windows, readAt }
  await $.store.set(STORED_WINDOWS, value)
  await adopt($, value)
}

// 1 分ごと: 別のセッションの値の取り込み・帯が見られていて古ければ読み直し・「あと何分」の描き直し
async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await refreshWindows($, now - lastDrawnAt < VISIBLE_MS ? REFRESH_MS : null).catch(() => undefined)
  $.ui.invalidate('ui.render')
}

async function countContext($: EngineInterface): Promise<void> {
  const breakdown = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
  const categories = (breakdown?.categories ?? [])
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map(({ name, tokens }) => ({ name, tokens }))
  await update($, detail, prev =>
    prev?.kind === 'context' ? { ...prev, categories, autoCompactAt: breakdown?.autoCompactThreshold ?? null } : prev,
  )
}

export const register: Register = (on, options) => {
  const size = options.size === 'regular' ? SIZES.regular : SIZES.compact

  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    const now = await $.clock.now()
    isPlanless = (await $.session.authorize().catch(() => null))?.kind !== 'bearer'
    const live = toWindows(usage.rateLimits)
    const stored = live.length > 0 || isPlanless ? undefined : await $.store.get(STORED_WINDOWS)
    const carried = isStoredWindows(stored) ? stored : undefined

    await update($, snapshot, () => ({
      contextPercent: usage.context.percent ?? null,
      contextTokens: usage.context.tokens ?? null,
      contextWindow: usage.context.window,
      windows: carried?.windows ?? live,
      windowsReadAt: carried?.readAt ?? (live.length > 0 ? now : null),
      // 別のセッションが少し前に読んだ値なら、今の値として出す
      isCarriedOver: carried !== undefined && now - carried.readAt >= REFRESH_MS,
    }))

    // 最初の応答を待たずに、使用量 API で 5h / 7d を読む
    void refreshWindows($, REFRESH_MS).catch(() => undefined)

    $.clock.every(60_000, () => void tick($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const live = toWindows(e.rateLimits)
    // 応答が来たのに 5h / 7d が空なら、この認証には利用枠が無い（API キーなど）。持ち越した値はもう出さない
    const hasNoWindows = live.length === 0 && e.context.tokens !== undefined

    await update($, snapshot, prev => {
      const kept = prev !== null && !(hasNoWindows && prev.isCarriedOver) ? prev : null
      return {
        contextPercent: e.context.percent ?? null,
        contextTokens: e.context.tokens ?? null,
        contextWindow: e.context.window,
        windows: live.length > 0 ? live : (kept?.windows ?? []),
        windowsReadAt: live.length > 0 ? now : (kept?.windowsReadAt ?? null),
        isCarriedOver: live.length > 0 ? false : (kept?.isCarriedOver ?? false),
      }
    })

    if (live.length > 0) {
      const value: StoredWindows = { windows: live, readAt: now }
      await $.store.set(STORED_WINDOWS, value)
    }

    // 開いている context の内訳を数え直す
    if ((await read($, detail))?.kind === 'context') void countContext($).catch(() => undefined)

    return next(e)
  })

  // バーに重ねた hit.ts が、押されたバーを知らせてくる。開いているバーをもう一度押すと閉じ、別のバーなら切り替える
  on('ui.message', async ($, e, next) => {
    const kind = detailKindOf(e.data)
    if (kind === null) return next(e)

    const isOpen = (await read($, detail))?.kind === kind
    await update($, detail, () => (isOpen ? null : { kind, categories: null, autoCompactAt: null }))
    if (!isOpen && kind === 'context') void countContext($).catch(() => undefined)
    if (!isOpen && kind !== 'context') void refreshWindows($, DETAIL_REFRESH_MS).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // ターミナルには statusLine があるので、帯は Desktop だけに出す
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)

    const snap = await read($, snapshot)
    if (snap === null) return next(e)

    const open = await read($, detail)
    const now = await $.clock.now()
    lastDrawnAt = now
    const { Box, Button, Client, Svg, Text } = $.ui.resolve(e)
    const meters = [
      contextMeter(snap),
      ...WINDOWS.map(w => windowMeter(snap, w.kind, w.label, now)),
    ]

    const bars = (
      <Box flexDirection="row" gap={2}>
        {meters.map(meter => (
          <Box flexDirection="column" flexGrow={1} flexShrink={1} width="30%">
            <Svg source={meterSvg(meter, size, open?.kind === meter.kind)} alt={meter.alt} />
            <Box position="absolute" top={0} left={0} right={0} bottom={0}>
              <Client key={`hit-${meter.kind}`} module="./hit.ts" props={{ kind: meter.kind }} width="100%" height="100%" />
            </Box>
          </Box>
        ))}
      </Box>
    )
    if (open === null) return bars

    const close = <Button key="close" label="閉じる" role="dismiss" onPress={() => update($, detail, () => null)} />
    // 押したバーの分だけを出す。context は見出し・内訳のバー・凡例、5h / 7d は名前とリセットの日時の 1 行。
    // 使用率は下のバーと重なるので出さない
    const window = WINDOWS.find(w => w.kind === open.kind)
    let panel
    if (window !== undefined) {
      panel = (
        <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text bold>{window.title}</Text>
            <Text dimColor>{windowLine(snap, window.kind, now)}</Text>
          </Box>
          {close}
        </Box>
      )
    } else {
      const section = contextSvg(open, snap)
      panel = (
        <Box flexDirection="row" gap={2} alignItems="flex-start" paddingX={1}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Svg source={section.source} alt={section.alt} />
          </Box>
          {close}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {panel}
        {bars}
      </Box>
    )
  })
}
