# Usage Bars for Claude Code

Claude Code Desktop（Code タブ）の入力欄の上に、context・5 時間・7 日の使用率を 3 本のバーで常に出す mod（Claude Code のプラグイン）。

An unofficial Claude Code mod that keeps the context window, 5-hour and 7-day usage visible as three bars above the prompt in Claude Code Desktop.

![入力欄の上に並んだ 3 本のバー](docs/screenshot.png)

Anthropic の公式のものではありません。

## 出すもの

| バー | 中身 |
| --- | --- |
| `context` | 今のセッションの context window の使用率 |
| `5h` | 5 時間の利用枠の使用率と、リセットまでの残り時間 |
| `7d` | 7 日の利用枠の使用率と、リセットまでの残り時間 |

- 色は 50% 未満が緑、50% 以上が黄、80% 以上が赤
- トークン数とリセットの時刻は、バーの代替テキスト（読み上げ用）にだけ入れている

## 必要なもの

- Claude Code Desktop の Code タブ（手元で動くセッション）
- 5h / 7d を出すには、Claude のサブスクリプション（Pro / Max）でログインしていること。API キーで使っているときは 5h / 7d が `--` のままになる
- Claude Code 2.1.295（Windows 版 Desktop に同梱のもの）で確かめた。mod の API（function hooks）は early access で、版が上がると動かなくなることがある

## 入れ方

Desktop の Code タブでは `/plugin` が使えないので、ターミナルから入れる。どちらか一方でよい。

シェルから（スコープは既定の `user` で入る）:

```sh
claude plugin install usage-bars --marketplace tanmen/claude-usage-bars
```

ターミナルで起動した Claude Code のプロンプトから:

```
/plugin install usage-bars --marketplace tanmen/claude-usage-bars
```

こちらは `Add marketplace?` に `y`、スコープは `user` を選ぶ。

user スコープで入れると、Desktop の Code タブで手元に作るセッションにも読み込まれる。帯が出るのは**入れたあとに開いたセッションから**で、入れたときにもう開いていたセッションには出ない。

外すとき:

```sh
claude plugin uninstall usage-bars
```

## 大きさ

設定項目 `size` で 2 通りから選べる。

| `size` | バー | 帯の高さ |
| --- | --- | --- |
| `compact`（既定） | 19px・文字 11px | 40px（Desktop 自身の使用量の通知と同じ高さ） |
| `regular` | 26px・文字 12px | 47px |

帯の上下の余白（約 21px）は Desktop の枠のもので、mod からは変えられない。大きさで変わるのはバーの高さと文字の大きさだけ。

入れるときに選ぶ:

```sh
claude plugin install usage-bars --marketplace tanmen/claude-usage-bars --config size=regular
```

入れたあとに変える:

```sh
echo '{"size":"regular"}' | claude plugin configure usage-bars --values-stdin
```

## 知っておくこと

- **色はダークテーマ向け。** バーは SVG の画像として描かれ、アプリのテーマに追従しない。ライトテーマでは確かめていない
- **値はターンが終わるたびに更新される。** 5h / 7d は直前の応答が運んできた値で、別のセッションで使った分は、このセッションで次のターンが終わるまで反映されない
- **セッションを開いた直後**（最初の応答の前）は、5h / 7d だけ、最後に記録した値を灰色で出す（記録はマシンの中で全セッション共通）。context は最初の応答まで `--`
- 最初の応答が来ても 5h / 7d が空なら（API キーで使っているときなど）、灰色の値を消して `--` にする
- 残り時間の表示は 1 分ごとに描き直す
- ターミナルには出さない（ターミナルには `statusLine` がある）。アンケートが出ている間は、帯をアンケートに譲る

## 開発

```sh
claude plugin validate .
claude plugin test .
```

作業中の mod は `claude --plugin-dir .` で読み込める。

型チェック: `claude --plugin-dir .` で一度起動すると、Claude Code が `.claude-plugin/types/` に型定義と `tsconfig.json` を置く（インストールしたものや `claude -p` では置かれない）。ルートの `tsconfig.json` はそれを継いでいるので、そのあとは `tsc -p .` で検査できる。

## License

MIT
