# Contributing to Aikata

## 開発の始め方

```bash
git clone https://github.com/maebahesioru/aikata.git
cd aikata
npm install
cp .env.example .env
npm run cli
```

## コードスタイル

- TypeScript strict mode
- `tsx` で直接実行（ビルド不要）
- ツール追加は `src/tools/` に配置し `src/tools/index.ts` に登録
- プロバイダー追加は `src/providers/` + `providers.json` の `type` 定義

## ブランチ戦略

- `main` - 安定版
- 機能追加・修正はフィーチャーブランチからPR

## テスト

```bash
npm run cli   # CLIモードで手動テスト
npm run lint  # 型チェック
```
