/**
 * nuo-patent · PDF 批量下载引擎
 *
 * 参考 wenyalintw/Google-Patents-Scraper 方案：
 * - 从 meta[name=citation_pdf_url] 提取 PDF URL
 * - 流式下载 + 进度显示
 * - 单专利 / 批量并发 / 家族 PDF 下载
 */

import { mkdir, access, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import type {
  BatchDownloadResult,
  DownloadResult,
  DownloadOptions,
  Logger,
} from './types.js';
import { noopLogger } from './types.js';
import { PDFDownloadError } from './errors.js';
import { GooglePatentsScraper, getSystemProxy } from './scraper.js';

/**
 * Download PDFs from Google Patents.
 *
 * Usage:
 * ```ts
 * const downloader = new PDFDownloader('./patent_pdfs');
 * await downloader.downloadSingle('US11452699B2');
 *
 * // 批量下载，获得结构化结果
 * const results = await downloader.downloadBatchWithResults(
 *   ['US2668287A', 'US11452699B2'],
 *   { signal: abortController.signal }
 * );
 * for (const r of results) {
 *   if (r.success) console.log(`✅ ${r.path}`);
 *   else console.error(`❌ ${r.patentNumber}: ${r.error}`);
 * }
 * ```
 */
export class PDFDownloader {
  private outputDir: string;
  private scraper: GooglePatentsScraper;
  private maxWorkers: number;

  constructor(
    outputDir: string = './patent_pdfs',
    scraper?: GooglePatentsScraper,
    maxWorkers: number = 4,
  ) {
    this.outputDir = outputDir;
    this.scraper = scraper ?? new GooglePatentsScraper(false, false);
    this.maxWorkers = maxWorkers;
  }

  /**
   * 确保输出目录存在。
   */
  private async ensureOutputDir(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
  }

  /**
   * 获取专利 PDF URL。
   */
  private async getPdfUrl(patentNumber: string): Promise<string> {
    const [err, soup, _url] = await this.scraper.requestSinglePatent(patentNumber);
    if (err !== 'Success') {
      throw new PDFDownloadError(
        `获取专利 ${patentNumber} 页面失败: ${err}`,
        patentNumber,
      );
    }
    if (!soup) {
      throw new PDFDownloadError(
        `解析专利 ${patentNumber} HTML 失败`,
        patentNumber,
      );
    }
    const data = this.scraper.processPatentHtml(soup);
    const pdfUrl = data.pdf_url ?? '';
    if (!pdfUrl) {
      throw new PDFDownloadError(
        `未找到专利 ${patentNumber} 的 PDF URL`,
        patentNumber,
      );
    }
    return pdfUrl;
  }

  /**
   * 流式下载文件（带进度和取消支持）。
   */
  private async downloadFile(
    url: string,
    outputPath: string,
    label: string = '',
    signal?: AbortSignal,
    logger: Logger = noopLogger,
  ): Promise<string> {
    try {
      const desc = label || basename(outputPath);
      logger.info(`开始下载: ${desc}`);

      const { chunks } = await this.fetchBinary(url, label, signal, logger);

      logger.info(`下载完成: ${desc}`);
      const buffer = Buffer.concat(chunks);
      await writeFile(outputPath, buffer);
      return outputPath;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      throw new PDFDownloadError(
        `下载失败 ${label}: ${error.message}`,
        label,
      );
    }
  }

  private async fetchBinary(
    url: string,
    label: string = '',
    signal?: AbortSignal,
    logger: Logger = noopLogger,
  ): Promise<{ chunks: Uint8Array[]; totalSize: number }> {
    const requestHeaders: Record<string, string> = { 'User-Agent': 'Mozilla/5.0' };
    const proxy = getSystemProxy();

    // 直连路径
    if (!proxy) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), 60000);

      if (signal) {
        signal.addEventListener('abort', () => controller.abort(signal.reason));
      }

      try {
        const resp = await fetch(url, {
          headers: requestHeaders,
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        return { chunks: [new Uint8Array(buf)], totalSize: buf.byteLength };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // 代理隧道路径
    const target = new URL(url);
    return new Promise((resolve, reject) => {
      const connectReq = http.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${target.hostname}:443`,
      });

      const proxyTimer = setTimeout(() => {
        connectReq.destroy(new Error('Proxy CONNECT timeout'));
      }, 35000);

      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(proxyTimer);
          connectReq.destroy(new Error('Request aborted'));
        });
      }

      connectReq.on('connect', (res, socket) => {
        clearTimeout(proxyTimer);

        if (res.statusCode !== 200) {
          reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
          return;
        }

        const req = https.request({
          socket,
          hostname: target.hostname,
          path: target.pathname + target.search,
          method: 'GET',
          headers: requestHeaders,
        } as https.RequestOptions, (httpsRes) => {
          if (httpsRes.statusCode && httpsRes.statusCode >= 400) {
            reject(new Error(`HTTP ${httpsRes.statusCode}`));
            return;
          }

          const totalSize = Number(httpsRes.headers['content-length'] ?? 0);
          const chunks: Uint8Array[] = [];
          let downloaded = 0;

          httpsRes.on('data', (chunk: Buffer) => {
            chunks.push(new Uint8Array(chunk));
            downloaded += chunk.length;
            if (totalSize > 0) {
              const pct = Math.round((downloaded / totalSize) * 100);
              logger.debug(`${label}: ${pct}% (${this.formatBytes(downloaded)}/${this.formatBytes(totalSize)})`);
            }
          });
          httpsRes.on('end', () => resolve({ chunks, totalSize }));
        });

        req.on('error', reject);
        req.end();
      });

      connectReq.on('error', (err) => {
        clearTimeout(proxyTimer);
        reject(err);
      });
      connectReq.end();
    });
  }

  /**
   * 格式化字节为人类可读字符串。
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
  }

  /**
   * 下载单个专利 PDF。
   *
   * @param patentNumber - 专利号（如 'US11452699B2'）
   * @param outputPath - 可选完整输出路径；默认 `{outputDir}/{patentNumber}.pdf`
   * @param signal - 可选的 AbortSignal 用于取消下载
   * @param logger - 可选日志接口
   * @returns 下载后的 PDF 文件路径
   */
  async downloadSingle(
    patentNumber: string,
    outputPath?: string,
    signal?: AbortSignal,
    logger: Logger = noopLogger,
  ): Promise<string> {
    await this.ensureOutputDir();

    const resolvedPath = outputPath ?? join(this.outputDir, `${patentNumber}.pdf`);

    // 已存在则跳过
    try {
      await access(resolvedPath);
      logger.info(`${patentNumber}.pdf 已存在，跳过`);
      return resolvedPath;
    } catch {
      // 文件不存在，继续下载
    }

    const pdfUrl = await this.getPdfUrl(patentNumber);
    return await this.downloadFile(pdfUrl, resolvedPath, patentNumber, signal, logger);
  }

  /**
   * 批量下载 PDF（返回结构化结果，推荐智能体使用）。
   *
   * @param patentNumbers - 专利号列表
   * @param options - 下载选项（signal, logger, maxWorkers）
   * @returns 每个专利的 DownloadResult 数组，不抛异常
   */
  async downloadBatchWithResults(
    patentNumbers: string[],
    options: DownloadOptions = {},
  ): Promise<DownloadResult[]> {
    const { signal, logger = noopLogger, maxWorkers = this.maxWorkers } = options;
    const results: DownloadResult[] = [];

    logger.info(`开始批量下载 ${patentNumbers.length} 篇专利 PDF`);

    for (let i = 0; i < patentNumbers.length; i += maxWorkers) {
      // 响应取消信号
      if (signal?.aborted) {
        const remaining = patentNumbers.slice(i);
        for (const pn of remaining) {
          results.push({
            patentNumber: pn,
            success: false,
            error: '请求已被取消',
          });
        }
        break;
      }

      const batch = patentNumbers.slice(i, i + maxWorkers);
      const batchResults = await Promise.allSettled(
        batch.map(async (pn): Promise<DownloadResult> => {
          try {
            const filePath = await this.downloadSingle(pn, undefined, signal, logger);
            return { patentNumber: pn, success: true, path: filePath };
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            logger.warn(`${pn} 下载失败: ${error}`);
            return { patentNumber: pn, success: false, error };
          }
        }),
      );

      for (const settled of batchResults) {
        if (settled.status === 'fulfilled') {
          results.push(settled.value);
        } else {
          const error = settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason);
          // 无法确定专利号，使用 batch index 估计
          results.push({ patentNumber: '(unknown)', success: false, error });
        }
      }
    }

    const succeeded = results.filter(r => r.success).length;
    logger.info(`批量下载完成: ${succeeded}/${results.length} 成功`);
    return results;
  }

  /**
   * 批量下载 PDF（返回 Record，保留向后兼容）。
   *
   * @deprecated 推荐使用 `downloadBatchWithResults()` 获得结构化结果。
   */
  async downloadBatch(patentNumbers: string[]): Promise<BatchDownloadResult> {
    const results: BatchDownloadResult = {};

    for (let i = 0; i < patentNumbers.length; i += this.maxWorkers) {
      const batch = patentNumbers.slice(i, i + this.maxWorkers);
      const batchResults = await Promise.allSettled(
        batch.map(async (pn) => {
          try {
            const filePath = await this.downloadSingle(pn);
            return { patentNumber: pn, result: filePath, error: null };
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { patentNumber: pn, result: null, error };
          }
        }),
      );

      for (const settledResult of batchResults) {
        if (settledResult.status === 'fulfilled') {
          const { patentNumber, result, error } = settledResult.value;
          if (error) {
            results[patentNumber] = error;
          } else {
            results[patentNumber] = result!;
          }
        }
      }
    }

    return results;
  }

  /**
   * 下载专利及其家族成员的 PDF。
   *
   * @param patentNumber - 专利号
   * @param outputDir - 可选子目录
   * @returns 下载后的 PDF 文件路径
   */
  async downloadFamily(patentNumber: string, outputDir?: string): Promise<string> {
    const resolvedDir = outputDir ?? join(this.outputDir, `${patentNumber}_family`);
    await mkdir(resolvedDir, { recursive: true });

    const outputPath = join(resolvedDir, `${patentNumber}.pdf`);
    return await this.downloadSingle(patentNumber, outputPath);
  }
}

/**
 * 便捷函数：快速下载单个专利 PDF。
 *
 * @param patentNumber - 专利号
 * @param outputDir - 输出目录（默认 './patent_pdfs'）
 * @returns 下载后的 PDF 文件路径
 */
export async function downloadPdf(
  patentNumber: string,
  outputDir: string = './patent_pdfs',
): Promise<string> {
  const downloader = new PDFDownloader(outputDir);
  return await downloader.downloadSingle(patentNumber);
}
