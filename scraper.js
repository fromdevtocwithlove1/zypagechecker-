const fs = require("fs/promises");
const path = require("path");
const { scrapeZypage } = require("./server");

const url = process.argv[2] || "https://zypage.com/sbcb5van";
const hours = Math.max(1, Math.min(720, parseInt(process.argv[3], 10) || 24));

async function main() {
  console.log(`Dang cao ${hours} gio du lieu tu ${url}`);
  const result = await scrapeZypage(url, hours);
  const outputPath = path.join(__dirname, "result.json");
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`Da luu ${result.donateFiltered.soLuong} donate (${result.source}${result.partial ? ", partial" : ""}) vao ${outputPath}`);
}

main().catch((error) => {
  console.error(`Loi khi cao du lieu: ${error.message}`);
  process.exitCode = 1;
});
