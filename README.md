# Aikata（アイカタ）

自律型AIエージェント。Discord / Telegram / CLI で動作するマルチプラットフォームの「相棒」。

## 特徴

- **マルチプラットフォーム**：Discord Bot + Telegram Bot + CLI
- **7ツール完備**：シェル実行 / ファイル操作 / Web検索 / ブラウザ操作 / コード実行 / スケジュール / SQLiteクエリ
- **マルチLLM**：OpenAI / Anthropic / Gemini 互換APIに対応。プロバイダー動的追加可能
- **camofox対応**：C++レベルの指紋偽装ステルスブラウザ（Playwrightフォールバック付き）
- **SQLite永続化**：会話履歴・ツールログ・定期タスクを完全保存
- **スレッド対応**：Discordのスレッド自動生成＋AIによるスレッドタイトル命名
- **定期実行**：cron式でタスクをスケジュール、Discord/Telegramに配信
- **TypeScript**：型安全・ゼロコンフィグ (`tsx` で直接実行)

## クイックスタート

```bash
git clone https://github.com/maebahesioru/aikata.git
cd aikata
npm install
cp .env.example .env
# .env に Discord/Telegramトークンを記入
npm run cli    # CLIテスト
npm start      # 本番起動
```

## コマンド一覧

| コマンド | 説明 |
|----------|------|
| `/provider list` | プロバイダー一覧 |
| `/provider set <名>` | プロバイダー切替 |
| `/provider add <key> <type> <url> <key>` | プロバイダー追加 |
| `/provider del <key>` | プロバイダー削除 |
| `/model <モデル名>` | モデル切替 |
| `/models` | モデル一覧（APIから動的取得） |
| `/maxiter <1〜1000>` | 最大反復回数 |
| `/info` | 現在の設定 |
| `/reset` | 会話履歴リセット |

## 設定ファイル

- `providers.json` - プロバイダー定義（手動編集可）
- `active.json` - 現在のプロバイダー+モデル（起動時自動読込）
- `.env` - トークン・SearXNGエンドポイント・最大反復

## 必要環境

- Node.js >= 22
- オプション: SearXNG（Web検索用、localhost:18080）
- オプション: camofox-browser（ステルスブラウザ用、localhost:9377）

## ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照
