# Archive Check for Claude Code

Claude Code Desktop（Code タブ）の入力欄の上に、そのセッションをアーカイブしてよいかを小さな札で出す mod（Claude Code のプラグイン）。札を押すと右側に枠が開き、理由と、その場でできる操作が並ぶ。

An unofficial Claude Code mod that shows, above the prompt in Claude Code Desktop, whether the session is safe to archive: **Done**, **Check** or **Busy**. Press the badge to open a pane on the right with the reasons and an action for each (mark a follow-up done, ask Claude to commit, push, schedule or start a suggested task, answer a waiting wrap-up question). It also keeps "follow-ups" — checks that can only be done later — that Claude writes down, so you notice them before archiving.

Anthropic の公式のものではありません。

## 札

| 札（en / ja） | 意味 | 何で決まるか |
| --- | --- | --- |
| `Busy` / `作` | アーカイブすると作業を失う | 未コミットの変更 / 今のブランチ（HEAD）の、remote に無いコミット（HEAD がマージ済みの PR の head と同じなら除く）/ 未起動の提案カード（期限切れは除く）/ 動いている背景タスク（`run_in_background` の Bash・PowerShell と Monitor）/ 動いているエージェント |
| `Check` / `注` | アーカイブしてよいが、先に確かめること | 後続 / 開いた PR の CI が終わっていない / 返事待ち（最後の wrap_up の質問・AskUserQuestion・「新しいセッションか、ここでやるか」）/ タスク一覧の残り / 開いた PR / 材料が読めなかった |
| `Done` / `済` | どれも無い | |

- 材料（Desktop の記録・git・PR の状態・会話・設定 `guide` の Markdown）が読めなかったとき、判定が途中で失敗したときは `Done` にせず `Check` にして、枠に何が読めなかったかを出す。git の管理外のフォルダは「失うものが無い」として扱う
- 1 分ごとと、ツールの呼び出し・ターンの終わりに判定し直す

## 右側の枠

札を押すと開き、もう一度押すと閉じる。「アーカイブすると失うもの」「アーカイブする前に確かめること」に分けて並べ、行ごとに操作を付ける。

| 行 | 操作 |
| --- | --- |
| 後続 | `Mark done`（mod だけで消す）/ `Schedule`（予定タスクにするよう Claude に頼む） |
| 返事待ちの wrap_up の質問 | 質問の選択肢と同じ返事を送る（`commit` などアプリの操作は、同じことを Claude に頼む） |
| 未起動の提案カード | `Ask to start`（起動を Claude に頼む） |
| 未コミットの変更 / remote に無いコミット | `Ask to commit` / `Ask to push` |
| 開いた PR | `Open`（GitHub の PR を開く） |

- 「頼む」ボタンは、その依頼文を自分で入力したのと同じ形でこのセッションに送る（`$.prompt.submit`）。Claude が動いている間に押すと、そのターンが終わってから届く
- 枠に出すのはこのセッションのものだけ。他のセッションが書き出した後続は出さない

## 後続

「今やる作業は無いが、時間が経たないと結果が分からない確認」（3 日後に反応を見て値下げを決める / 数日使ってから効いたか確かめる など）。mod が登録するツール `mcp__archive-check__followup` で Claude が書き出し（`add` / `done` / `list`）、いつ書き出すかの指示を mod がシステムプロンプトに 1 節足す。後続はセッションごとに mod の store に置き、CLI が止まって開き直しても残る。

## 設定

| 項目 | 既定 | 中身 |
| --- | --- | --- |
| `language` | `en` | `en` は英語（Done / Check / Busy）、`ja` は日本語（済 / 注 / 作）。画面の文言・ボタンが送る依頼文・Claude への既定の指示が切り替わる |
| `guide` | 空 | Claude に渡す「後続をいつ・どう書き出すか」の指示を、この Markdown ファイルの中身に差し替える（`~` はホーム）。自分の決まり（予定タスクの作り方など）を書く場所。読めないとき・中身が空のときは既定の指示を使い、枠に「読めなかった」を出す（その間、札は `Check` になる） |

```sh
claude plugin install archive-check --marketplace tanmen/claude-tanmen-plugins --config language=ja --config guide=~/archive-check.md
```

入れたあとに変える（名前は `archive-check@tanmen` の形で渡す。変えたあとは Claude Code を起動し直すと効く）:

```sh
echo '{"language":"ja"}' | claude plugin configure archive-check@tanmen --values-stdin
```

## 読むもの・書くもの

- 読むだけ:
  - Desktop のセッションの記録（Windows は `%APPDATA%\Claude\claude-code-sessions\…\<セッション>.json`、macOS は `~/Library/Application Support/Claude/claude-code-sessions/…`）。このセッションの分だけ。アプリの内部のファイルで、形が変わると読めなくなる
  - `~/.claude/sessions/` の各 json（使うのはこの CLI の起動時刻だけ）
  - 作業フォルダの `git rev-parse` / `git status` / `git rev-list`、このセッションの会話とエージェントの一覧、設定 `guide` の Markdown
- GitHub に問い合わせる: PR の状態を `gh pr view` で引く。このセッションの記録に載った開いている PR ごとに、同じ PR は 3 分に 1 回まで（判定は 1 分ごととツールの呼び出しのたび）。今のブランチに remote に無いコミットがあるときは、マージ済みの PR も引く。資格情報は gh が持ったままで、mod には渡らない
- 書く: mod 自身の store（後続と、このセッションで最後に「頼む」ボタンを押した結果。依頼文の本文は残さない）だけ。アプリの記録やリポジトリには書かない

## 必要なもの

- Claude Code Desktop の Code タブ（手元で動くセッション）。ターミナルの Claude Code にも読み込まれ、札は出さないが、後続のツールとシステムプロンプトの 1 節は入り、判定（git など）も回る。ターミナルで書き出した後続は Desktop の枠には出ない（そのセッションで `list` を呼ぶと読める）
- PR を見るには `gh`（ログイン済み）
- Claude Code 2.1.295（Windows 版 Desktop に同梱のもの）で確かめた。macOS の記録の場所は確かめていない。mod の API（function hooks）は early access で、版が上がると動かなくなることがある

## usage-bars と並べる

[usage-bars](../usage-bars) と一緒に入れると、札がバーの左に並ぶ（usage-bars 0.4.1 以降。どちらが先に読み込まれても同じ並びになる）。usage-bars のバーを押して詳細を開いている間だけは、読み込みの順で札がバーの横か詳細の横に付く。

## 外すとき

```sh
claude plugin uninstall archive-check@tanmen
```

## 開発

```sh
claude plugin validate .
claude plugin test .
```

作業中の mod は `claude --plugin-dir .` で読み込める。型チェックは usage-bars の README の「開発」と同じ（一度 `--plugin-dir` で起動すると `.claude-plugin/types/` が置かれ、`tsc -p .` が通る）。

## License

MIT
