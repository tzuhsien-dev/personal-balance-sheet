const TWSE_QUOTE_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";
const SYMBOL_PATTERN = /^[0-9A-Z]{2,10}$/;

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
