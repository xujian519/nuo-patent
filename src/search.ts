/**
 * nuo-patent · Google Patents 专利检索
 *
 * 关键词/布尔检索式检索专利（补检索缺口——此前仅支持按专利号点查）。
 *
 * 双路径：
 * 1. 主路径：XHR JSON 接口（https://patents.google.com/xhr/query）——返回结构化
 *    JSON，字段稳定；经 ego-browser / fetch 抓取。
 * 2. 回退路径：HTML 搜索结果页（https://patents.google.com/?q=...）——cheerio 宽松
 *    选择器解析；当 JSON 接口返回空/结构异常时启用。
 *
 * 设计原则与 scraper.ts 一致：纯解析函数独立导出（无网络依赖）、解析失败字段
 * 空字符串兜底、错误抛 NuoPatentError 体系、fetchImpl 可注入（测试与复用）。
 */

import * as cheerio from "cheerio";
import type { Logger } from "./types.js";
import { noopLogger } from "./types.js";
import { fetchHtml, type FetchOptions } from "./scraper.js";
import { TimeoutError } from "./errors.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单个检索命中 */
export interface PatentSearchHit {
  /** 公开号/授权公告号，如 "US11452699B2" */
  patent: string;
  title: string;
  assignee: string;
  publication_date: string;
  priority_date: string;
  abstract: string;
  /** Google Patents 详情页 URL */
  url: string;
}

/** 检索结果 */
export interface PatentSearchResult {
  query: string;
  /** 命中总数（来自接口 total_num_results，可能不精确） */
  total: number;
  hits: PatentSearchHit[];
  /** 非致命解析警告（如部分字段缺失） */
  warnings: string[];
}

/** 检索选项 */
export interface PatentSearchOptions {
  /** 最大命中数（1-50，默认 10） */
  limit?: number;
  signal?: AbortSignal;
  /** 请求超时（毫秒），默认 30000 */
  timeout?: number;
  logger?: Logger;
  /** 自定义 fetch 实现（测试注入；缺省用全局 fetch） */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// 纯解析函数
// ---------------------------------------------------------------------------

/** 从 assignee 字段提取字符串（兼容 string / string[] / {name}[] / {name}）。 */
function extractAssignee(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    const first = value[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "name" in first) {
      const name = (first as { name?: unknown }).name;
      return typeof name === "string" ? name : "";
    }
    return "";
  }
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  }
  return "";
}

/**
 * 解析 XHR JSON 接口响应。
 * 结构：{ results: { total_num_results, cluster: [{ result: [{ patent: {...} }] }] } }
 * 宽容解析：字段缺失/结构异常时对应字段为空字符串，不抛异常。
 */
export function parseSearchResultsJson(
  raw: unknown,
): { total: number; hits: PatentSearchHit[] } {
  const hits: PatentSearchHit[] = [];
  let total = 0;

  if (!raw || typeof raw !== "object") return { total, hits };

  const results = (raw as { results?: unknown }).results;
  if (!results || typeof results !== "object") return { total, hits };

  const r = results as {
    total_num_results?: unknown;
    cluster?: unknown;
  };
  if (typeof r.total_num_results === "number") total = r.total_num_results;

  if (!Array.isArray(r.cluster)) return { total, hits };

  for (const cluster of r.cluster) {
    if (!cluster || typeof cluster !== "object") continue;
    const resultList = (cluster as { result?: unknown }).result;
    if (!Array.isArray(resultList)) continue;
    for (const item of resultList) {
      const patent = item && typeof item === "object" ? (item as { patent?: unknown }).patent : undefined;
      if (!patent || typeof patent !== "object") continue;
      const p = patent as {
        publication_number?: unknown;
        title?: unknown;
        assignee_current?: unknown;
        publication_date?: unknown;
        priority_date?: unknown;
        abstract?: unknown;
      };
      const publicationNumber =
        typeof p.publication_number === "string" ? p.publication_number : "";
      if (!publicationNumber) continue;
      hits.push({
        patent: publicationNumber,
        title: typeof p.title === "string" ? p.title : "",
        assignee: extractAssignee(p.assignee_current),
        publication_date: typeof p.publication_date === "string" ? p.publication_date : "",
        priority_date: typeof p.priority_date === "string" ? p.priority_date : "",
        abstract: typeof p.abstract === "string" ? p.abstract : "",
        url: `https://patents.google.com/patent/${publicationNumber}`,
      });
    }
  }

  return { total, hits };
}

/**
 * 解析 HTML 搜索结果页（回退路径）。
 * 每个结果一个 `<search-result>` 元素；选择器宽松，缺失字段空字符串兜底。
 */
export function parseSearchResultsHtml(
  $: cheerio.CheerioAPI,
  logger: Logger = noopLogger,
): { hits: PatentSearchHit[]; warnings: string[] } {
  const hits: PatentSearchHit[] = [];
  const warnings: string[] = [];

  $("search-result").each((_i, elem) => {
    const $el = $(elem);

    let patent = "";
    try {
      const link = $el.find("h3 a[href*='/patent/']").first();
      const href = link.attr("href") ?? "";
      patent = href.replace(/^\/patent\//, "").trim();
    } catch (e) {
      logger.warn("解析搜索结果专利号失败", e);
    }
    if (!patent) return;

    let title = "";
    try {
      title = $el.find("h3").first().text().trim();
    } catch (e) {
      logger.warn("解析搜索结果标题失败", e);
    }

    let assignee = "";
    try {
      assignee = $el.find('dd[itemprop="assigneeCurrent"]').first().text().trim();
    } catch (e) {
      logger.warn("解析搜索结果受让人失败", e);
    }

    let publicationDate = "";
    try {
      publicationDate = $el.find('dd[itemprop="publicationDate"]').first().text().trim();
    } catch (e) {
      logger.warn("解析搜索结果公开日失败", e);
    }

    let priorityDate = "";
    try {
      priorityDate = $el.find('dd[itemprop="priorityDate"]').first().text().trim();
    } catch (e) {
      logger.warn("解析搜索结果优先权日失败", e);
    }

    let abstract = "";
    try {
      abstract = $el.find(".abstract, dd[itemprop='abstract']").first().text().trim();
    } catch (e) {
      logger.warn("解析搜索结果摘要失败", e);
    }

    if (!title) warnings.push(`结果 ${patent} 缺少标题`);
    hits.push({
      patent,
      title,
      assignee,
      publication_date: publicationDate,
      priority_date: priorityDate,
      abstract,
      url: `https://patents.google.com/patent/${patent}`,
    });
  });

  if (hits.length === 0) {
    warnings.push("搜索结果页未解析到任何结果（页面结构可能变化）");
  }

  return { hits, warnings };
}

// ---------------------------------------------------------------------------
// 无状态检索 API（推荐智能体使用）
// ---------------------------------------------------------------------------

/**
 * 按关键词/布尔检索式检索专利（无状态，推荐智能体使用）。
 *
 * 主路径走 XHR JSON 接口（结构化）；解析出 0 条时自动回退 HTML 搜索页解析。
 * 始终返回 PatentSearchResult，不抛异常（网络错误在 warnings 中记录，hits 为空）。
 *
 * @example
 * ```typescript
 * import { searchPatents } from 'nuo-patent';
 *
 * const result = await searchPatents('(phase change material OR PCM) AND thermal', {
 *   limit: 20,
 * });
 * if (result.hits.length > 0) {
 *   console.log(result.hits[0].patent, result.hits[0].title);
 * }
 * ```
 */
export async function searchPatents(
  query: string,
  options: PatentSearchOptions = {},
): Promise<PatentSearchResult> {
  const {
    limit = 10,
    signal,
    timeout = 30000,
    logger = noopLogger,
    fetchImpl,
  } = options;

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { query, total: 0, hits: [], warnings: ["查询条件为空"] };
  }

  const clampedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);

  // 1. XHR JSON 接口（主路径）
  const xhrUrl =
    `https://patents.google.com/xhr/query?url=${encodeURIComponent(`q=${trimmed}`)}` +
    `&exp=&num=${clampedLimit}`;
  try {
    logger.info(`正在检索 ${trimmed}`);
    const raw = await fetchJson(xhrUrl, { signal, timeout, logger, fetchImpl });
    const { total, hits } = parseSearchResultsJson(raw);
    if (hits.length > 0) {
      return { query, total, hits, warnings: [] };
    }
    logger.warn("XHR JSON 接口返回 0 条，回退 HTML 搜索页解析");
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`XHR JSON 检索失败，回退 HTML 搜索页: ${message}`);
    if (signal?.aborted) {
      return { query, total: 0, hits: [], warnings: ["请求已被取消"] };
    }
  }

  // 2. HTML 搜索页（回退路径）
  const htmlUrl = `https://patents.google.com/?q=${encodeURIComponent(trimmed)}&num=${clampedLimit}`;
  try {
    const html = await fetchHtml(htmlUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal,
      timeout,
      logger,
      fetchImpl,
    });
    const $ = cheerio.load(html);
    const { hits, warnings } = parseSearchResultsHtml($, logger);
    return { query, total: hits.length, hits, warnings };
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (signal?.aborted) {
      return { query, total: 0, hits: [], warnings: ["请求已被取消"] };
    }
    const warning =
      err instanceof TimeoutError
        ? `检索超时 (${timeout}ms)`
        : `检索失败: ${err.message}`;
    return { query, total: 0, hits: [], warnings: [warning] };
  }
}

/** 抓取并 JSON.parse 一个 URL（复用 fetchHtml 的网络栈）。 */
async function fetchJson(
  targetUrl: string,
  options: FetchOptions & { fetchImpl?: typeof fetch },
): Promise<unknown> {
  const text = await fetchHtml(targetUrl, options);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`响应不是有效 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}
