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
import type { BatchDownloadResult } from './types.js';
import { PDFDownloadError } from './errors.js';
import { GooglePatentsScraper, getSystemProxy } from './scraper.js';

/**
 * Download PDFs from Google Patents.
 *
 * Usage:
 * ```ts
 * const downloader = new PDFDownloader('./patent_pdfs');
 * await downloader.downloadSingle('US11452699B2');
 * await downloader.downloadBatch(['US2668287A', 'US11452699B2']);
 * ```
 */
export class PDFDownloader {
  private outputDir: string;
  private scraper: GooglePatentsScraper;
  private maxWorkers: number;

  constructor(
    outputDir: string = './patent_pdfs',
    scraper?: GooglePatentsScraper,
    maxWorkers: number = 4
  ) {
    this.outputDir = outputDir;
    this.scraper = scraper ?? new GooglePatentsScraper(false, false);
    this.maxWorkers = maxWorkers;
  }

  /**
   * Ensure output directory exists
   */
  private async ensureOutputDir(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
  }

  /**
   * Get PDF URL from Google Patents page.
   */
  private async getPdfUrl(patentNumber: string): Promise<string> {
    const [err, soup, _url] = await this.scraper.requestSinglePatent(patentNumber);
    if (err !== 'Success') {
      throw new PDFDownloadError(`Failed to fetch patent ${patentNumber}: ${err}`);
    }
    if (!soup) {
      throw new PDFDownloadError(`Failed to parse HTML for patent ${patentNumber}`);
    }
    const data = this.scraper.processPatentHtml(soup);
    const pdfUrl = data.pdf_url ?? '';
    if (!pdfUrl) {
      throw new PDFDownloadError(`No PDF URL found for patent ${patentNumber}`);
    }
    return pdfUrl;
  }

  /**
   * Download a file with progress display.
   */
  private async downloadFile(
    url: string,
    outputPath: string,
    label: string = ''
  ): Promise<string> {
    try {
      const { chunks, totalSize } = await this.fetchBinary(url, label);
      const desc = label || basename(outputPath);

      this.clearLine();
      globalThis.process.stdout.write(`  ✓ ${desc}\n`);

      const buffer = Buffer.concat(chunks);
      await writeFile(outputPath, buffer);
      return outputPath;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      throw new PDFDownloadError(`Failed to download ${label}: ${error.message}`);
    }
  }

  private async fetchBinary(url: string, label: string = ''): Promise<{ chunks: Uint8Array[]; totalSize: number }> {
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    const proxy = getSystemProxy();

    if (!proxy) {
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      return { chunks: [new Uint8Array(buf)], totalSize: buf.byteLength };
    }

    const target = new URL(url);
    return new Promise((resolve, reject) => {
      const connectReq = http.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${target.hostname}:443`,
      });

      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
          return;
        }

        const req = https.request({
          socket,
          hostname: target.hostname,
          path: target.pathname + target.search,
          method: 'GET',
          headers,
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
              globalThis.process.stdout.write(`\r  ${label || 'download'}: ${pct}% (${this.formatBytes(downloaded)}/${this.formatBytes(totalSize)})`);
            }
          });
          httpsRes.on('end', () => resolve({ chunks, totalSize }));
        });

        req.on('error', reject);
        req.end();
      });

      connectReq.on('error', reject);
      connectReq.setTimeout(30000, () => connectReq.destroy(new Error('Proxy CONNECT timeout')));
      connectReq.end();
    });
  }

  /**
   * Format bytes to human readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
  }

  /**
   * Clear the current line in stdout
   */
  private clearLine(): void {
    globalThis.process.stdout.write('\r\x1b[K');
  }

  /**
   * Download a single patent PDF.
   *
   * @param patentNumber - Patent number (e.g., 'US11452699B2')
   * @param outputPath - Optional full output path. If undefined, uses {output_dir}/{patent_number}.pdf
   * @returns Path to downloaded PDF file
   */
  async downloadSingle(patentNumber: string, outputPath?: string): Promise<string> {
    await this.ensureOutputDir();

    const resolvedPath = outputPath ?? join(this.outputDir, `${patentNumber}.pdf`);

    // Skip if already exists
    try {
      await access(resolvedPath);
      globalThis.process.stdout.write(`  ⏭️  ${patentNumber}.pdf already exists, skipping\n`);
      return resolvedPath;
    } catch {
      // File doesn't exist, proceed with download
    }

    const pdfUrl = await this.getPdfUrl(patentNumber);
    return await this.downloadFile(pdfUrl, resolvedPath, patentNumber);
  }

  /**
   * Download PDFs for multiple patents with concurrency limit.
   *
   * @param patentNumbers - List of patent numbers
   * @returns Dictionary mapping patent numbers to output paths or error messages
   */
  async downloadBatch(patentNumbers: string[]): Promise<BatchDownloadResult> {
    const results: BatchDownloadResult = {};
    globalThis.process.stdout.write(`📥 Downloading ${patentNumbers.length} PDFs...\n`);

    // Process in batches to respect maxWorkers
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
        })
      );

      for (const settledResult of batchResults) {
        if (settledResult.status === 'fulfilled') {
          const { patentNumber, result, error } = settledResult.value;
          if (error) {
            results[patentNumber] = error;
            globalThis.process.stdout.write(`  ❌ ${patentNumber}: ${error}\n`);
          } else {
            results[patentNumber] = result!;
            globalThis.process.stdout.write(`  ✅ ${patentNumber} → ${result}\n`);
          }
          } else {
            const error = settledResult.reason instanceof Error ? settledResult.reason.message : String(settledResult.reason);
            globalThis.process.stdout.write(`  ❌ Error: ${error}\n`);
          }
      }
    }

    return results;
  }

  /**
   * Download PDF for a patent and optionally its family members.
   *
   * Note: Family member PDFs require separate scraping of each member.
   * This method downloads the main patent PDF.
   *
   * @param patentNumber - Patent number
   * @param outputDir - Optional subdirectory for family PDFs
   * @returns Path to downloaded PDF file
   */
  async downloadFamily(patentNumber: string, outputDir?: string): Promise<string> {
    const resolvedDir = outputDir ?? join(this.outputDir, `${patentNumber}_family`);
    await mkdir(resolvedDir, { recursive: true });

    const outputPath = join(resolvedDir, `${patentNumber}.pdf`);
    return await this.downloadSingle(patentNumber, outputPath);
  }
}

/**
 * Convenience function to quickly download a single patent PDF.
 *
 * @param patentNumber - Patent number
 * @param scraper - GooglePatentsScraper instance
 * @param outputDir - Output directory (default: './patent_pdfs')
 * @returns Path to downloaded PDF file
 */
export async function downloadPdf(
  patentNumber: string,
  outputDir: string = './patent_pdfs'
): Promise<string> {
  const downloader = new PDFDownloader(outputDir);
  return await downloader.downloadSingle(patentNumber);
}