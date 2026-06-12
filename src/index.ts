/**
 * nuo-patent · 小诺智能体专利工具包 (TypeScript 版本)
 *
 * 功能：
 * - Google Patents 元数据抓取（标题、发明人、受让人、引证等）
 * - PDF 批量下载（含进度反馈、并发下载）
 * - 法律状态查询（Active/Expired、预估到期日）
 * - CNIPA 中国专利查询（法律状态、详情、PDF）
 */

export { GooglePatentsScraper, scraper_class, fetchHtml, getSystemProxy, parseCitationElement, extractCitations, extractEvents, extractLegalStatus, extractClassifications } from './scraper.js';
export type { ProxyConfig } from './scraper.js';
export { PDFDownloader, downloadPdf } from './pdf-downloader.js';
export { LegalStatusChecker } from './legal-status.js';
export { CNIPAClient } from './cnipa-client.js';
export {
  NuoPatentError,
  PatentClassError,
  NoPatentsError,
  PDFDownloadError,
  CNIPAQueryError,
} from './errors.js';
export type {
  Citation,
  TimelineEvent,
  LegalStatus,
  PatentData,
  LegalStatusResult,
  PatentDetail,
  TransactionRecord,
  SearchResult,
  AnnuityStatus,
  BatchDownloadResult,
} from './types.js';

export const VERSION = '2.1.0';
export const AUTHOR = '小诺团队 · Xiaonuo Team';
export const LICENSE = 'MIT';
