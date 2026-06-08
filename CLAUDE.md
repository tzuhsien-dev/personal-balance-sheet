# CLAUDE.md

協作須知。功能、領域規則與每月操作流程請看 `README.md`，本檔不重複，只記「看一眼程式碼不會知道」的事。

## What

本機優先（local-first）的**每月**資產負債表 PWA「財務簿」，做每月資產 / 負債 / 額度 / 淨資產盤點，**不是每日記帳工具**。vanilla HTML / CSS / JavaScript，**無 build 工具、無 `package.json`、無 CI、無自動化測試**。

## Architecture

單頁 app：

- `index.html` — 頁面骨架與 `<meta>`（含 `google-client-id`）。
- `app.js` — 約 115KB 單一檔，幾乎所有邏輯都在這。頂部集中常數（`DB_VERSION`、各 `*_STORAGE_KEY`、門檻天數、`STOCK_QUOTE_API_URL` 等）。
- `styles.css` — 樣式。
- `sw.js` — Service Worker，network-first + `skipWaiting()` + `clients.claim()`。
- `manifest.webmanifest`、`icons/` — PWA manifest 與圖示。
- `worker/worker.js` + `wrangler.toml` — Cloudflare Worker，與前端**各自獨立部署**。

資料存瀏覽器 IndexedDB（`finance-ledger-db`），無後端、無登入。

## ⚠️ 最重要的 gotcha — 改動後務必 bump 版本號

任何 `app.js` / `styles.css` / `index.html` 改動後，**必須**同步遞增版本號，否則 PWA（尤其 iPhone 桌面 app）會吃舊快取：

- `index.html`：`styles.css?v=NN`、`app.js?v=NN`
- `sw.js`：`CACHE_NAME = "finance-ledger-vNN"` 與 `ASSETS` 內的 `?v=NN`

一鍵處理：`./bump-version.sh`（遞增上述全部 4 處）。

PWA 自動更新機制：`app.js` 的 `registerServiceWorker()` 用 `updateViaCache: "none"` 抓 `sw.js`，並監聽 `controllerchange` 自動 reload。但若 `sw.js` 內容沒變（版本沒 bump），瀏覽器判定無更新 → 不會觸發更新。所以 bump 是更新生效的觸發點。

## Deploy

- **前端**：GitHub Pages，`main` 分支 `/root` 目錄。**push 即部署**，無 build / CI step。
- **股價 Worker**：`worker/worker.js` 部署到 Cloudflare Worker（轉送台灣證交所 TWSE 公開行情，不接收財務資料）。前端呼叫的網址寫在 `app.js` 的 `STOCK_QUOTE_API_URL`；換網址要同步改這裡。

## 其他須知

- **Google Drive 同步**：選用，`drive.appdata` scope。OAuth Client ID 由 `index.html` 的 `<meta name="google-client-id">` 提供（公開 repo 不內建 token）。
- **加密備份**：Web Crypto `PBKDF2-SHA256 + AES-GCM`，密碼不寫進 localStorage 或備份檔。不要 commit 備份檔。
- **Conventions**：UI 字串為繁體中文；金額預設 TWD；股票時間邏輯用 Asia/Taipei 時區，**13:40 為盤中 / 盤後分界**。
