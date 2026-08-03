/**
 * nuo-patent · 小诺智能体专利工具包 (TypeScript 版本)
 *
 * 功能：
 * - Google Patents 元数据抓取（标题、发明人、受让人、引证等）
 * - PDF 批量下载（含进度反馈、并发下载）
 * - 法律状态查询（Active/Expired、预估到期日）
 * - CNIPA 中国专利查询（法律状态、详情、PDF）
 *
 * 推荐智能体使用无状态 API:
 * - `scrapePatent()` — 无状态专利元数据抓取
 * - `parsePatentHtml()` — 纯解析函数（含 parseWarnings）
 * - `validatePatentNumber()` / `normalizePatentNumber()` — 专利号工具
 * - `PDFDownloader.downloadBatchWithResults()` — 结构化批量下载结果
 * - `LegalStatusChecker.checkBatch()` — 并发法律状态查询
 */

// ---------------------------------------------------------------------------
// 核心爬虫
// ---------------------------------------------------------------------------
export {
  GooglePatentsScraper,
  scraper_class,
  fetchHtml,
  getSystemProxy,
  systemProxy,
  parseCitationElement,
  extractCitations,
  extractEvents,
  extractLegalStatus,
  extractClassifications,
} from './scraper.js';

export type { ProxyConfig } from './scraper.js';

// ---------------------------------------------------------------------------
// ego-browser 抓取后端（macOS 优先，失败自动回退原生 fetch）
// ---------------------------------------------------------------------------
export {
  isEgoBrowserAvailable,
  fetchHtmlWithEgoBrowser,
  resetEgoBrowserCache,
} from './ego-browser.js';

// 无状态 API（推荐）
export {
  scrapePatent,
  parsePatentHtml,
  validatePatentNumber,
  normalizePatentNumber,
} from './scraper.js';

// ---------------------------------------------------------------------------
// 检索 API（关键词/布尔检索式，XHR JSON 主路径 + HTML 回退）
// ---------------------------------------------------------------------------
export {
  searchPatents,
  parseSearchResultsJson,
  parseSearchResultsHtml,
} from './search.js';
export type {
  PatentSearchHit,
  PatentSearchResult,
  PatentSearchOptions,
} from './search.js';

// ---------------------------------------------------------------------------
// PDF 下载
// ---------------------------------------------------------------------------
export { PDFDownloader, downloadPdf } from './pdf-downloader.js';

// ---------------------------------------------------------------------------
// 法律状态
// ---------------------------------------------------------------------------
export { LegalStatusChecker } from './legal-status.js';

// ---------------------------------------------------------------------------
// CNIPA 中国专利
// ---------------------------------------------------------------------------
export { CNIPAClient } from './cnipa-client.js';

// ---------------------------------------------------------------------------
// 错误类
// ---------------------------------------------------------------------------
export {
  NuoPatentError,
  PatentClassError,
  NoPatentsError,
  PDFDownloadError,
  CNIPAQueryError,
  TimeoutError,
  ParseError,
} from './errors.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
export type {
  // 基础数据模型
  Citation,
  TimelineEvent,
  LegalStatus,
  PatentData,
  // 智能体基础设施
  Logger,
  ParseWarning,
  ScrapeOptions,
  ScrapeResult,
  PatentNumberValidation,
  // 法律状态
  LegalStatusResult,
  LegalStatusOptions,
  AnnuityStatus,
  // 下载
  DownloadResult,
  DownloadOptions,
  BatchDownloadResult,
  // CNIPA
  PatentDetail,
  TransactionRecord,
  SearchResult,
} from './types.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
export { noopLogger } from './types.js';

export const VERSION = '2.3.0';
export const AUTHOR = '小诺团队 · Xiaonuo Team';
export const LICENSE = 'MIT';
