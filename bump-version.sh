#!/usr/bin/env bash
# 一次遞增 index.html 與 sw.js 內的版本號（finance-ledger-vNN 與 ?v=NN）。
# 任何 app.js / styles.css / index.html 改動後執行，避免 PWA 吃舊快取。
set -euo pipefail
cd "$(dirname "$0")"
current=$(grep -oE 'finance-ledger-v[0-9]+' sw.js | grep -oE '[0-9]+' | head -1)
next=$((current + 1))
sed -i '' -E "s/finance-ledger-v${current}/finance-ledger-v${next}/g; s/v=${current}/v=${next}/g" index.html sw.js
echo "bumped v${current} -> v${next}"
