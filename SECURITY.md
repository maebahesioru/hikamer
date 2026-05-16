# Security Policy

## 報告方法

脆弱性を発見した場合は、Issueではなく**直接DM**で報告してください。

- Discord: `zyuuzika`
- X (Twitter): `@maebahesioru2`

## 対象範囲

- `src/` 配下の全コード
- `providers.json` / `active.json` の取り扱い
- `.env` のAPIキー管理

## 注意事項

- `.env` ファイルは**絶対にコミットしないでください**
- APIキーは `providers.json` に保存されます。リポジトリ公開時は `apiKey: "sk-your-key-here"` に置き換えてください
- 実運用時は `active.json` と `providers.json` を `.gitignore` に追加することを推奨
