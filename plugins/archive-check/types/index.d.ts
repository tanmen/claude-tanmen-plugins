// Busy（作） = 畳むと作業を失う（blocked） / Check（注） = 畳んでよいが確認を忘れずに（caution） / Done（済） = どれも無い（ok）
export type Verdict = 'ok' | 'caution' | 'blocked'

export type ReasonKind =
  | 'dirty'
  | 'unpushed'
  | 'card'
  | 'task'
  | 'followup'
  | 'artifact'
  | 'ci'
  | 'ask'
  | 'plan'
  | 'pr'
  | 'unread'

// 枠のボタンで Claude に頼むこと。押すと prompt をこのセッションに送る
export type ReasonAction = {
  label: string
  prompt: string
}

export type Reason = {
  level: 'blocked' | 'caution'
  kind: ReasonKind
  text: string
  // 補足（後続の確かめ方など）。枠で薄い字にする
  note?: string
  // 後続なら、その id（枠の「済みにする」「予定に移す」が使う）
  followupId?: string
  // このセッションで公開した Artifact の行なら、その id（枠の「残す」と、片付けを頼んだあとに行を外すのに使う）
  artifactIds?: string[]
  // 枠のボタン（Claude に頼む）
  actions?: ReasonAction[]
  // 枠のリンク（PR など）
  href?: string
}

// 時間が経たないと分からない確認。Claude が mcp__archive-check__followup で書き出す
export type FollowUp = {
  id: string
  what: string
  when: string
  how: string
  // 決まっていれば ISO 8601（時差付き）
  dueAt?: string
  createdAt: number
}

// この CLI のプロセスで起きた背景タスク（Bash / PowerShell の背景実行・Monitor）
export type BackgroundTask = {
  id: string
  kind: 'shell' | 'monitor'
  label: string
  startedAt: number
}

export type Report = {
  verdict: Verdict
  reasons: Reason[]
  checkedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    // ended: 知らせ（prompt.submit）で終わりが分かった背景タスクの id
    'archive-check': { report: Report | null; tasks: BackgroundTask[]; ended: string[] }
  }
}
