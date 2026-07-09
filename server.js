const express = require("express");
const { chromium } = require("playwright");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const queue = [];
let isProcessing = false;
const COOLDOWN_MS = 5000;

function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  const { url, hours, resolve, reject } = queue.shift();
  scrapeZypage(url, hours)
    .then((data) => {
      resolve(data);
      setTimeout(() => {
        isProcessing = false;
        processQueue();
      }, COOLDOWN_MS);
    })
    .catch((err) => {
      reject(err);
      setTimeout(() => {
        isProcessing = false;
        processQueue();
      }, COOLDOWN_MS);
    });
}

function enqueue(url, hours) {
  return new Promise((resolve, reject) => {
    queue.push({ url, hours, resolve, reject });
    processQueue();
  });
}

app.get("/api/queue-status", (req, res) => {
  res.json({ queueLength: queue.length, isProcessing });
});

function parseAmount(str) {
  return parseInt(str.replace(/[^\d]/g, ""), 10) || 0;
}

function timeToHours(timeStr) {
  const m = timeStr.match(/(\d+)\s+(giây|phút|giờ|ngày|tuần|tháng|năm)/);
  if (!m) return Infinity;
  const val = parseInt(m[1], 10);
  const unit = m[2];
  const map = { "giây": 1 / 3600, "phút": 1 / 60, "giờ": 1, "ngày": 24, "tuần": 168, "tháng": 720, "năm": 8760 };
  return val * (map[unit] || Infinity);
}

async function scrapeZypage(url, hours = 24) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(5000);

    const streamerName = await page.evaluate(() => {
      const el = document.querySelector("h1, h2, .shop_name, [class*='name']");
      return el?.innerText?.trim() || "Unknown";
    });

    const dayBtn = page.locator("button.top_wall_tab_btn", { hasText: "Ngày" });
    const hasDayBtn = await dayBtn.count();
    let dayRanking = [];
    if (hasDayBtn > 0) {
      await dayBtn.click();
      await page.waitForTimeout(3000);
      const dayText = await page.evaluate(() => {
        const titles = document.querySelectorAll(".menu_title");
        for (const t of titles) {
          if (t.innerText.includes("BẢNG XẾP HẠNG")) return t.parentElement?.innerText || "";
        }
        return "";
      });
      const lines = dayText.split("\n").map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const am = lines[i].match(/^([\d,.]+)đ$/);
        if (am && i > 0) {
          let name = lines[i - 1];
          if (name.match(/^#\d+$/)) name = lines[i - 2] || name;
          dayRanking.push({ name, amount: parseAmount(am[1]) });
        }
      }
    }
    const dayTotal = dayRanking.reduce((s, r) => s + r.amount, 0);

    const recentSection = page.locator("text=GẦN ĐÂY").first();
    const hasRecent = await recentSection.count();
    if (hasRecent > 0) {
      await recentSection.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);
    }

    let prevCount = 0;
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      const curCount = await page.evaluate(() => {
        return (document.body.innerText.match(/Donate\s+[\d,.]+đ/g) || []).length;
      });
      if (curCount === prevCount && i > 3) break;
      prevCount = curCount;
    }

    const allText = await page.evaluate(() => document.body.innerText);
    const recentParts = allText.split("GẦN ĐÂY");
    const recentText = recentParts.length > 1 ? recentParts[1] : "";

    const donateRegex = /(.+?)\n(\d+\s+(?:giờ|phút|giây|ngày|tuần|tháng|năm)\s+trước)\nDonate\s+([\d,.]+)đ(?:\s+với lời nhắn)?/g;
    let m;
    const allDonations = [];
    while ((m = donateRegex.exec(recentText)) !== null) {
      const hours = timeToHours(m[2].trim());
      allDonations.push({
        nguoiGui: m[1].trim(),
        thoiGian: m[2].trim(),
        soTien: parseAmount(m[3]),
        hours,
      });
    }

    const donationsFiltered = allDonations.filter((d) => d.hours <= hours);
    const totalFiltered = donationsFiltered.reduce((s, d) => s + d.soTien, 0);

    return {
      streamer: streamerName,
      url,
      hours,
      thoiGianCao: new Date().toLocaleString("vi-VN"),
      bangXepHangNgay: {
        top: dayRanking,
        tong: dayTotal,
      },
      donateFiltered: {
        soLuong: donationsFiltered.length,
        tongTien: totalFiltered,
        danhSach: donationsFiltered.map((d) => ({
          nguoiGui: d.nguoiGui,
          thoiGian: d.thoiGian,
          soTien: d.soTien,
        })),
      },
    };
  } finally {
    await browser.close();
  }
}

app.post("/api/scrape", async (req, res) => {
  const { url, hours } = req.body;
  if (!url || !url.includes("zypage.com")) {
    return res.status(400).json({ error: "Vui long nhap link ZyPage hop le" });
  }
  const h = Math.max(1, Math.min(720, parseInt(hours, 10) || 24));
  const position = queue.length + 1;
  try {
    const data = await enqueue(url, h);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Loi khi cao du lieu: " + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server dang chay tai http://localhost:${PORT}`);
});
