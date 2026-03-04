# Boxing Memo

ボクシングの練習記録アプリです。記録したメモは `意識中` タブで自動集約され、達成した項目は `達成` タブへ移せます。

## 起動方法

```bash
npm install
cp .env.example .env
npm run dev
```

ブラウザで表示されたURLを開いてください。

## OpenAI設定

`.env` に以下を設定します。

```bash
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-nano
```

- `OPENAI_API_KEY` があると、保存時に OpenAI でメモを複数の指摘へ分解します
- 未設定ならローカルのルールベース分類へフォールバックします
- 現状はローカル開発用の Vite サーバー経由で OpenAI を呼びます

## ビルド確認

```bash
npm run build
```

## 補足

- データはブラウザの `localStorage` に保存されます
- 右上の `サンプルに戻す` でサンプルデータへ戻せます
