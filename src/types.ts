/**
 * nuo-patent · 共享类型定义
 */

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

/** Google Patents 抓取结果 */
export interface PatentData {
  title: string;
  application_number: string;
  inventor_name: string;          // JSON string
  assignee_name_orig: string;     // JSON string
  assignee_name_current: string;  // JSON string
  pub_date: string;
  filing_date: string;
  priority_date: string;
  grant_date: string;
  expiration_date: string;
  legal_status: string;
  ifi_status: string;
  estimated_expiration: string;
  pdf_url: string;
  classifications: string;        // JSON string
  forward_cite_no_family: string; // JSON string
  forward_cite_yes_family: string;
  backward_cite_no_family: string;
  backward_cite_yes_family: string;
  abstract_text: string;
  url?: string;
  patent?: string;
}

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

/** 年费状态 */
export interface AnnuityStatus {
  patent_number: string;
  status: string | undefined;
  estimated_expiration: string | undefined;
  fee_events: TimelineEvent[];
  note: string;
}

/** PDF 下载批量结果 */
export type BatchDownloadResult = Record<string, string>;
