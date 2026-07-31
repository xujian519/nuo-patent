#!/usr/bin/env node
/**
 * nuo-patent CLI — 专利工具命令行接口
 *
 * 所有输出为 JSON 格式（stdout），错误输出到 stderr。
 * 任何语言编写的智能体均可通过 subprocess 调用。
 *
 * @example
 * ```bash
 * nuo-patent scrape US11452699B2
 * nuo-patent scrape US11452699B2 --timeout 15000 --no-legal
 * nuo-patent validate "US 11452699 B2"
 * nuo-patent download US11452699B2 US2668287A --output ./pdfs
 * nuo-patent legal-status US11452699B2 US2668287A --max-concurrency 4
 * ```
 */

import {
  scrapePatent,
  validatePatentNumber,
} from './scraper.js';
import { PDFDownloader } from './pdf-downloader.js';
import { LegalStatusChecker } from './legal-status.js';
import type { ScrapeOptions } from './types.js';

// ---------------------------------------------------------------------------
// 帮助信息
// ---------------------------------------------------------------------------

const HELP = `nuo-patent v2.2.0 · 小诺智能体专利工具包 CLI

用法:
  nuo-patent <command> [options]

命令:
  scrape <patent>         抓取专利元数据，输出 ScrapeResult JSON
  validate <patent>       校验并规范化专利号
  download <patent...>    下载 PDF，输出 DownloadResult[] JSON
  legal-status <patent...> 查询法律状态，输出 JSON

选项（scrape）:
  --timeout <ms>          请求超时毫秒数（默认 30000）
  --no-abstract           不提取摘要
  --no-legal              不提取法律状态

选项（download）:
  --output <dir>          输出目录（默认 ./patent_pdfs）
  --max-workers <n>       最大并发数（默认 4）

选项（legal-status）:
  --max-concurrency <n>   最大并发数（默认 4）

通用:
  --pretty                格式化 JSON 输出
  --help, -h              显示此帮助

示例:
  nuo-patent scrape US11452699B2 --pretty
  nuo-patent validate "US 11452699 B2"
  nuo-patent download CN201559953U CN220010945U --output /tmp/pdfs
  nuo-patent legal-status US11452699B2 US2668287A

退出码:
  0  成功
  1  调用失败（详情见 stderr 或返回 JSON 中的 error 字段）
`;

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | number>;
  pretty: boolean;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = '';
  let pretty = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    }

    if (arg === '--pretty') {
      pretty = true;
      i++;
      continue;
    }

    if (arg.startsWith('--')) {
      const key = arg.slice(2);

      // --no-xxx 形式始终是 boolean false，不消耗下一个参数
      if (key.startsWith('no-')) {
        flags[key.slice(3)] = false;
        i++;
        continue;
      }

      // 检查下一个参数是否是值（非 -- 开头）
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        const nextVal = argv[i + 1];
        const num = Number(nextVal);
        (flags as Record<string, unknown>)[key] = isNaN(num) ? nextVal : num;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
      continue;
    }

    if (!command) {
      command = arg;
      i++;
      continue;
    }

    positional.push(arg);
    i++;
  }

  return { command, positional, flags, pretty };
}

// ---------------------------------------------------------------------------
// 输出工具
// ---------------------------------------------------------------------------

function output(data: unknown, pretty: boolean): void {
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  process.stdout.write(json + '\n');
}

function die(message: string, code: number = 1): never {
  process.stderr.write(`[nuo-patent] ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// 子命令处理
// ---------------------------------------------------------------------------

async function cmdScrape(args: ReturnType<typeof parseArgs>): Promise<void> {
  if (args.positional.length === 0) {
    die('scrape 需要 1 个专利号参数', 1);
  }

  const patentNumber = args.positional[0];
  const options: ScrapeOptions = {};

  if (typeof args.flags['timeout'] === 'number') {
    options.timeout = args.flags['timeout'];
  }
  if (args.flags['abstract'] === false) {
    options.returnAbstract = false;
  }
  if (args.flags['legal'] === false) {
    options.returnLegal = false;
  }

  const result = await scrapePatent(patentNumber, options);
  output(result, args.pretty);

  if (!result.success) {
    process.exit(1);
  }
}

async function cmdValidate(args: ReturnType<typeof parseArgs>): Promise<void> {
  if (args.positional.length === 0) {
    die('validate 需要 1 个专利号参数', 1);
  }

  const result = validatePatentNumber(args.positional[0]);
  output(result, args.pretty);

  if (!result.valid) {
    process.exit(1);
  }
}

async function cmdDownload(args: ReturnType<typeof parseArgs>): Promise<void> {
  if (args.positional.length === 0) {
    die('download 需要至少 1 个专利号参数', 1);
  }

  const outputDir = typeof args.flags['output'] === 'string'
    ? args.flags['output']
    : './patent_pdfs';

  const maxWorkers = typeof args.flags['max-workers'] === 'number'
    ? args.flags['max-workers']
    : 4;

  const downloader = new PDFDownloader(outputDir, undefined, maxWorkers);
  const results = await downloader.downloadBatchWithResults(args.positional, {
    maxWorkers,
  });

  output(results, args.pretty);

  const hasFailure = results.some(r => !r.success);
  if (hasFailure) {
    process.exit(1);
  }
}

async function cmdLegalStatus(args: ReturnType<typeof parseArgs>): Promise<void> {
  if (args.positional.length === 0) {
    die('legal-status 需要至少 1 个专利号参数', 1);
  }

  const maxConcurrency = typeof args.flags['max-concurrency'] === 'number'
    ? args.flags['max-concurrency']
    : 4;

  const checker = new LegalStatusChecker();
  const results = await checker.checkBatch(args.positional, { maxConcurrency });

  output(results, args.pretty);

  const hasError = Object.values(results).some(r => r.error);
  if (hasError) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 将 console.log 重定向到 stderr，确保 stdout 是洁净的 JSON
  // （scraper 等模块内部使用 console.log 输出调试信息）
  console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');

  // 跳过 node 和脚本路径，只取参数
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const args = parseArgs(rawArgs);

  switch (args.command) {
    case 'scrape':
      return await cmdScrape(args);
    case 'validate':
      return await cmdValidate(args);
    case 'download':
      return await cmdDownload(args);
    case 'legal-status':
      return await cmdLegalStatus(args);
    default:
      die(`未知命令: ${args.command}\n使用 --help 查看可用命令`, 1);
  }
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err), 1);
});
