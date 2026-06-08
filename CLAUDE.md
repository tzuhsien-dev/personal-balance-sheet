# CLAUDE.md

協作須知。功能、領域規則與每月操作流程請看 `README.md`，本檔不重複，只記「看一眼程式碼不會知道」的事。

## What

本機優先（local-first）的**每月**資產負債表 PWA「財務簿」，做每月資產 / 負債 / 額度 / 淨資產盤點，**不是每日記帳工具**。vanilla HTML / CSS / JavaScript，**無 build 工具、無 `package.json`、無 CI、無自動化測試**。

## Architecture

單頁 app：

- `index.html` — 頁面骨架與 `<meta>`（含 `google-client-id`）。
- `app.js` — 約 115KB 單一檔，幾乎所有邏輯都在這。頂部集中常數（`DB_VERSION`、各 `*_STORAGE_KEY`、門檻天數、`STOCK_QUOTE_API_URL` 等）。
- `styles.css` — 樣式。
- `sw.js` — Service Worker，靜態資源 **stale-while-revalidate**（快取瞬間回應、背景更新）+ `skipWaiting()` + `clients.claim()`。
- `manifest.webmanifest`、`icons/` — PWA manifest 與圖示。
- `worker/worker.js` + `wrangler.toml` — Cloudflare Worker，與前端**各自獨立部署**。

資料存瀏覽器 IndexedDB（`finance-ledger-db`），無後端、無登入。

## ⚠️ 最重要的 gotcha — 改動後務必 bump 版本號

任何 `app.js` / `styles.css` / `index.html` 改動後，**必須**同步遞增版本號，否則 PWA（尤其 iPhone 桌面 app）會吃舊快取：

- `index.html`：`styles.css?v=NN`、`app.js?v=NN`
- `sw.js`：`CACHE_NAME = "finance-ledger-vNN"` 與 `ASSETS` 內的 `?v=NN`

一鍵處理：**commit / push 前先跑 `./bump-version.sh`**（遞增上述全部 4 處），再 commit。因為 push 到 `main` 即部署，漏 bump 的那次 deploy 不會被 PWA 抓到。

PWA 自動更新機制：`app.js` 的 `registerServiceWorker()` 用 `updateViaCache: "none"` 抓 `sw.js`，並監聽 `controllerchange` 自動 reload。但若 `sw.js` 內容沒變（版本沒 bump），瀏覽器判定無更新 → 不會觸發更新。所以 bump 是更新生效的觸發點。

## ⚠️ 第二個 gotcha — 防載入閃爍的 paint cache（inline 還原腳本必須與 app.js 同步）

資料存在 IndexedDB（非同步），若什麼都不做，每次載入會先畫出靜態空狀態（NT$0／空清單／空表單），等 `loadData()` 讀完才 `render()` 補真實資料 → 中間那一格就是「閃爍」。

機制：
- `app.js` 的 `render()` 末尾呼叫 `savePaintCache()`，把畫面快照（各區塊 text / innerHTML / hidden flag / 表單收合狀態 / mobileTab）存進 localStorage（key `finance-ledger-paint-cache`，常數 `PAINT_TEXT_KEYS` / `PAINT_HTML_KEYS` / `PAINT_FLAG_KEYS`）。
- **`index.html` `</body>` 前有一支 inline 同步 script**，在第一次繪製前（早於被 defer 的 `app.js`）把快照還原上去並移除 `body.app-loading`。返回的使用者第一眼即為上次的真實畫面。
- `loadData()` 之後 `render()` 再以最新資料無痕覆蓋。

**核心原則 — 靜態 HTML 的首次繪製必須等於 JS reset/render 後的狀態。** 任何 init/`render()` 會改動、但靜態 HTML 預設值不同的元素，載入時都會閃（先畫舊樣子、JS 跑完才變）。修「載入閃爍」要**一次盤點所有** init/render 會寫入的 `els.X.(textContent|innerHTML|hidden|disabled|value)`，整批處理，別逐塊猜（這個 bug 曾因逐塊修來回十幾個版本）。資料相依的用快照，確定性的預設狀態直接寫進靜態 HTML。

**維護重點**：
1. 那支 inline 還原腳本的 key 陣列**必須與 `app.js` 的 `PAINT_*` 常數逐字一致**。新增／改名任何快照欄位時，**兩邊都要改**，否則該區塊會重新開始閃。
2. 快照只在 `render()`（唯一呼叫點在 `loadData()`）時拍攝，此時表單已 reset，所以**不快照表單輸入值**（避免拍到編輯中的表單）。表單的「分類」預設選項寫死在靜態 HTML、日期由 inline 補 today、收合狀態才走快照。
3. **靜態 HTML 要呈現 reset 後的表單樣子**：預設分類是「現金」，現金名稱固定，所以 `#entryNameField` 預設 `hidden`（對應 `updateCashFields()`）。**改預設分類時，分類選項與名稱欄的隱藏都要連動調整**。
4. `body` 預設帶 `app-loading` class（CSS 隱藏 `.app-shell`）；inline script 一定會在最後移除它（即使無快照或出錯），不要讓任何路徑漏掉這步，否則畫面會一直隱藏。

## Deploy

- **前端**：GitHub Pages，`main` 分支 `/root` 目錄。**push 即部署**，無 build / CI step。
- **股價 Worker**：`worker/worker.js` 部署到 Cloudflare Worker（轉送台灣證交所 TWSE 公開行情，不接收財務資料）。前端呼叫的網址寫在 `app.js` 的 `STOCK_QUOTE_API_URL`；換網址要同步改這裡。

## 其他須知

- **Google Drive 同步**：選用，`drive.appdata` scope。OAuth Client ID 由 `index.html` 的 `<meta name="google-client-id">` 提供（公開 repo 不內建 token）。
- **加密備份**：Web Crypto `PBKDF2-SHA256 + AES-GCM`，密碼不寫進 localStorage 或備份檔。不要 commit 備份檔。
- **Conventions**：UI 字串為繁體中文；金額預設 TWD；股票時間邏輯用 Asia/Taipei 時區，**13:40 為盤中 / 盤後分界**。
