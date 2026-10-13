export type UsageWindow = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type UsageSnapshot = {
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number
  windows: UsageWindow[]
  // windows を読んだ時刻（ms）。このセッションの応答・使用量 API・別のセッションの記録のうち一番新しいもの。
  // 前のセッションから持ち越して、まだ読み直せていない値なら isCarriedOver
  windowsReadAt: number | null
  isCarriedOver: boolean
}

export type DetailKind = 'context' | 'five_hour' | 'seven_day'

export type ContextCategoryRow = { name: string; tokens: number }

// 押して開いたバーの詳細
export type Detail = {
  kind: DetailKind
  // context の内訳（/context と同じ分け方の、手元での見積もり）。数え終わるまでは null
  categories: ContextCategoryRow[] | null
  autoCompactAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': { snapshot: UsageSnapshot | null; detail: Detail | null }
  }
}
