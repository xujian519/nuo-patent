/**
 * nuo-patent · 共享类型定义
 */

// ---------------------------------------------------------------------------
// 智能体工具基础设施
// ---------------------------------------------------------------------------

/** 可配置的日志接口，智能体可传入自定义 logger 控制输出行为 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** 无操作 logger，默认静默 */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// ---------------------------------------------------------------------------
// 专利数据模型
// ---------------------------------------------------------------------------

/** 引证记录 */
export interface Citation {
  patent_number: string;
  priority_date: string;
  pub_date: string;
}

/** 时间线事件 */
export interface TimelineEvent {
  type: string;
  date: string;
  title: string;
}

/** 法律状态信息 */
export interface LegalStatus {
  status: string;
  ifi_status: string;
  estimated_expiration: string;
  events: TimelineEvent[];
}

/**
 * Google Patents 抓取结果。
 *
 * 注意：`inventor_name`, `assignee_name_orig`, `assignee_name_current`,
 * `classifications`, `forward_cite_*`, `backward_cite_*` 字段存储的是
 * **JSON 字符串**（从 Python 原版继承的约定），使用前需要 `JSON.parse()`。
 */
export interface PatentData {
  title: string;
  application_number: string;
  /** @json JSON 字符串，格式: `[{"inventor_name": "..."}]` */
  inventor_name: string;
  /** @json JSON 字符串，格式: `[{"assignee_name": "..."}]` */
  assignee_name_orig: string;
  /** @json JSON 字符串，格式: `[{"assignee_name": "..."}]` */
  assignee_name_current: string;
  pub_date: string;
  filing_date: string;
  priority_date: string;
  grant_date: string;
  expiration_date: string;
  legal_status: string;
  ifi_status: string;
  estimated_expiration: string;
  pdf_url: string;
  /** @json JSON 字符串，IPC/CPC 分类数组 */
  classifications: string;
  /** @json JSON 字符串 */
  forward_cite_no_family: string;
  /** @json JSON 字符串 */
  forward_cite_yes_family: string;
  /** @json JSON 字符串 */
  backward_cite_no_family: string;
  /** @json JSON 字符串 */
  backward_cite_yes_family: string;
  abstract_text: string;
  /** 请求 URL（仅 getScrapedData 设置） */
  url?: string;
  /** 专利号（仅 getScrapedData 设置） */
  patent?: string;
}

/**
 * 解析警告 — 非致命解析问题，告知智能体某些字段可能因页面结构变化而缺失。
 * 区别于错误：有警告时 data 仍然返回（只是部分字段为空）。
 */
export interface ParseWarning {
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// 无状态抓取 API（推荐智能体使用）
// ---------------------------------------------------------------------------

/** 无状态 scrapePatent() 的选项 */
export interface ScrapeOptions {
  /** 取消信号 */
  signal?: AbortSignal;
  /** 请求超时（毫秒），默认 30000 */
  timeout?: number;
  /** 日志接口，默认 noopLogger（静默） */
  logger?: Logger;
  /** 自定义 HTTP 请求头 */
  headers?: Record<string, string>;
  /** 是否提取摘要，默认 true */
  returnAbstract?: boolean;
  /** 是否提取法律状态，默认 true */
  returnLegal?: boolean;
}

/** 无状态 scrapePatent() 的统一返回值 — 始终返回此结构，不抛异常 */
export interface ScrapeResult {
  /** 是否成功获取并解析 */
  success: boolean;
  /** 请求的专利号 */
  patent: string;
  /** 实际请求的 URL */
  url: string;
  /** 解析后的专利数据，失败时为 null */
  data: PatentData | null;
  /** 错误码（成功时为空字符串） */
  errorCode: '' | 'VALIDATION_ERROR' | 'NETWORK_ERROR' | 'HTTP_ERROR' | 'TIMEOUT' | 'PARSE_ERROR' | 'NOT_FOUND' | 'ABORTED';
  /** 人类可读的错误描述 */
  errorMessage: string;
  /** 非致命解析警告（即使 success=true 也可能存在） */
  parseWarnings: ParseWarning[];
}

// ---------------------------------------------------------------------------
// 法律状态
// ---------------------------------------------------------------------------

/** 法律状态检查结果 */
export interface LegalStatusResult {
  patent_number: string;
  title: string;
  status: string;
  ifi_status: string;
  estimated_expiration: string;
  filing_date: string;
  grant_date: string;
  applicant: string;
  inventor: string;
  events_summary: TimelineEvent[];
  url: string;
  error?: string;
}

/** 批量法律状态查询选项 */
export interface LegalStatusOptions {
  /** 取消信号 */
  signal?: AbortSignal;
  /** 日志接口 */
  logger?: Logger;
  /** 最大并发数，默认 4 */
  maxConcurrency?: number;
}

// ---------------------------------------------------------------------------
// 年费
// ---------------------------------------------------------------------------

/** 年费状态 */
export interface AnnuityStatus {
  patent_number: string;
  /** 法律状态（空字符串表示未获取到） */
  status: string;
  /** 预估到期日（空字符串表示未获取到） */
  estimated_expiration: string;
  fee_events: TimelineEvent[];
  note: string;
}

// ---------------------------------------------------------------------------
// PDF 下载
// ---------------------------------------------------------------------------

/** 单专利 PDF 下载结果 */
export interface DownloadResult {
  patentNumber: string;
  success: boolean;
  /** 成功时为输出文件路径 */
  path?: string;
  /** 失败时为错误描述 */
  error?: string;
}

/** PDF 下载选项 */
export interface DownloadOptions {
  /** 取消信号 */
  signal?: AbortSignal;
  /** 日志接口 */
  logger?: Logger;
  /** 最大并发数，默认 4 */
  maxWorkers?: number;
}

/** @deprecated 使用 DownloadResult[] 替代。保留用于向后兼容 */
export type BatchDownloadResult = Record<string, string>;

// ---------------------------------------------------------------------------
// CNIPA 中国专利
// ---------------------------------------------------------------------------

/** CNIPA 中国专利详情 */
export interface PatentDetail {
  title: string;
  pub_number: string;
  pub_date: string;
  app_number: string;
  app_date: string;
  applicant: string;
  address: string;
  inventor: string;
  classification: string;
  agency: string;
  agent: string;
  abstract: string;
  first_page_image_url: string;
}

/** CNIPA 事务记录 */
export interface TransactionRecord {
  index: number;
  app_number: string;
  date: string;
  description: string;
}

/** CNIPA 检索结果 */
export interface SearchResult {
  keyword: string;
  total_hits: number;
  patents: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// 工具函数类型
// ---------------------------------------------------------------------------

/**
 * 专利号校验结果。
 * 可通过 `isValidPatentNumber()` 函数获取。
 */
export interface PatentNumberValidation {
  /** 是否通过基本格式校验 */
  valid: boolean;
  /** 规范化后的专利号（去空格、大写），仅 valid=true 时有意义 */
  normalized?: string;
  /** 校验失败原因 */
  reason?: string;
}
