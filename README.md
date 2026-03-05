# Boxing Memo

ボクシングの練習記録アプリです。記録したメモは `意識中` タブで自動集約され、達成した項目は `達成` タブへ移せます。

## 起動方法

```bash
npm install
cp .env.example .env
npm run dev
```

## 認証（推奨構成）

このアプリは `Supabase Auth` を使う構成です。

1. Supabase プロジェクトを作成
2. `Authentication > Providers > Email` を有効化
3. `Authentication > Settings` で `Enable email signups` を **OFF**（新規登録禁止）
4. ダッシュボードであなた用ユーザーを1件作成
5. `.env` に以下を設定

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
SUPABASE_JWT_AUD=authenticated
```

これで「既存アカウントのみログイン可（新規登録なし）」になります。

## DBセットアップ（必須）

記録データは Supabase DB に保存されます（`localStorage` は使いません）。

1. Supabase の `SQL Editor` を開く
2. [supabase/schema.sql](/Users/yamanoishuta/boxing-memo/supabase/schema.sql) の内容を実行
3. テーブル `boxing_entries` / `boxing_achieved_issues` と RLS が作成されることを確認

## API 保護

- `/api/extract-issues` は `Bearer token` 必須
- サーバー側で Supabase JWT を検証してから OpenAI を呼び出します

## OpenAI 設定

`.env` に以下を設定します。

```bash
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-nano
```

- `OPENAI_API_KEY` があると、保存時に OpenAI でメモを複数の指摘へ分解します
- 未設定ならローカルのルールベース分類へフォールバックします

## ビルド確認

```bash
npm run build
```

## ホスティング（Vercel）

このリポジトリは `Vite + Vercel Functions` 構成で公開できます。

1. GitHub に push
2. Vercel でリポジトリを import
3. Build Command: `npm run build`
4. Output Directory: `dist`
5. Environment Variables を設定

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
SUPABASE_JWT_AUD=authenticated
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-nano
```

- 本番の `/api/extract-issues` は [api/extract-issues.ts](/Users/yamanoishuta/boxing-memo/api/extract-issues.ts) が処理します
- フロントエンドからはこれまで通り `fetch("/api/extract-issues")` で利用できます

## 補足

- データは Supabase DB に保存されます（ユーザーごとに分離）
