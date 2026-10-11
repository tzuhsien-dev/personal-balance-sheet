const TWSE_QUOTE_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const TWSE_HISTORY_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY";
const TPEX_HISTORY_URL = "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock";
const SYMBOL_PATTERN = /^[0-9A-Z]{2,10}$/;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function pickPrice(value) {
  if (value == null || value === "-") return null;
  const price = Number(value);
  return price > 0 ? price : null;
}

function taiwanDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function isLiveQuote(quote, now = new Date()) {
  const parts = taiwanDateParts(now);
  const today = `${parts.year}${parts.month}${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(parts.weekday);
  return isWeekday && quote.d === today && minutes >= 9 * 60 && minutes <= 13 * 60 + 35;
}

function quoteDate(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

async function requestExchangeQuote(symbol, exchange) {
  const url = new URL(TWSE_QUOTE_URL);
  url.searchParams.set("ex_ch", `${exchange.id}_${symbol}.tw`);
  url.searchParams.set("json", "1");
  url.searchParams.set("delay", "0");
  url.searchParams.set("_", Date.now().toString());

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!response.ok) throw new Error(`TWSE HTTP ${response.status}`);

    const data = await response.json();
    const quote = data?.msgArray?.[0];
    if (data?.rtcode !== "0000" || !quote) return null;

    const tradedPrice = pickPrice(quote.z) ?? pickPrice(quote.pz);
    const previousClose = pickPrice(quote.y);
    const price = tradedPrice ?? previousClose;
    if (!(price > 0)) return null;
    const live = tradedPrice != null && isLiveQuote(quote);

    return {
      symbol,
      name: quote.n || symbol,
      price,
      exchange: exchange.label,
      fetchedAt: new Date().toISOString(),
      priceDate: tradedPrice != null ? quoteDate(quote.d) : null,
      priceType: tradedPrice == null ? "previousClose" : live ? "live" : "close",
      isLive: live,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** "115/10/01" (ROC year) to "2026-10-01". */
function rocDate(value) {
  const match = String(value || "").trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  return match ? `${Number(match[1]) + 1911}-${match[2]}-${match[3]}` : null;
}

function historyPrice(value) {
  const price = Number(String(value ?? "").replaceAll(",", ""));
  return price > 0 ? price : null;
}

function dailyCloses(rows) {
  return rows
    .map((row) => ({ date: rocDate(row?.[0]), close: historyPrice(row?.[6]) }))
    .filter((row) => row.date !== null && row.close !== null);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Each trading day's close in one month: listed first, then OTC. */
async function requestMonthCloses(symbol, month) {
  const [year, monthNumber] = month.split("-");
  const twse = new URL(TWSE_HISTORY_URL);
  twse.searchParams.set("date", `${year}${monthNumber}01`);
  twse.searchParams.set("stockNo", symbol);
  twse.searchParams.set("response", "json");
  const listed = await fetchJson(twse);
  if (listed?.stat === "OK" && Array.isArray(listed.data)) {
    return { exchange: "上市", closes: dailyCloses(listed.data) };
  }

  const tpex = new URL(TPEX_HISTORY_URL);
  tpex.searchParams.set("code", symbol);
  tpex.searchParams.set("date", `${year}/${monthNumber}/01`);
  tpex.searchParams.set("response", "json");
  const otc = await fetchJson(tpex);
  const rows = otc?.tables?.[0]?.data;
  if (otc?.stat === "ok" && Array.isArray(rows) && rows.length > 0) {
    return { exchange: "上櫃", closes: dailyCloses(rows) };
  }
  return null;
}

async function monthClosesResponse(symbol, month) {
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "月份格式不正確" }, 400);
  }
  try {
    const history = await requestMonthCloses(symbol, month);
    if (!history) return jsonResponse({ error: "找不到這個月的收盤價" }, 404);
    return jsonResponse({ symbol, month, ...history });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return jsonResponse({ error: timedOut ? "證交所歷史行情連線逾時" : "證交所歷史行情暫時無法使用" }, timedOut ? 504 : 502);
  }
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "只支援 GET 請求" }, 405);
    }

    const requestUrl = new URL(request.url);
    const symbol = (requestUrl.searchParams.get("symbol") || "").trim().toUpperCase().replace(/\.TW$|\.TWO$/, "");
    if (!SYMBOL_PATTERN.test(symbol)) {
      return jsonResponse({ error: "股票代號格式不正確" }, 400);
    }
    const month = requestUrl.searchParams.get("month");
    if (month !== null) return monthClosesResponse(symbol, month.trim());

    const exchanges = [
      { id: "tse", label: "上市" },
      { id: "otc", label: "上櫃" },
    ];

    try {
      for (const exchange of exchanges) {
        const quote = await requestExchangeQuote(symbol, exchange);
        if (quote) return jsonResponse(quote);
      }
      return jsonResponse({ error: "找不到股票代號或目前沒有行情" }, 404);
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      return jsonResponse({ error: timedOut ? "證交所行情服務連線逾時" : "證交所行情服務暫時無法使用" }, timedOut ? 504 : 502);
    }
  },
};
