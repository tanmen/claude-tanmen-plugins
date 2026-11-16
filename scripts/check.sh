#!/bin/sh
# plugins/*/ のそれぞれに、claude plugin validate・claude plugin test・tsc の型チェックを回す。
#
#   sh scripts/check.sh                # plugins/ の mod を全部
#   sh scripts/check.sh usage-bars     # 名前を並べると、その mod だけ
#
# 道具は自分で探す。見つからなければ exit 2 で止める（黙って飛ばさない）。
#   claude.exe  Desktop に同梱のもの（%LOCALAPPDATA%\Claude-Data\claude_*\claude-code\<版>\<hash>\claude.exe）。
#               PATH には無い。版が 2 つ以上あれば一番新しい版を使う。CLAUDE_EXE で上書きできる
#   型ファイル  plugin-authoring の skill を読み込んだときに展開される
#               %TEMP%\claude\bundled-skills\<版>\<hash>\plugin-authoring\types\claude-code.d.ts。
#               claude.exe と同じ版のものだけを使い、無ければ止める（版が違う型で代用すると、落ちるはずの mod が
#               通ることがある）。CLAUDE_TYPES で別のファイルを渡すと、版が違えば警告してそれを使う
#               （mod の横の .claude-plugin/types/ は --plugin-dir で起動したときにしか置かれないので使わない）
#   tsc         pnpm dlx で typescript@TS_VERSION を取る（初回だけ npm から取り、あとは pnpm のストアから）。
#               TSC に typescript の bin/tsc（node で動かす）か tsc の実行ファイルを渡すと、それを使う
#
# 既定では、通った段は 1 行にまとめ、落ちた段だけ出力を全部出す。VERBOSE=1 で通った段の出力も出す。
# 終了コード: 0 = 全部通った / 1 = どれかが落ちた / 2 = 道具か mod が見つからない

set -u

TS_VERSION=7.0.2

die() { printf 'check.sh: %s\n' "$*" >&2; exit 2; }
warn() { printf 'check.sh: ⚠ %s\n' "$*" >&2; }

# Windows のパス（C:\...）を sh で扱える形（/c/...）に、sh のパスを Windows のプログラムに渡せる形（C:/...）に
to_sh() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s\n' "$1"; fi; }
to_win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }

TAB=$(printf '\t')
# 「<版><TAB><パス>」の行を版の順に並べ、一番新しい版の行を返す
newest() { sort -t "$TAB" -k1,1V | tail -n 1; }

cd "$(dirname "$0")/.." || die "リポジトリの根に移れない"

# ---- mod の一覧 -------------------------------------------------------------

if [ $# -eq 0 ]; then
  set -- plugins/*/
else
  for n do
    shift
    n=${n%/}
    set -- "$@" "plugins/${n#plugins/}/"
  done
fi
for d do
  [ -f "$d.claude-plugin/plugin.json" ] || die "mod が無い: $d（.claude-plugin/plugin.json が見つからない）"
done

# ---- claude.exe -------------------------------------------------------------

if [ -n "${CLAUDE_EXE:-}" ]; then
  [ -f "$CLAUDE_EXE" ] || die "CLAUDE_EXE が指すファイルが無い: $CLAUDE_EXE"
  claude=$CLAUDE_EXE
else
  [ -n "${LOCALAPPDATA:-}" ] || die "LOCALAPPDATA が無い（Windows の外では CLAUDE_EXE で claude のパスを渡す）"
  root=$(to_sh "$LOCALAPPDATA")/Claude-Data
  exes=$(for f in "$root"/claude_*/claude-code/*/*/claude.exe; do
    [ -f "$f" ] || continue
    v=${f%/*/claude.exe}
    printf '%s\t%s\n' "${v##*/}" "$f"
  done)
  [ -n "$exes" ] || die "claude.exe が見つからない: $root/claude_*/claude-code/<版>/<hash>/claude.exe（CLAUDE_EXE で渡せる）"
  pick=$(printf '%s\n' "$exes" | newest)
  claude=$(printf '%s\n' "$pick" | cut -f2)
  vers=$(printf '%s\n' "$exes" | cut -f1 | sort -uV)
  if [ "$(printf '%s\n' "$vers" | wc -l)" -gt 1 ]; then
    warn "claude.exe の版が 2 つ以上ある（$(printf '%s\n' "$vers" | paste -sd ' ' -)）。一番新しい $(printf '%s\n' "$pick" | cut -f1) を使う"
  fi
fi
claude_ver=$("$claude" --version 2>&1) || die "claude.exe が動かない: $(to_win "$claude"): $claude_ver"
claude_ver=${claude_ver%% *}
case $claude_ver in
  [0-9]*.[0-9]*) ;;
  *) die "claude.exe の版が読めない（--version が「$claude_ver」を返した）: $(to_win "$claude")" ;;
esac

# ---- 型ファイル ---------------------------------------------------------------

# 版が違う型ファイルでは代用しない。2.1.317 の型では通り、2.1.325 の型では落ちる mod が実際にあった
# （AbovePrompt の props に isCollapsed が足された）ので、代用すると通ったように見えてしまう
if [ -n "${CLAUDE_TYPES:-}" ]; then
  [ -f "$CLAUDE_TYPES" ] || die "CLAUDE_TYPES が指すファイルが無い: $CLAUDE_TYPES"
  types=$CLAUDE_TYPES
else
  troot=$(to_sh "${TEMP:-${TMPDIR:-/tmp}}")/claude/bundled-skills
  hint="$claude_ver のセッションで plugin-authoring の skill を一度読み込むと置かれる。別の版の型ファイルで回すなら CLAUDE_TYPES でパスを渡す"
  all=$(for f in "$troot"/*/*/plugin-authoring/types/claude-code.d.ts; do
    [ -f "$f" ] || continue
    v=${f#"$troot"/}
    printf '%s\t%s\n' "${v%%/*}" "$f"
  done)
  [ -n "$all" ] || die "型ファイルが見つからない: $troot/<版>/<hash>/plugin-authoring/types/claude-code.d.ts（$hint）"
  types=$(printf '%s\n' "$all" | awk -F "$TAB" -v v="$claude_ver" '$1 == v { print $2; exit }')
  [ -n "$types" ] || die "claude.exe $claude_ver の型ファイルが無い（あるのは $(printf '%s\n' "$all" | cut -f1 | sort -uV | paste -sd ' ' -)）。$hint"
fi
# 型ファイルの 1 行目は「// Written by Claude Code <版>.」
types_ver=$(head -n 1 "$types" | tr -d '\r' | sed -n 's|^// Written by Claude Code \([0-9][0-9.]*[0-9]\)\.*$|\1|p')
[ "${types_ver:-}" = "$claude_ver" ] || warn "型ファイルの版（${types_ver:-不明}）が claude.exe（$claude_ver）と違う: $(to_win "$types")"

# ---- tsc ----------------------------------------------------------------------

if [ -n "${TSC:-}" ]; then
  [ -f "$TSC" ] || die "TSC が指すファイルが無い: $TSC"
  case $TSC in
    *.exe|*.cmd|*.bat) run_tsc() { "$TSC" "$@"; } ;;
    *) run_tsc() { node "$TSC" "$@"; } ;;
  esac
  tsc_from=$(to_win "$TSC")
  tsc_ver=$(run_tsc --version 2>&1) || die "tsc が動かない: $TSC: $tsc_ver"
else
  command -v pnpm >/dev/null 2>&1 || die "pnpm が無い（TSC で typescript の bin/tsc を渡せる）"
  run_tsc() { pnpm --reporter=silent dlx --package="typescript@$TS_VERSION" tsc "$@"; }
  tsc_from="pnpm dlx typescript@$TS_VERSION"
  # 取得に失敗したときの理由が見えるよう、版の確かめだけは pnpm の出力を消さずに回す
  tsc_ver=$(pnpm dlx --package="typescript@$TS_VERSION" tsc --version 2>&1) || die "tsc を取れない（$tsc_from）: $tsc_ver"
fi
tsc_ver=$(printf '%s\n' "$tsc_ver" | tail -n 1)
tsc_ver=${tsc_ver#Version }

printf 'claude.exe: %s（%s）\n' "$(to_win "$claude")" "$claude_ver"
printf '型ファイル: %s（%s）\n' "$(to_win "$types")" "$types_ver"
printf 'tsc:        %s（%s）\n' "$tsc_from" "$tsc_ver"

# ---- mod ごとに 3 段 ----------------------------------------------------------

work=$(mktemp -d) || die "mktemp -d が使えない"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT TERM

verbose=${VERBOSE:-0}
fail=0
summary=

for d do
  name=${d%/}
  name=${name##*/}
  dwin=$(to_win "$(pwd)/${d%/}")
  printf '\n== %s\n' "$name"

  # validate: 通ったかは exit code で決める。警告の数はまとめに出すだけ
  # （テストの型の誤りも警告として出るだけで exit 0 になる。型で落とすのは下の tsc の段）
  log=$work/$name.validate.log
  "$claude" plugin validate "$d" >"$log" 2>&1
  rc=$?
  # 「Found N plugin directory warning(s)」は数えない（提出先のカタログの確かめで、結果に効かない）
  warns=$(tr -d '\r' <"$log" | grep -o 'Found [0-9][0-9]* warnings*:' | head -n 1 | tr -dc '0-9')
  if grep -q 'passed with warnings' "$log"; then
    warns="警告 ${warns:-あり・数は読めない}"
  else
    warns=警告なし
  fi
  if [ $rc -eq 0 ]; then
    r_validate="通過（$warns）"
    [ "$verbose" = 1 ] && cat "$log"
  else
    r_validate="失敗（exit $rc）"
    fail=1
    cat "$log"
  fi
  printf 'validate: %s\n' "$r_validate"

  # test: exit 0 でも、件数の行が無い・0 件なら失敗にする（走っていないのを通ったと読まない）
  log=$work/$name.test.log
  "$claude" plugin test "$d" >"$log" 2>&1
  rc=$?
  tr -d '\r' <"$log" >"$log.lf"
  ran=$(sed -n 's/^Ran \([0-9][0-9]*\) tests* across.*/\1/p' "$log.lf" | tail -n 1)
  npass=$(sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' "$log.lf" | tail -n 1)
  nfail=$(sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' "$log.lf" | tail -n 1)
  nskip=$(sed -n 's/^ *\([0-9][0-9]*\) skip$/\1/p' "$log.lf" | tail -n 1)
  counts="全 ${ran:-?} 件: ${npass:-?} 通過・${nfail:-?} 失敗${nskip:+・$nskip 飛ばし}"
  if [ $rc -eq 0 ] && [ "${ran:-0}" -gt 0 ]; then
    r_test="通過（$counts）"
    [ "$verbose" = 1 ] && cat "$log.lf"
  else
    fail=1
    if [ $rc -eq 0 ]; then
      r_test="失敗（exit 0 だがテストが 0 件か、件数の行が読めない）"
    elif [ -n "$ran" ]; then
      r_test="失敗（$counts）"
    else
      r_test="失敗（exit $rc）"
    fi
    # 通ったテストの行は省く（VERBOSE=1 なら全部）
    if [ "$verbose" = 1 ]; then cat "$log.lf"; else grep -v '^(pass) ' "$log.lf"; fi
  fi
  printf 'test:     %s\n' "$r_test"

  # tsc: tsconfig は mod の外（一時フォルダ）に書く。compilerOptions は型ファイルの頭のコメントの例と同じ
  cfg=$work/$name.tsconfig.json
  cat >"$cfg" <<EOF
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["$(to_win "$types")", "$dwin/hooks", "$dwin/types", "$dwin/tests"]
}
EOF
  cfgwin=$(to_win "$cfg")
  log=$work/$name.tsc.log
  # mod のファイルを 1 つも読んでいなければ、型の誤りが 0 件でも通ったことにしない
  nfiles=$(run_tsc -p "$cfgwin" --listFilesOnly 2>/dev/null | tr -d '\r' | grep -F -i -c "$dwin/")
  run_tsc -p "$cfgwin" >"$log" 2>&1
  rc=$?
  nerr=$(tr -d '\r' <"$log" | grep -c ': error TS')
  if [ $rc -eq 0 ] && [ "$nfiles" -gt 0 ]; then
    r_tsc="通過（mod の $nfiles ファイル）"
    [ "$verbose" = 1 ] && cat "$log"
  else
    fail=1
    if [ $rc -eq 0 ]; then
      r_tsc="失敗（exit 0 だが mod のファイルを 1 つも読んでいない）"
    else
      r_tsc="失敗（エラー $nerr・mod の $nfiles ファイル）"
    fi
    cat "$log"
  fi
  printf 'tsc:      %s\n' "$r_tsc"

  summary="$summary$name$TAB$r_validate$TAB$r_test$TAB$r_tsc
"
done

printf '\n== まとめ（claude %s・型 %s・tsc %s）\n' "$claude_ver" "$types_ver" "$tsc_ver"
printf '%s' "$summary" | while IFS="$TAB" read -r n v t c; do
  printf '%s\n  validate %s\n  test     %s\n  tsc      %s\n' "$n" "$v" "$t" "$c"
done
if [ $fail -eq 0 ]; then echo '→ 全部通った'; else echo '→ 落ちたものがある（exit 1）'; fi
exit $fail
