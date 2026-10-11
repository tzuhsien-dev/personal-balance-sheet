const TWSE_QUOTE_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const TWSE_HISTORY_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY";
// TPEx turns requests from Cloudflare Workers away, so OTC history comes from Yahoo.
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
// Yahoo answers 429 to requests without a browser User-Agent.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const TAIPEI_OFFSET_SECONDS = 8 * 60 * 60;
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

async function fetchWithTimeout(url, headers) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/** A listed share's closes in one month from TWSE, or null when TWSE has none or fails. */
async function requestTwseMonthCloses(symbol, month) {
  const [year, monthNumber] = month.split("-");
  const url = new URL(TWSE_HISTORY_URL);
  url.searchParams.set("date", `${year}${monthNumber}01`);
  url.searchParams.set("stockNo", symbol);
  url.searchParams.set("response", "json");
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    const listed = await response.json();
    return listed?.stat === "OK" && Array.isArray(listed.data) && listed.data.length > 0
      ? { exchange: "上市", source: "twse", closes: dailyCloses(listed.data) }
      : null;
  } catch {
    return null;
  }
}

/**
 * Closes in one month from Yahoo: as a listed share (.TW), then as an OTC
 * one (.TWO). Its closes match TWSE and TPEx day for day.
 */
async function requestYahooMonthCloses(symbol, month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = Date.UTC(year, monthNumber - 1, 1) / 1000 - TAIPEI_OFFSET_SECONDS;
  const end = Date.UTC(year, monthNumber, 1) / 1000 - TAIPEI_OFFSET_SECONDS;
  for (const [suffix, exchange] of [["TW", "上市"], ["TWO", "上櫃"]]) {
    const url = new URL(`${YAHOO_CHART_URL}${symbol}.${suffix}`);
    url.searchParams.set("period1", String(start));
    url.searchParams.set("period2", String(end));
    url.searchParams.set("interval", "1d");
    const response = await fetchWithTimeout(url, { "User-Agent": BROWSER_USER_AGENT });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
    const result = (await response.json())?.chart?.result?.[0];
    const offset = Number(result?.meta?.gmtoffset ?? TAIPEI_OFFSET_SECONDS);
    const prices = result?.indicators?.quote?.[0]?.close ?? [];
    const closes = (result?.timestamp ?? [])
      .map((time, index) => ({
        date: new Date((time + offset) * 1000).toISOString().slice(0, 10),
        close: typeof prices[index] === "number" && prices[index] > 0
          ? Math.round(prices[index] * 100) / 100
          : null,
      }))
      .filter((row) => row.close !== null);
    if (closes.length > 0) return { exchange, source: "yahoo", closes };
  }
  return null;
}

/** Each trading day's close in one month: TWSE first, then Yahoo for OTC shares or when TWSE fails. */
async function requestMonthCloses(symbol, month) {
  return await requestTwseMonthCloses(symbol, month) ?? await requestYahooMonthCloses(symbol, month);
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
    return jsonResponse({ error: timedOut ? "歷史行情連線逾時" : "歷史行情暫時無法使用" }, timedOut ? 504 : 502);
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
