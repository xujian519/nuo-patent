/**
 * 使用 nuo-patent 包从 Google Patents 下载专利 PDF
 */
import { PDFDownloader } from "/Users/xujian/projects/nuo-patent/dist/index.js";

const OUTPUT_DIR = "/Users/xujian/工作/01_专利申请/新华医疗/重载辊筒转台输送机专利交底书/downloads";

const patents = [
  "CN201559953U",
  "CN220010945U", 
  "CN107217892B",
  "CN115092589B",
  "MX2020003829A",
];

async function main() {
  const downloader = new PDFDownloader(OUTPUT_DIR);
  
  console.log(`正在下载 ${patents.length} 篇专利...\n`);
  
  const results = await downloader.downloadBatch(patents);
  
  console.log("\n=== 下载结果汇总 ===");
  for (const [pn, result] of Object.entries(results)) {
    if (result.startsWith("/") || result.startsWith(".")) {
      console.log(`✅ ${pn}: ${result}`);
    } else {
      console.log(`❌ ${pn}: ${result}`);
    }
  }
}

main().catch(console.error);
