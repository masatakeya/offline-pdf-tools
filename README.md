# PDFツール（offline-pdf-tools）

PDFの **結合・分割・ページ抽出・ページ削除** を、ブラウザの中だけで行うWebアプリです。ファイルはどこにも送信されません。初回アクセス後はオフラインでも起動できます（PWA）。

仕様は [SPEC.md](SPEC.md) を参照してください。

> このツールは無保証です。ご利用は自己責任でお願いします。

## 構成

```
public/            配信するファイル一式（ビルド不要でそのまま公開）
  index.html
  css/style.css
  js/app.js        画面の動き
  js/pdfcore.js    PDFの読み込み・生成
  js/range.js      ページ範囲の解析
  vendor/          同梱ライブラリ（npm run build で生成）
  sw.js            Service Worker（npm run build で生成）
  version.js       版番号（npm run build で生成）
scripts/
  build.mjs        ライブラリのコピーとキャッシュ一覧の生成
  sw.template.js   Service Worker のひな形
wrangler.jsonc     Cloudflare Workers の設定
```

## 手元で動かす

```sh
npm install
npm run build
npm start          # http://localhost:8080 で開く
```

`public/` 内のファイルを変更したら、**公開前に必ず `npm run build` を実行してからコミット**してください。版番号とキャッシュ一覧が更新され、利用者の画面に「新しい版があります」と表示されます。

## Cloudflareへの公開

GitHubリポジトリをCloudflare Workersに連携します（Workers & Pages → 作成 → リポジトリをインポート）。

- ビルドコマンド: 空欄（不要）
- デプロイコマンド: `npx wrangler deploy`

`wrangler.jsonc` の設定により、`public/` が静的アセットとして配信されます。

## 使用ライブラリ

pdf-lib（MIT）、PDF.js（Apache-2.0）、fflate（MIT）、qpdf（Apache-2.0、WebAssembly版は @neslinesli93/qpdf-wasm・ISC）。詳細は `public/licenses.html`。
