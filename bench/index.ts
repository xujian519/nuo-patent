/**
 * nuo-patent · Python vs TypeScript 性能基准测试
 *
 * 对比抓取同一专利的耗时：
 * 1. Python 版本（子进程调用）
 * 2. TypeScript 版本（原生 Node fetch + cheerio）
 *
 * 测试专利: US11452699B2
 *
 * 用法: node --import tsx bench/index.ts
 */

import { GooglePatentsScraper } from '../src/index.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PATENT = 'US11452699B2';
const ROUNDS = 5;

async function benchTypeScript(): Promise<number[]> {
  const times: number[] = [];
  const scraper = new GooglePatentsScraper(false, true);

  for (let i = 0; i < ROUNDS; i++) {
    const start = performance.now();
    const [status, $] = await scraper.requestSinglePatent(PATENT);
    const elapsed = performance.now() - start;

    if (status === 'Success' && $) {
      const data = scraper.processPatentHtml($);
      console.log(`  [TS]   Round ${i + 1}: ${elapsed.toFixed(0)}ms — ${data.title?.slice(0, 40)}`);
    } else {
      console.log(`  [TS]   Round ${i + 1}: ${elapsed.toFixed(0)}ms — FAILED: ${status}`);
    }
    times.push(elapsed);
  }

  return times;
}

async function benchPython(): Promise<number[]> {
  const times: number[] = [];
  const script = `
import time, sys
sys.path.insert(0, '${process.cwd().replace(/ts-src$/, '')}')
from nuo_patent import GooglePatentsScraper
scraper = GooglePatentsScraper(return_abstract=False, return_legal=True)
start = time.perf_counter()
err, soup, url = scraper.request_single_patent('${PATENT}')
elapsed = (time.perf_counter() - start) * 1000
if err == 'Success':
    data = scraper.process_patent_html(soup)
    title = data.get('title', '')[:40]
    print(f'OK|{elapsed:.0f}|{title}')
else:
    print(f'ERR|{elapsed:.0f}|{err}')
`;

  for (let i = 0; i < ROUNDS; i++) {
    const start = performance.now();
    try {
      const { stdout } = await execFileAsync('python3', ['-c', script], {
        timeout: 30000,
        cwd: process.cwd().replace(/\/ts-src$/, ''),
      });
      const elapsed = performance.now() - start;
      const parts = stdout.trim().split('|');
      const status = parts[0];
      const pyElapsed = parts[1] || '?';
      const detail = parts.slice(2).join('|') || '';

      console.log(`  [PY]   Round ${i + 1}: ${elapsed.toFixed(0)}ms (Python内部: ${pyElapsed}ms) — ${status === 'OK' ? detail : 'FAILED'}`);
      times.push(elapsed);
    } catch (err) {
      const elapsed = performance.now() - start;
      console.log(`  [PY]   Round ${i + 1}: ${elapsed.toFixed(0)}ms — ERROR: ${err}`);
      times.push(elapsed);
    }
  }

  return times;
}

function stats(times: number[]) {
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return { avg, min, max };
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  nuo-patent 性能基准测试`);
  console.log(`  专利号: ${PATENT} | 轮次: ${ROUNDS}`);
  console.log(`${'='.repeat(60)}\n`);

  console.log('--- TypeScript (Node fetch + cheerio) ---');
  const tsTimes = await benchTypeScript();
  const tsStats = stats(tsTimes);

  console.log('\n--- Python (urllib + BeautifulSoup) ---');
  const pyTimes = await benchPython();
  const pyStats = stats(pyTimes);

  console.log(`\n${'='.repeat(60)}`);
  console.log('  结果汇总');
  console.log(`${'='.repeat(60)}`);
  console.log(`  TypeScript: 平均 ${tsStats.avg.toFixed(0)}ms | 最快 ${tsStats.min.toFixed(0)}ms | 最慢 ${tsStats.max.toFixed(0)}ms`);
  console.log(`  Python:     平均 ${pyStats.avg.toFixed(0)}ms | 最快 ${pyStats.min.toFixed(0)}ms | 最慢 ${pyStats.max.toFixed(0)}ms`);

  const ratio = pyStats.avg / tsStats.avg;
  if (ratio > 1) {
    console.log(`\n  🏆 TypeScript 比 Python 快 ${ratio.toFixed(2)}x`);
  } else {
    console.log(`\n  🏆 Python 比 TypeScript 快 ${(1 / ratio).toFixed(2)}x`);
  }
  console.log();
}

main().catch(console.error);
