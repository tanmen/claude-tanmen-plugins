// 画面の文言・ボタンが Claude に送る依頼・Claude への既定の指示。設定 language で英語（既定）と日本語を切り替える
import type { Verdict } from '../types'

export type Lang = 'en' | 'ja'

export type Messages = {
  // 帯の札の文字と幅（px）、枠の見出し、帯の alt
  badge: Record<Verdict, string>
  badgeWidth: number
  verdict: Record<Verdict, string>
  alt: Record<Verdict, string>
  // 枠
  paneTitle: string
  checking: string
  nothingLeft: string
  sectionBlocked: string
  sectionCaution: string
  tagFollowup: string
  tagAsk: string
  open: string
  markDone: string
  // 理由
  unread: (what: string) => string
  unreadWhat: {
    record: string
    git: string
    dirty: string
    unpushed: string
    mergedPrs: string
    prState: string
    messages: string
    agents: string
    guide: string
    evaluate: string
  }
  dirty: (n: number) => string
  unpushed: (n: number) => string
  card: (title: string) => string
  openPr: (pr: string) => string
  ciPending: (pr: string) => string
  backgroundTask: (label: string) => string
  agent: (label: string) => string
  planLeft: (n: number, next: string | null) => string
  askQuestion: string
  askOffer: (title: string) => string
  followup: (what: string, when: string) => string
  // ボタンと、押すと Claude に送る依頼
  launchLabel: string
  launchPrompt: (title: string, id: string) => string
  commitLabel: string
  commitPrompt: string
  pushLabel: string
  pushPrompt: string
  scheduleLabel: string
  schedulePrompt: (f: { id: string; what: string; when: string; how: string; dueAt?: string }, tool: string) => string
  appActions: Record<string, { label: string; prompt: string }>
  // 知らせ
  asked: (label: string) => string
  notSent: (label: string, detail?: string) => string
  paneNotPlaced: (reason: string) => string
  // Claude へ
  toolDescription: string
  toolFields: { what: string; when: string; how: string; dueAt: string; id: string }
  guide: (tool: string) => string
}

const en: Messages = {
  badge: { ok: 'Done', caution: 'Check', blocked: 'Busy' },
  badgeWidth: 46,
  verdict: { ok: 'Done', caution: 'Check first', blocked: 'Busy' },
  alt: {
    ok: 'Done (safe to archive)',
    caution: 'Check first (look before archiving)',
    blocked: 'Busy (archiving loses work)',
  },
  paneTitle: 'Archive',
  checking: 'Checking…',
  nothingLeft: 'Nothing left',
  sectionBlocked: 'Lost if you archive',
  sectionCaution: 'Check before archiving',
  tagFollowup: 'Follow-up',
  tagAsk: 'Waiting on you',
  open: 'Open',
  markDone: 'Mark done',
  unread: what => `Couldn't read: ${what}`,
  unreadWhat: {
    record: 'Desktop session record',
    git: 'git',
    dirty: 'uncommitted changes',
    unpushed: 'commits not on a remote',
    mergedPrs: 'merged PRs',
    prState: 'PR state',
    messages: 'conversation',
    agents: 'agents',
    guide: 'guide file',
    evaluate: 'what the check needs',
  },
  dirty: n => `${n} uncommitted ${n === 1 ? 'change' : 'changes'}`,
  unpushed: n => `${n} ${n === 1 ? 'commit' : 'commits'} not on a remote`,
  card: title => `Unstarted suggested task “${title}”`,
  openPr: pr => `Open PR ${pr}`,
  ciPending: pr => `CI not finished on PR ${pr}`,
  backgroundTask: label => `Running background task “${label}”`,
  agent: label => `Running agent “${label}”`,
  planLeft: (n, next) => `${n} task list ${n === 1 ? 'step' : 'steps'} left${next ? ` (next: ${next})` : ''}`,
  askQuestion: 'A question to answer',
  askOffer: title => `New session or here: “${title}”`,
  followup: (what, when) => (when ? `${what} (${when})` : what),
  launchLabel: 'Ask to start',
  launchPrompt: (title, id) => `Start the suggested task “${title}”${id ? ` (${id})` : ''} (from the archive-check pane).`,
  commitLabel: 'Ask to commit',
  commitPrompt: "Commit this session's uncommitted changes (from the archive-check pane).",
  pushLabel: 'Ask to push',
  pushPrompt: 'Push the commits that are not on a remote (from the archive-check pane).',
  scheduleLabel: 'Schedule',
  schedulePrompt: (f, tool) =>
    [
      `Turn the follow-up “${f.what}” into a scheduled task (from the archive-check pane).`,
      `- When: ${f.when || '(not given)'}${f.dueAt ? ` (${f.dueAt})` : ''}`,
      `- How to check: ${f.how || '(not given)'}`,
      'The scheduled task runs in a new session, so write the context it needs into its prompt. If the time is unclear, ask before creating it.',
      `Once it exists, remove the follow-up with ${tool} (action: done, id: ${f.id}).`,
    ].join('\n'),
  appActions: {
    commit: { label: 'Commit', prompt: 'Commit' },
    create_pr: { label: 'Create PR', prompt: 'Create the PR' },
    merge: { label: 'Merge', prompt: 'Merge the PR' },
  },
  asked: label => `Asked: ${label}`,
  notSent: (label, detail) => `Couldn't send “${label}”${detail ? `: ${detail}` : ''}`,
  paneNotPlaced: reason => `Couldn't open the archive pane: ${reason}`,
  toolDescription: [
    "Add, remove or list this session's follow-ups. A follow-up is a check with nothing to do now that can only be done later",
    ' (e.g. look at the replies in 3 days and decide on a price cut / try it for a few days and see whether it helped / resume once a wait is over).',
    ' Follow-ups show above the prompt in Claude Code Desktop, so the person sees them before archiving the session.',
    ' action: add takes what, when (a time, or what has to happen first) and how (where to look, what decides it); due_at (ISO 8601 with offset) when the time is fixed.',
    ' action: done takes the id and removes it (checked, no longer needed, or moved to a scheduled task). action: list lists them.',
  ].join(''),
  toolFields: {
    what: 'What to check',
    when: 'When, or what has to happen first',
    how: 'How to check (where to look, what decides it)',
    dueAt: 'ISO 8601 with offset, when the time is fixed',
    id: 'The id of the follow-up to remove (action: done)',
  },
  guide: tool =>
    [
      '# Follow-ups (archive-check)',
      `When this session is left with a check that has nothing to do now and can only be done later (e.g. look at the replies in a few days and decide on a price cut / use it for a while and see whether it helped / resume once a wait is over), add it with ${tool} (action: add) before ending the turn: what, when (or what has to happen first), and how to check.`,
      "Don't add what only waits for the person's answer, the rest of this turn's work, or CI on an open PR (those are counted already). Remove follow-ups that are checked or no longer needed with action: done.",
    ].join('\n'),
}

const ja: Messages = {
  badge: { ok: '済', caution: '注', blocked: '作' },
  badgeWidth: 24,
  verdict: { ok: '作業済み', caution: '注意あり', blocked: '作業中' },
  alt: {
    ok: '作業済み（アーカイブしてよい）',
    caution: '注意あり（アーカイブする前に確かめる）',
    blocked: '作業中（アーカイブすると作業を失う）',
  },
  paneTitle: 'アーカイブ',
  checking: '確かめています…',
  nothingLeft: '残っているものはありません',
  sectionBlocked: 'アーカイブすると失うもの',
  sectionCaution: 'アーカイブする前に確かめること',
  tagFollowup: '後続',
  tagAsk: '承認待ち',
  open: '開く',
  markDone: '済みにする',
  unread: what => `読めなかった: ${what}`,
  unreadWhat: {
    record: 'Desktop の記録',
    git: 'git',
    dirty: '未コミットの変更',
    unpushed: 'remote に無いコミット',
    mergedPrs: 'マージ済みの PR',
    prState: 'PR の状態',
    messages: '会話の記録',
    agents: 'エージェント',
    guide: '指示の Markdown',
    evaluate: '判定の材料',
  },
  dirty: n => `未コミットの変更 ${n} 件`,
  unpushed: n => `remote に無いコミット ${n} 本`,
  card: title => `未起動の提案カード「${title}」`,
  openPr: pr => `開いている PR ${pr}`,
  ciPending: pr => `PR ${pr} の CI が終わっていない`,
  backgroundTask: label => `動いている背景タスク「${label}」`,
  agent: label => `動いているエージェント「${label}」`,
  planLeft: (n, next) => `タスク一覧の残り ${n} 手順${next ? `（次: ${next}）` : ''}`,
  askQuestion: '質問への回答',
  askOffer: title => `新しいセッションか、ここでやるか「${title}」`,
  followup: (what, when) => (when ? `${what}（${when}）` : what),
  launchLabel: '起動を頼む',
  launchPrompt: (title, id) => `提案カード「${title}」${id ? `（${id}）` : ''}を起動して（archive-check の枠から）。`,
  commitLabel: 'コミットを頼む',
  commitPrompt: 'このセッションの未コミットの変更をコミットして（archive-check の枠から）。',
  pushLabel: 'push を頼む',
  pushPrompt: 'remote に無いコミットを push して（archive-check の枠から）。',
  scheduleLabel: '予定に移す',
  schedulePrompt: (f, tool) =>
    [
      `後続「${f.what}」を予定タスクに移して（archive-check の枠から）。`,
      `- いつ: ${f.when || '（未記入）'}${f.dueAt ? `（${f.dueAt}）` : ''}`,
      `- どう確かめる: ${f.how || '（未記入）'}`,
      '予定は新しいセッションで動くので、prompt にはこのセッションの前提を書き込む。日時がはっきりしなければ作る前に聞く。',
      `作れたら ${tool}（action: done, id: ${f.id}）で後続から消す。`,
    ].join('\n'),
  appActions: {
    commit: { label: 'コミット', prompt: 'コミットして' },
    create_pr: { label: 'PR を作る', prompt: 'PR を作って' },
    merge: { label: 'マージ', prompt: 'PR をマージして' },
  },
  asked: label => `「${label}」を頼みました`,
  notSent: (label, detail) => `「${label}」を送れませんでした${detail ? `: ${detail}` : ''}`,
  paneNotPlaced: reason => `アーカイブの枠を開けませんでした: ${reason}`,
  toolDescription: [
    'このセッションの「後続」を書き出す・消す・一覧する。後続は、今やる作業は無いが時間が経たないと結果が分からない確認',
    '（例: 3 日後に出品の反応を見て値下げを決める / 数日使ってから効いたか確かめる / 待ち時間が明けてから再開する）。',
    '書き出した後続は Desktop の入力欄の上の帯に出て、本人がアーカイブする前に気づける。',
    'action: add は what（何を）・when（いつ、または何が起きたら）・how（どう確かめる）を渡す。日時が決まっていれば due_at（ISO 8601、時差付き）も。',
    'action: done は id を渡して消す（確かめ終えた・不要になった・予定タスクに移した）。action: list は一覧を返す。',
  ].join(''),
  toolFields: {
    what: '何を確かめるか',
    when: 'いつ、または何が起きたら確かめるか',
    how: 'どう確かめるか（見る場所・判断の基準）',
    dueAt: '日時が決まっていれば ISO 8601（時差付き）',
    id: 'done で消す後続の id',
  },
  guide: tool =>
    [
      '# 後続（archive-check）',
      `今やる作業は無いが時間が経たないと結果が分からない確認がこのセッションに残ったら（例: 数日後に出品の反応を見て値下げを決める / しばらく使ってから効いたか確かめる / 待ち時間が明けてから再開する）、ターンを終える前に ${tool} の add で、何を・いつ（または何が起きたら）・どう確かめるかを書き出す。`,
      '本人の返事を待つだけのもの・このターンの続きの作業・開いた PR の CI 待ち（自動で数える）は後続にしない。確かめ終えた・不要になった後続は done で消す。',
    ].join('\n'),
}

export const MESSAGES: Record<Lang, Messages> = { en, ja }

export function langOf(value: unknown): Lang {
  return value === 'ja' ? 'ja' : 'en'
}
