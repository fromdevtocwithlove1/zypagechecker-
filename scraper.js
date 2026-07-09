const { chromium } = require("playwright");
const fs = require("fs");

const formatVND = (n) => n.toLocaleString("vi-VN") + "đ";

function parseAmount(str) {
  const cleaned = str.replace(/[^\d]/g, "");
  return parseInt(cleaned, 10) || 0;
}

function extractRankingFromText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const amountMatch = lines[i].match(/^([\d,.]+)đ$/);
    if (amountMatch && i > 0) {
      let name = lines[i - 1];
      if (name.match(/^#\d+$/)) name = lines[i - 2] || name;
      results.push({ name, amount: parseAmount(amountMatch[1]) });
    }
  }
  return results;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log("Dang mo trang web https://zypage.com/sbcb5van ...\n");
  await page.goto("https://zypage.com/sbcb5van", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(5000);

  const getRankingSection = async () => {
    return page.evaluate(() => {
      const section = document.querySelector(".top_wall");
      if (!section) {
        const titles = document.querySelectorAll(".menu_title");
        for (const t of titles) {
          if (t.innerText.includes("BẢNG XẾP HẠNG")) {
            let el = t.parentElement;
            return el?.innerText || "";
          }
        }
        return "";
      }
      return section.innerText;
    });
  };

  const clickTab = async (tabName) => {
    const btn = page.locator("button.top_wall_tab_btn", { hasText: tabName });
    await btn.click();
    await page.waitForTimeout(3000);
  };

  await clickTab("Ngày");
  const dayText = await getRankingSection();
  const dayRanking = extractRankingFromText(dayText);
  const dayTotal = dayRanking.reduce((s, r) => s + r.amount, 0);

  await clickTab("Tháng");
  const monthText = await getRankingSection();
  const monthRanking = extractRankingFromText(monthText);
  const monthTotal = monthRanking.reduce((s, r) => s + r.amount, 0);

  await clickTab("Tổng");
  const totalText = await getRankingSection();
  const totalRanking = extractRankingFromText(totalText);
  const allTimeTotal = totalRanking.reduce((s, r) => s + r.amount, 0);

  const recentSection = page.locator("text=GẦN ĐÂY").first();
  await recentSection.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);

  let prevCount = 0;
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    const curCount = await page.evaluate(() => {
      const text = document.body.innerText;
      return (text.match(/Donate\s+[\d,.]+đ/g) || []).length;
    });
    if (curCount === prevCount && i > 3) break;
    prevCount = curCount;
  }

  const allText = await page.evaluate(() => document.body.innerText);
  const recentParts = allText.split("GẦN ĐÂY");
  const recentText = recentParts.length > 1 ? recentParts[1] : allText;

  const donateDetailRegex = /(.+?)\n(\d+\s+(?:giờ|phút|giây|ngày)\s+trước)\nDonate\s+([\d,.]+)đ(?:\s+với lời nhắn)?/g;
  let m;
  const donations = [];
  while ((m = donateDetailRegex.exec(recentText)) !== null) {
    donations.push({
      nguoiGui: m[1].trim(),
      thoiGian: m[2].trim(),
      soTien: parseAmount(m[3]),
    });
  }

  const donateSimpleRegex = /Donate\s+([\d,.]+)đ/g;
  const allDonateAmounts = [];
  while ((m = donateSimpleRegex.exec(recentText)) !== null) {
    allDonateAmounts.push(parseAmount(m[1]));
  }
  const totalDonateRecent = allDonateAmounts.reduce((s, a) => s + a, 0);

  const result = {
    streamer: "SBCB 5van",
    url: "https://zypage.com/sbcb5van",
    thoiGianCao: new Date().toLocaleString("vi-VN"),
    bangXepHang: {
      ngay: { topDonators: dayRanking, tongTop: dayTotal, tongTopFormatted: formatVND(dayTotal) },
      thang: { topDonators: monthRanking, tongTop: monthTotal, tongTopFormatted: formatVND(monthTotal) },
      tong: { topDonators: totalRanking, tongTop: allTimeTotal, tongTopFormatted: formatVND(allTimeTotal) },
    },
    donateGanDay: {
      soLuong: allDonateAmounts.length,
      tongTien: totalDonateRecent,
      tongTienFormatted: formatVND(totalDonateRecent),
      trungBinhMoiDonate: allDonateAmounts.length > 0 ? formatVND(Math.round(totalDonateRecent / allDonateAmounts.length)) : "0đ",
      chiTiet: donations,
    },
  };

  console.log("╔════════════════════════════════════════════╗");
  console.log("║     THU NHAP STREAMER: SBCB 5van          ║");
  console.log("╚════════════════════════════════════════════╝\n");

  console.log("┌─── BANG XEP HANG NGAY ───");
  if (dayRanking.length > 0) {
    dayRanking.forEach((r, i) => console.log(`│ #${i + 1} ${r.name}: ${formatVND(r.amount)}`));
    console.log(`│ => TONG: ${formatVND(dayTotal)}`);
  } else {
    console.log("│ Khong co du lieu (chua co donate hom nay)");
  }

  console.log("├─── BANG XEP HANG THANG ───");
  if (monthRanking.length > 0) {
    monthRanking.forEach((r, i) => console.log(`│ #${i + 1} ${r.name}: ${formatVND(r.amount)}`));
    console.log(`│ => TONG: ${formatVND(monthTotal)}`);
  } else {
    console.log("│ Khong co du lieu");
  }

  console.log("├─── BANG XEP HANG TONG ───");
  if (totalRanking.length > 0) {
    totalRanking.forEach((r, i) => console.log(`│ #${i + 1} ${r.name}: ${formatVND(r.amount)}`));
    console.log(`│ => TONG: ${formatVND(allTimeTotal)}`);
  } else {
    console.log("│ Khong co du lieu");
  }

  console.log("├─── DONATE GAN DAY ───");
  console.log(`│ So luong: ${allDonateAmounts.length}`);
  console.log(`│ Tong tien: ${formatVND(totalDonateRecent)}`);
  console.log(`│ TB moi donate: ${result.donateGanDay.trungBinhMoiDonate}`);

  if (donations.length > 0) {
    console.log("│");
    console.log("│ 10 donate gan nhat:");
    donations.slice(0, 10).forEach((d, i) => {
      console.log(`│  ${i + 1}. ${d.nguoiGui} - ${formatVND(d.soTien)} (${d.thoiGian})`);
    });
  }

  console.log("└──────────────────────────\n");

  console.log("╔════════════════════════════════════════════╗");
  console.log("║         UOC TINH THU NHAP 1 NGAY          ║");
  console.log("╠════════════════════════════════════════════╣");
  if (dayTotal > 0) {
    console.log(`║  Bang xep hang ngay (top donators): ${formatVND(dayTotal)}`);
  }
  console.log(`║  Donate gan day (${allDonateAmounts.length} donate): ${formatVND(totalDonateRecent)}`);
  if (allDonateAmounts.length > 0) {
    console.log(`║  Trung binh moi donate: ${result.donateGanDay.trungBinhMoiDonate}`);
  }
  const estimated = dayTotal > 0 ? dayTotal : totalDonateRecent;
  console.log(`║  => UOC TINH: ~${formatVND(estimated)}/ngay`);
  console.log("╚════════════════════════════════════════════╝\n");

  fs.writeFileSync("result.json", JSON.stringify(result, null, 2), "utf-8");
  console.log("Da luu ket qua vao: result.json");

  await browser.close();
})();
