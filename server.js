require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const queue = [];
let isProcessing = false;

function finishProcessing() {
  isProcessing = false;
  processQueue();
}

function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  const { url, hours, resolve, reject } = queue.shift();
  scrapeZypage(url, hours)
    .then((data) => {
      resolve(data);
      finishProcessing();
    })
    .catch((err) => {
      reject(err);
      finishProcessing();
    });
}

function enqueue(url, hours) {
  return new Promise((resolve, reject) => {
    queue.push({ url, hours, resolve, reject });
    processQueue();
  });
}

app.get("/api/queue-status", (req, res) => {
  res.json({ queueLength: queue.length, isProcessing, cooldownRemaining: 0 });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAmount(value) {
  return parseInt(String(value).replace(/[^\d]/g, ""), 10) || 0;
}

function parseEmbeddedJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isAllowedZypageHostname(hostname) {
  const normalized = String(hostname).toLowerCase().replace(/\.$/, "");
  return normalized === "zypage.com" || normalized === "www.zypage.com";
}

function normalizeZypageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Vui long nhap link ZyPage hop le");
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Vui long nhap link ZyPage hop le");
  }
  if (!isAllowedZypageHostname(parsed.hostname) || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Vui long nhap link ZyPage hop le");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 1 || !/^[a-zA-Z0-9_-]+$/.test(segments[0])) {
    throw new Error("Vui long nhap link ZyPage hop le");
  }
  parsed.protocol = "https:";
  parsed.hostname = "zypage.com";
  parsed.port = "";
  parsed.pathname = `/${segments[0]}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function parseZypageDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]) - 7,
    Number(match[5]),
    Number(match[6]),
  );
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timeToHours(timeStr) {
  const match = String(timeStr || "").match(/(\d+)\s+(giây|phút|giờ|ngày|tuần|tháng|năm)/);
  if (!match) return Infinity;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const map = { "giây": 1 / 3600, "phút": 1 / 60, "giờ": 1, "ngày": 24, "tuần": 168, "tháng": 720, "năm": 8760 };
  return value * (map[unit] || Infinity);
}

function formatRelativeTime(timestamp, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} giây trước`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ngày trước`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} tuần trước`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} tháng trước`;
  return `${Math.floor(days / 365)} năm trước`;
}

function roundToDecimals(value, decimals) {
  const factor = 10 ** Math.max(0, Number(decimals) || 0);
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function convertCurrencyAmount(amount, targetCurrency, currencies) {
  const target = currencies?.other?.[targetCurrency];
  const usd = currencies?.other?.usd;
  if (!target || !usd) throw new Error(`Khong co cau hinh tien te ${targetCurrency}`);
  let converted = Number(amount);
  if (!Number.isFinite(converted)) throw new Error("So tien bang xep hang khong hop le");
  if (targetCurrency !== "usd") converted = (converted / Number(usd.exchange || 1)) * Number(target.exchange || 1);
  converted = roundToDecimals(converted, target.decimals);
  const rounding = Number(target.round) || 0;
  if (rounding > 0) converted = Math.round(converted / rounding) * rounding;
  return converted;
}

async function gotoWithRetry(page, url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (!response || response.status() >= 400) throw new Error(`ZyPage tra ve HTTP ${response?.status() || "khong xac dinh"}`);
      if (!isAllowedZypageHostname(new URL(page.url()).hostname)) throw new Error("ZyPage da chuyen huong den host khong hop le");
      await page.waitForTimeout(750);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(attempt * 1000);
    }
  }
  throw lastError;
}

async function retryPageOperation(page, operation, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(attempt * 500);
    }
  }
  throw lastError;
}

async function discoverShopId(page, observed) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (observed.shopId) return observed.shopId;
    await page.waitForTimeout(250);
  }
  const scripts = await retryPageOperation(page, () => page.locator("script").allTextContents());
  const match = scripts.join("\n").match(/\bshop_id\s*=\s*["'](\d+)["']/);
  return match?.[1] || null;
}

async function fetchApiJson(page, pathname, params, attempts = 3) {
  const endpoint = new URL(pathname, "https://zypage.com");
  for (const [key, value] of Object.entries(params)) endpoint.searchParams.set(key, String(value));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await page.request.get(endpoint.toString(), {
        failOnStatusCode: false,
        headers: {
          Accept: "application/json",
          Referer: page.url(),
          "X-Requested-With": "XMLHttpRequest",
        },
        timeout: 30000,
      });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      const body = await response.json();
      if (body?.status !== 1 || !Object.prototype.hasOwnProperty.call(body, "data")) {
        throw new Error(body?.message || "Schema API khong hop le");
      }
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(attempt * 750);
    } finally {
      await response?.dispose().catch(() => {});
    }
  }
  throw new Error(`${endpoint.pathname}: ${lastError?.message || "khong the goi API"}`);
}

async function fetchShopMetadata(page, shopId) {
  const data = await fetchApiJson(page, "/api/get_data_by_id", {
    table: "shop",
    data: "info,url",
    id: shopId,
  });
  const info = parseEmbeddedJson(data.info);
  if (!info.name || !info.currency) throw new Error("Schema thong tin ZyPage khong hop le");
  return {
    name: String(info.name).trim(),
    currency: String(info.currency).toLowerCase(),
  };
}

async function fetchDayRanking(page, shopId, currency, currencies) {
  const data = await fetchApiJson(page, "/api/shop_donate_statics", {
    target: "top",
    type: "day",
    child_type: "all",
    shop_id: shopId,
    page: 1,
    limit: 10,
  });
  if (!Array.isArray(data.data)) throw new Error("Schema bang xep hang ZyPage khong hop le");
  return data.data.map((item) => {
    const info = parseEmbeddedJson(item.info);
    return {
      name: String(info.name || "Unknown").trim(),
      amount: convertCurrencyAmount(item.amount, currency, currencies),
    };
  });
}

function parseApiDonation(item, now) {
  const data = parseEmbeddedJson(item.data);
  const info = parseEmbeddedJson(item.info);
  const date = parseZypageDate(item.date);
  const amount = Number(data.amount);
  if (!date || !Number.isFinite(amount) || amount < 0) return null;
  const rawId = item.order_id;
  const numericId = Number(rawId);
  return {
    id: rawId !== null && rawId !== undefined && String(rawId) !== "" && Number.isSafeInteger(numericId) ? numericId : String(rawId || ""),
    userId: item.id_user ?? null,
    nguoiGui: String(info.name || data.name || "Unknown").trim(),
    thoiGian: formatRelativeTime(date.getTime(), now),
    thoiGianGoc: String(item.date),
    timestamp: date.toISOString(),
    soTien: amount,
    loai: String(data.type || "donate"),
  };
}

async function fetchDonationHistory(page, shopId, hours, now) {
  const pageSize = 20;
  const cutoff = now - hours * 60 * 60 * 1000;
  const donations = new Map();
  const warnings = [];
  let pageNumber = 1;
  let pagesFetched = 0;
  let reachedCutoff = false;
  let malformed = 0;

  while (pageNumber <= 10000) {
    let data;
    try {
      data = await fetchApiJson(page, "/api/shop_donate_statics", {
        target: "history",
        type: "all",
        child_type: "all",
        shop_id: shopId,
        page: pageNumber,
        limit: pageSize,
      });
    } catch (error) {
      if (pagesFetched === 0) throw error;
      warnings.push(`Dung phan trang API tai page ${pageNumber}: ${error.message}`);
      break;
    }
    if (!Array.isArray(data.data)) throw new Error("Schema lich su ZyPage khong hop le");
    const rows = data.data;
    pagesFetched++;
    if (rows.length === 0) break;

    let newestTimestamp = -Infinity;
    for (const item of rows) {
      const rawDate = parseZypageDate(item.date);
      if (rawDate) newestTimestamp = Math.max(newestTimestamp, rawDate.getTime());
      const donation = parseApiDonation(item, now);
      if (!donation) {
        malformed++;
        continue;
      }
      if (donation.loai !== "donate") continue;
      const key = donation.id !== "" ? String(donation.id) : `${donation.timestamp}:${donation.userId}:${donation.soTien}:${donation.nguoiGui}`;
      if (!donations.has(key)) donations.set(key, donation);
    }

    if (newestTimestamp < cutoff) {
      reachedCutoff = true;
      break;
    }
    if (rows.length < pageSize) break;
    pageNumber++;
    await delay(100);
  }

  if (pageNumber > 10000) warnings.push("API vuot qua gioi han an toan 10000 trang");
  if (malformed > 0) warnings.push(`Bo qua ${malformed} ban ghi API khong hop le`);
  const list = Array.from(donations.values())
    .filter((donation) => new Date(donation.timestamp).getTime() >= cutoff)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime() || Number(b.id) - Number(a.id));

  return {
    list,
    warnings,
    partial: warnings.length > 0,
    pagination: {
      type: "page",
      pageSize,
      pagesFetched,
      lastPage: pageNumber,
      totalAvailable: null,
      reachedCutoff,
      cutoffTimestamp: new Date(cutoff).toISOString(),
    },
  };
}

function createResult({ streamer, url, hours, ranking, donations, source, partial, warnings, pagination }) {
  const dayTotal = ranking.reduce((sum, row) => sum + row.amount, 0);
  const totalFiltered = donations.reduce((sum, donation) => sum + donation.soTien, 0);
  return {
    streamer,
    url,
    hours,
    thoiGianCao: new Date().toLocaleString("vi-VN"),
    source,
    partial,
    warnings,
    phanTrang: pagination,
    bangXepHangNgay: {
      top: ranking,
      tong: dayTotal,
    },
    donateFiltered: {
      soLuong: donations.length,
      tongTien: totalFiltered,
      danhSach: donations,
    },
  };
}

async function scrapeViaApi(page, shopId, url, hours, now) {
  const metadata = await fetchShopMetadata(page, shopId);
  const currencies = await fetchApiJson(page, "/api/data", { data: "currency" });
  const ranking = await fetchDayRanking(page, shopId, metadata.currency, currencies);
  const history = await fetchDonationHistory(page, shopId, hours, now);
  return createResult({
    streamer: metadata.name,
    url,
    hours,
    ranking,
    donations: history.list,
    source: "api",
    partial: history.partial,
    warnings: history.warnings,
    pagination: history.pagination,
  });
}

async function extractDomRanking(page) {
  const dayButton = page.getByRole("button", { name: "Ngày", exact: true }).first();
  if (await dayButton.count()) {
    await retryPageOperation(page, () => dayButton.click({ timeout: 10000 }));
    await page.waitForTimeout(1000);
  }
  return retryPageOperation(page, () => page.locator(".top_wall_list .top_wall_item").evaluateAll((items) => {
    return items.map((item) => ({
      name: item.querySelector(".top_wall_name")?.textContent?.trim() || "",
      amount: item.querySelector(".top_wall_amount")?.textContent?.trim() || "",
    })).filter((item) => item.name && item.amount);
  }));
}

async function extractDomDonations(page) {
  return retryPageOperation(page, () => page.locator(".history_wall_item").evaluateAll((items) => {
    return items.map((item) => ({
      name: item.querySelector(".awi_name")?.textContent?.trim() || "",
      time: item.querySelector(".awi_time")?.textContent?.trim() || "",
      amount: item.querySelector(".awi_amount")?.textContent?.trim() || "",
      action: item.querySelector(".awi_donate")?.textContent?.trim() || "",
    })).filter((item) => item.name && item.time && item.amount && /^Donate\b/i.test(item.action));
  }));
}

async function waitForDomDonationGrowth(page, previousCount, minimumWait = 2000, maximumWait = 10000) {
  const startedAt = Date.now();
  await page.waitForTimeout(minimumWait);
  while (Date.now() - startedAt < maximumWait) {
    const currentCount = await retryPageOperation(page, () => page.locator(".history_wall_item").count());
    if (currentCount > previousCount) return true;
    const remaining = maximumWait - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(500, remaining));
  }
  return false;
}

async function scrapeViaDom(page, url, hours) {
  await retryPageOperation(page, () => page.locator(".top_wall_list, .history_wall_item").first().waitFor({ timeout: 30000 }));
  const rawRanking = await extractDomRanking(page);
  const ranking = rawRanking.map((item) => ({ name: item.name, amount: parseAmount(item.amount) }));
  let stagnant = 0;
  let rawDonations = [];
  let reachedCutoff = false;

  for (let attempt = 0; attempt < 100; attempt++) {
    rawDonations = await extractDomDonations(page);
    const oldestHours = rawDonations.reduce((max, item) => Math.max(max, timeToHours(item.time)), 0);
    if (rawDonations.length > 0 && oldestHours > hours) {
      reachedCutoff = true;
      break;
    }
    const previousCount = await retryPageOperation(page, () => page.locator(".history_wall_item").count());
    await retryPageOperation(page, () => page.locator("body").evaluate((body) => window.scrollTo(0, body.scrollHeight)));
    const grew = await waitForDomDonationGrowth(page, previousCount);
    stagnant = grew ? 0 : stagnant + 1;
    if (stagnant >= 4) break;
  }
  rawDonations = await extractDomDonations(page);

  const donations = rawDonations
    .map((item) => ({
      id: null,
      userId: null,
      nguoiGui: item.name,
      thoiGian: item.time,
      thoiGianGoc: null,
      timestamp: null,
      soTien: parseAmount(item.amount),
      loai: "donate",
      hours: timeToHours(item.time),
    }))
    .filter((item) => item.hours <= hours)
    .map(({ hours: donationHours, ...item }) => item);
  const title = await retryPageOperation(page, () => page.title());
  const streamer = title.replace(/\s+on\s+ZyPage$/i, "").trim() || "Unknown";
  const warnings = ["DOM fallback khong co donation ID va timestamp chinh xac"];
  if (!reachedCutoff) warnings.push("DOM infinite scroll co the chua tai du du lieu trong khoang thoi gian yeu cau");

  return createResult({
    streamer,
    url,
    hours,
    ranking,
    donations,
    source: "dom",
    partial: true,
    warnings,
    pagination: {
      type: "infinite-scroll",
      pagesFetched: null,
      lastPage: null,
      totalAvailable: null,
      reachedCutoff,
    },
  });
}

async function scrapeZypage(inputUrl, hours = 24) {
  const url = normalizeZypageUrl(inputUrl);
  const normalizedHours = Math.max(1, Math.min(720, parseInt(hours, 10) || 24));
  const now = Date.now();
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({
      locale: "vi-VN",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    await page.route("**/*", async (route) => {
      try {
        const requestUrl = new URL(route.request().url());
        if (["http:", "https:"].includes(requestUrl.protocol) && !isAllowedZypageHostname(requestUrl.hostname)) return route.abort();
      } catch {
        return route.abort();
      }
      return route.continue();
    });

    const observed = { shopId: null };
    page.on("request", (request) => {
      try {
        const requestUrl = new URL(request.url());
        if (requestUrl.pathname === "/api/shop_donate_statics") {
          const shopId = requestUrl.searchParams.get("shop_id");
          if (/^\d+$/.test(shopId || "")) observed.shopId = shopId;
        }
        if (requestUrl.pathname === "/api/get_data_by_id" && requestUrl.searchParams.get("table") === "shop") {
          const shopId = requestUrl.searchParams.get("id");
          if (/^\d+$/.test(shopId || "")) observed.shopId = shopId;
        }
      } catch {}
    });

    await gotoWithRetry(page, url);
    const shopId = await discoverShopId(page, observed);
    let apiError;
    if (shopId) {
      try {
        return await scrapeViaApi(page, shopId, url, normalizedHours, now);
      } catch (error) {
        apiError = error;
      }
    } else {
      apiError = new Error("Khong tim thay shop_id trong XHR hoac trang ZyPage");
    }

    try {
      const result = await scrapeViaDom(page, url, normalizedHours);
      result.warnings.unshift(`API-first that bai: ${apiError.message}`);
      return result;
    } catch (domError) {
      throw new Error(`API-first that bai: ${apiError.message}; DOM fallback that bai: ${domError.message}`);
    }
  } finally {
    await browser.close();
  }
}

app.post("/api/scrape", async (req, res) => {
  let url;
  try {
    url = normalizeZypageUrl(req.body?.url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const hours = Math.max(1, Math.min(720, parseInt(req.body?.hours, 10) || 24));
  try {
    const data = await enqueue(url, hours);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: `Loi khi cao du lieu: ${err.message}` });
  }
});

function startServer() {
  const port = process.env.PORT || 3000;
  return app.listen(port, "0.0.0.0", () => {
    console.log(`Server dang chay tai http://localhost:${port}`);
  });
}

if (require.main === module) startServer();

module.exports = {
  app,
  convertCurrencyAmount,
  normalizeZypageUrl,
  parseAmount,
  parseZypageDate,
  scrapeViaDom,
  scrapeZypage,
  startServer,
};
