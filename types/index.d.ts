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
  // windows を読んだ時刻（ms）。前のセッションから持ち越した値なら isCarriedOver
  windowsReadAt: number | null
  isCarriedOver: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': { snapshot: UsageSnapshot | null }
  }
}
