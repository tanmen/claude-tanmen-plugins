import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit } from 'claude-code'

import type { UsageSnapshot, UsageWindow } from '../types'

const snapshot = atom({ plugin: 'usage-bars', key: 'snapshot' } as const, null)

// 5h / 7d は最初の応答が来るまで空なので、前のセッションの最後の値を残しておいて仮に出す
const STORED_WINDOWS = 'windows'

const WINDOWS = [
  { kind: 'five_hour', label: '5h' },
  { kind: 'seven_day', label: '7d' },
] as const

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
const HEIGHT = 26

type Meter = {
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

function formatClock(at: Date, now: Date): string {
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  if (at.toDateString() === now.toDateString()) return `${hh}:${mm}`
  return `${at.getMonth() + 1}/${at.getDate()} ${hh}:${mm}`
}

function percentText(percent: number | null): string {
  return percent === null ? '--' : `${Math.round(percent)}%`
}

function contextMeter(snap: UsageSnapshot): Meter {
  const used = snap.contextTokens === null ? '--' : formatTokens(snap.contextTokens)
  return {
    label: 'context',
    percent: snap.contextPercent,
    detail: '',
    alt: `context ${percentText(snap.contextPercent)}（${used} / ${formatTokens(snap.contextWindow)}）`,
    isCarriedOver: false,
  }
}

function windowMeter(snap: UsageSnapshot, kind: string, label: string, now: number): Meter {
  const win = snap.windows.find(w => w.kind === kind)
  if (win === undefined) {
    return { label, percent: null, detail: '', alt: `${label} まだ値がない`, isCarriedOver: false }
  }

  const isCarriedOver = snap.isCarriedOver
  const suffix = isCarriedOver ? '・前回のセッションの値' : ''
  if (win.resetsAt === undefined) {
    return { label, percent: win.percentUsed, detail: '', alt: `${label} ${percentText(win.percentUsed)}${suffix}`, isCarriedOver }
  }

  const resetsAt = Date.parse(win.resetsAt)
  // 持ち越した値の窓がもう切り替わっていれば、使用率は 0 から数え直しになっている
  if (resetsAt <= now) {
    return { label, percent: 0, detail: '', alt: `${label} 0%（リセット済み）`, isCarriedOver }
  }

  const remaining = formatRemaining(resetsAt - now)
  const clock = formatClock(new Date(resetsAt), new Date(now))
  return {
    label,
    percent: win.percentUsed,
    detail: remaining,
    alt: `${label} ${percentText(win.percentUsed)}（あと ${remaining}・${clock} にリセット${suffix}）`,
    isCarriedOver,
  }
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

function textLayer(meter: Meter, colors: TextColors, attributes = ''): string {
  const detail = meter.detail
    ? `<text x="100%" dx="-48" y="17" font-size="11" fill="${colors.detail}" text-anchor="end">${escapeXml(meter.detail)}</text>`
    : ''
  return [
    `<g font-family="${FONT}" font-size="12"${attributes}>`,
    `<text x="10" y="17" fill="${colors.label}">${escapeXml(meter.label)}</text>`,
    detail,
    `<text x="100%" dx="-10" y="17" font-weight="600" fill="${colors.percent}" text-anchor="end">${percentText(meter.percent)}</text>`,
    `</g>`,
  ].join('')
}

// 薄い色の塗り＋到達点に 2px の縦線。幅はすべて % で書き、枠の幅に合わせて伸び縮みさせる
function meterSvg(meter: Meter): string {
  const tone = toneOf(meter)
  const width = meter.percent === null ? 0 : Math.min(100, Math.max(0, Math.round(meter.percent)))
  // 縦線が文字を横切らないよう、文字の形（太らせたもの）だけ線をくり抜く
  const knockout = textLayer(
    meter,
    { label: 'black', detail: 'black', percent: 'black' },
    ' stroke="black" stroke-width="5" stroke-linejoin="round"',
  )
  const edge =
    width > 0
      ? `<g mask="url(#k)"><rect x="${width}%" width="2" height="${HEIGHT}" transform="translate(-2 0)" fill="${tone.text}"/></g>`
      : ''

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${HEIGHT}">`,
    `<defs><clipPath id="r"><rect width="100%" height="${HEIGHT}" rx="6"/></clipPath>`,
    `<mask id="k" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="${HEIGHT}">`,
    `<rect width="100%" height="${HEIGHT}" fill="white"/>${knockout}</mask></defs>`,
    `<rect width="100%" height="${HEIGHT}" rx="6" fill="${TRACK}"/>`,
    `<g clip-path="url(#r)"><rect width="${width}%" height="${HEIGHT}" fill="${tone.fill}" fill-opacity="0.25"/>${edge}</g>`,
    textLayer(meter, { label: LABEL, detail: MUTED, percent: tone.text }),
    `</svg>`,
  ].join('')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    const now = await $.clock.now()
    const live = toWindows(usage.rateLimits)
    const stored = live.length > 0 ? undefined : await $.store.get(STORED_WINDOWS)
    const carried = isStoredWindows(stored) ? stored : undefined

    await update($, snapshot, () => ({
      contextPercent: usage.context.percent ?? null,
      contextTokens: usage.context.tokens ?? null,
      contextWindow: usage.context.window,
      windows: carried?.windows ?? live,
      windowsReadAt: carried?.readAt ?? (live.length > 0 ? now : null),
      isCarriedOver: carried !== undefined,
    }))

    // 「あと何分」を進めるための再描画。値そのものは session.measure が運ぶ
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))

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

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // ターミナルには statusLine があるので、帯は Desktop だけに出す
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)

    const snap = await read($, snapshot)
    if (snap === null) return next(e)

    const now = await $.clock.now()
    const { Box, Svg } = $.ui.resolve(e)
    const meters = [
      contextMeter(snap),
      ...WINDOWS.map(w => windowMeter(snap, w.kind, w.label, now)),
    ]

    return (
      <Box flexDirection="row" gap={2}>
        {meters.map(meter => (
          <Box flexDirection="column" flexGrow={1} flexShrink={1} width="30%">
            <Svg source={meterSvg(meter)} alt={meter.alt} />
          </Box>
        ))}
      </Box>
    )
  })
}
