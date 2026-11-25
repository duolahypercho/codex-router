# Codex の設定と追加機能

[English](../CODEX.md) · [简体中文](../zh-CN/CODEX.md) · 日本語

インストール済みソースディレクトリで実行します。Windows は `./bin/model-router codex` を `.\model-router.ps1 codex`、`./bin/control` を `node src/control.mjs` に置き換えます。

## モデルメニューとリクエスト上限

セットアップ後に診断し、プロバイダーが `SHOW` と `ready` であることを確認します。Codex を完全に終了して開き直し、新規タスクでモデルを選びます。カタログは Codex 起動時に読み込みます。

```sh
./bin/model-router codex doctor
./bin/model-router codex providers
./bin/refresh-catalog
```

現在の Router は実行中に五分間隔でネイティブカタログの差分を確認します。更新後のメニューは次回の Codex 起動時に読み込みます。新モデルが見つからない場合は[トラブルシューティング](TROUBLESHOOTING.md)を参照してください。

既定の上限は受信圧縮体 64 MiB、展開後 256 MiB、同時推論 64 件、バッファー化するエラー本文 8 MiB です。アクティビティ記録は 15 分、独立した実行期限は 24 時間です。`MODEL_ROUTER_MAX_BODY_BYTES`、`MODEL_ROUTER_MAX_DECODED_BODY_BYTES`、`MODEL_ROUTER_MAX_ACTIVE_REQUESTS`、`MODEL_ROUTER_MAX_BUFFERED_RESPONSE_BYTES`、`MODEL_ROUTER_ACTIVITY_RECORD_RETENTION_MS`、`MODEL_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS` で調整できます。

## コネクターツール

`CODEX_ROUTER_APP_CONNECTORS` は外部モデルに先に公開するコネクターを制御します。空または `all` は通常のコネクター、`none` はすべて保留、カンマ区切り ID は選択したものを公開します。履歴の呼び出し、強制選択、許可リストで必要なツールは再宣言されます。明示的 deferred ツールはクライアントの検索手順に従います。サービスの環境を変更した後は定義を再生成して再起動します。

## 管理設定と呼び出し用キー

Router は Codex 設定のマーカーブロック、モデルカタログのパス、ランダムな呼び出し用キーを含むループバック URL を管理します。URL の秘密パスはログや画像を共有する前に伏せてください。キーをローテーションするには次を使います。

```sh
./bin/model-router codex caller-key rotate
```

実行中のサービスはローテーション時に停止して再起動し、成功後は旧キーが無効になります。完了後に Codex と実行中の Gemini CLI を再起動し、新 URL を読み込みます。

## 古いツール出力の保存と読取

**Token maxxing** は既定で無効です。有効化は次のリクエストから反映され、選択は保存されます。

```sh
node src/control.mjs tool-result-aging status
node src/control.mjs tool-result-aging on
node src/control.mjs tool-result-aging off
```

通常のエージングはモデルが既に使用した 32 KiB 超の古いテキスト結果を対象とし、最新四件を保持します。認識された AGENTS.md、SKILL.md などの指示ファイル読取と Cua ランタイム文書は、エージングで保持します。

省略前に完全な原文を保存し、同じ対話/権限スコープ内のローカル読取証明を検証します。検証前は原文と読み取り専用の復旧手順をリクエストに残します。保存失敗、アクセス失敗、無効な証明の場合も全文を保持します。

結果に付属する読取コマンドをそのまま使います。Node、スクリプト、署名付きハンドル、保存先が含まれます。返り値は `text`、`nextOffset`、`eof` です。ページングは `--offset N --limit N`、検索は `--find 'literal text'` を使います。対象ハンドルが分からない場合は有効な参照ハンドルで同一スコープ検索を実行します。削除、期限切れ、破損した原文は利用できない履歴証拠として扱います。元のコマンドの再実行は新しい観測になります。

コンテキスト圧縮でも同じエージング方針を使い、最近の結果を保持します。ネイティブ GPT の書き換えは別途有効にします。

```sh
node src/control.mjs tool-result-aging native on
node src/control.mjs tool-result-aging native off
```

`CODEX_ROUTER_TOOL_RESULT_AGING=0` は通常/ネイティブの書き換えを停止し、保存済み原文の期限処理は保持方針に従います。

原文は `<state dir>/retained-tool-results` に保存します。既定上限は 512 ファイルまたは 512 MiB、TTL は七日です。読取で有効期限を検証し、書き込み時または手動の期限切れ削除時に古いファイルを除去します。

```sh
node src/control.mjs tool-result-aging purge
node src/control.mjs tool-result-aging purge --expired --yes
node src/control.mjs tool-result-aging ttl 30
node src/control.mjs tool-result-aging ttl off
node src/control.mjs tool-result-aging ttl default
```

`purge` は既定でプレビューし、`--yes` で削除します。`--dry-run` を優先します。削除後は既存ハンドルから原文を取得できなくなります。[読取証明](tool-result-readback-proof.md)、[スコープ検索](tool-result-scope-search.md)、[モデル別方針](tool-result-model-policy.md)を参照してください。

## ログインとネイティブモデル

Control Center の **Use Router with ChatGPT** は ChatGPT ログインを保持し、管理対象のログイン済みトランスポートを使用します。**Use without OpenAI login** は有効な外部プロバイダーを利用し、元の設定を復元可能な形で保存します。切り替え後は Codex を再起動します。ネイティブ GPT やクラウドタスクなどのアカウント機能には OpenAI ログインを使います。

`native-redirect` は対象のネイティブ要求を指定の外部ルートに送ります。解除と、自動承認の利用枠フォールバック設定は次のとおりです。承認のフォールバックはネイティブ承認サービスが利用枠不足を報告した後の承認を処理します。

```sh
./bin/control auth-mode on
./bin/control auth-mode off
./bin/control native-redirect clear
./bin/control auto-review-fallback set kimi-oauth/k3
./bin/control auto-review-fallback status
./bin/control auto-review-fallback clear
```

複数アカウントの切り替えは [ChatGPT アカウント](CHATGPT-ACCOUNT-MODES.md)を参照してください。ネイティブの `gpt-5.6-sol-1m` コンテキスト変種は既定で非表示で、元のモデルがネイティブカタログにある場合に提供します。上流には元のモデル ID を送信します。`picker set gpt-5.6-sol-1m show` と `hide` で表示を切り替えます。

Windows Desktop と WSL を併用する場合は、`CODEX_HOME` と `CODEX_ROUTER_STATE_DIR` が実際の構成を指すことを確認し、Codex 実行環境から読み込めるパスを使います。

## ローカルモデルと画像ブリッジ

インストール、メモリ適合、キャンセル、モデル公開は[ローカル LLM](LOCAL-MODELS.md)を参照してください。画像ブリッジは既定で有効です。未選択時の現行既定値は `gpt-5.6-luna`、`low` で、利用できない場合は有効な候補から選びます。明示的 Auto は優先度のヒューリスティックで順位付けします。

画像の読み取りでは選択したエンジンを一度呼び出します。失敗した画像には読取失敗を示し、メインの会話は続行します。必要に応じて別のエンジンを選択してください。画像と質問のキャッシュは既定で一時間で、新しい質問、再起動、期限切れ、認証の変更で新しい呼び出しが発生する場合があります。

```sh
./bin/control vision-bridge status
./bin/control vision-bridge off
./bin/control vision-bridge engine qwen-plan/qwen3.6-flash
./bin/control vision-bridge engine auto
./bin/control vision-bridge local qwen2.5vl:3b
```

ブリッジ出力には読み取った文字、配置、図表の値、不確かな部分を含めます。細部の正確さは実際の読取結果に依存します。

## 利用枠と接続障害のフェイルオーバー

既定で有効です。利用枠の消尽、`402`、一分を超える待機を求める `429`、転送器が識別した応答開始前の接続障害が切り替え対象です。通常のプロバイダー `5xx`、無効なキー、引数エラーは元のエラーを返します。応答開始後は現在のストリームを維持します。

自動順序は選択済みの匿名無料モデルを優先し、続いて準備済みルートを優先度順に選びます。ローカルモデルは明示的なチェーンで指定します。候補にはコンテキスト、画像、検索などの条件も適用します。プロバイダーが示した復旧時刻は最大六時間保持します。

```sh
./bin/control failover status
./bin/control failover off
./bin/control failover chain opencode-free/big-pickle,kimi-api/kimi-k3
./bin/control failover auto
./bin/control failover reset
```

ローカルモデル定義の `failoverCandidate: false` は、そのルートを手動選択用にします。実際に引き継いだモデルはトレイ、ログ、使用量に記録します。

## 付属 skills と評価

インストーラーは Router、チャット管理、ブラウザー、コンピューター操作の skills を用意します。導入、削除、外部管理ディレクトリの承認は次のとおりです。

```sh
./bin/model-router codex skills install
./bin/model-router codex skills uninstall
./bin/model-router codex skills approve-external codex-router
./bin/model-router codex skills revoke-external codex-router
node scripts/measure-tool-result-aging.mjs /path/to/rollout.jsonl
node scripts/aging-benchmark.mjs
```

インストール済み skill の API 記述が現在のランタイムに対応します。保存による効果は実際の請求トークンとタスク結果で評価します。読取要求、キャッシュ変更、追加モデル呼び出しも総消費に影響します。
