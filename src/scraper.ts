/**
 * nuo-patent · Google Patents 核心爬虫 (TypeScript 版本)
 *
 * 抓取 https://patents.google.com/ 的专利元数据。
 * 已适配 2025+ 最新页面结构。
 *
 * 推荐智能体使用无状态 `scrapePatent()` 函数，而非有状态的 `GooglePatentsScraper` 类。
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { execSync } from 'child_process';
import type {
  PatentData,
  Citation,
  LegalStatus,
  ScrapeResult,
  ScrapeOptions,
  ParseWarning,
  Logger,
  PatentNumberValidation,
} from './types.js';
import { noopLogger } from './types.js';
import { isEgoBrowserAvailable, fetchHtmlWithEgoBrowser } from './ego-browser.js';
import {
  PatentClassError,
  NoPatentsError,
  TimeoutError,
} from './errors.js';

// ---------------------------------------------------------------------------
// 专利号工具
// ---------------------------------------------------------------------------

/** 通用专利号正则：2个字母国家码 + 1-14位数字/字母组合 */
const PATENT_NUMBER_RE = /^([A-Z]{2})(\d{1,14}[A-Z]?\d*)$/i;

/**
 * 校验并规范化专利号。
 * 智能体可先调用此函数验证用户输入的专利号格式。
 */
export function validatePatentNumber(input: string): PatentNumberValidation {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { valid: false, reason: '专利号不能为空' };
  }

  const cleaned = input.trim().toUpperCase().replace(/\s+/g, '');

  if (cleaned.length < 4) {
    return { valid: false, reason: `专利号过短: "${cleaned}"（至少需要 4 个字符）` };
  }

  const match = cleaned.match(PATENT_NUMBER_RE);
  if (!match) {
    return {
      valid: false,
      reason: `专利号格式不正确: "${cleaned}"（期望格式: 2个字母国家码 + 数字，如 US11452699B2）`,
    };
  }

  return { valid: true, normalized: cleaned };
}

/**
 * 规范化专利号：去空格、转大写。
 * 不做格式校验，非法输入原样返回大写形式。
 */
export function normalizePatentNumber(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// 代理检测（惰性初始化）
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  host: string;
  port: number;
}

function detectSystemProxy(): ProxyConfig | undefined {
  const envUrl = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;

  if (envUrl) {
    try {
      const u = new URL(envUrl);
      return { host: u.hostname, port: parseInt(u.port) || 8080 };
    } catch { /* 环境变量中可能存在非法 URL */ }
  }

  // macOS 系统代理检测
  if (process.platform === 'darwin') {
    try {
      const output = execSync('scutil --proxy', { encoding: 'utf8', timeout: 3000 });
      const enabled = output.match(/HTTPSEnable\s*:\s*1/);
      const host = output.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (enabled && host && port) return { host, port: parseInt(port) };
    } catch { /* scutil 可能不可用 */ }
  }
  return undefined;
}

/** 惰性初始化的系统代理缓存 — 首次调用时才检测，避免模块加载 I/O */
let _cachedProxy: ProxyConfig | undefined | null = null;

export function getSystemProxy(): ProxyConfig | undefined {
  if (_cachedProxy === null) {
    _cachedProxy = detectSystemProxy();
  }
  return _cachedProxy;
}

/** @deprecated Use getSystemProxy() instead. */
export const systemProxy = getSystemProxy;

// ---------------------------------------------------------------------------
// HTTP 请求层（支持代理隧道、超时、AbortSignal）
// ---------------------------------------------------------------------------

export interface FetchOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeout?: number;
  logger?: Logger;
  /** 自定义 fetch 实现（测试注入；缺省用全局 fetch） */
  fetchImpl?: typeof fetch;
}

/**
 * 获取 HTML 页面内容，支持代理隧道、超时、取消信号。
 */
export async function fetchHtml(
  targetUrl: string,
  options: FetchOptions = {},
): Promise<string> {
  const { headers = {}, signal, timeout = 30000, logger = noopLogger, fetchImpl } = options;

  // macOS 上优先使用 ego-browser（真实 Chromium）抓取，失败自动回退原生网络栈
  if (isEgoBrowserAvailable()) {
    try {
      return await fetchHtmlWithEgoBrowser(targetUrl, { signal, timeout, logger });
    } catch (e: unknown) {
      logger.warn(`[ego-browser] 抓取失败，回退原生 fetch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 信号已在调用前取消，立即拒绝
  if (signal?.aborted) {
    throw new Error('Request aborted');
  }

  const proxy = getSystemProxy();

  // 直连路径
  if (!proxy) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), timeout);

    // 合并外部 signal
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(signal.reason));
    }

    try {
      const resp = await (fetchImpl ?? fetch)(targetUrl, {
        headers,
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return await resp.text();
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        if (signal?.aborted) throw new Error('Request aborted');
        throw new TimeoutError(`请求超时 (${timeout}ms)`, timeout);
      }
      if (e instanceof Error && e.message === 'Request aborted') {
        throw e;
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // 代理隧道路径
  const target = new URL(targetUrl);

  return new Promise<string>((resolve, reject) => {
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
    });

    const proxyTimeout = timeout + 5000; // 代理连接额外给 5s
    const proxyTimer = setTimeout(() => {
      connectReq.destroy(new Error('Proxy CONNECT timeout'));
    }, proxyTimeout);

    // 支持外部取消信号
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
        headers,
      } as https.RequestOptions, (httpsRes) => {
        // 处理重定向
        if (httpsRes.statusCode && httpsRes.statusCode >= 300 && httpsRes.statusCode < 400 && httpsRes.headers.location) {
          resolve(fetchHtml(httpsRes.headers.location, options));
          return;
        }
        if (httpsRes.statusCode && httpsRes.statusCode >= 400) {
          reject(new Error(`HTTP ${httpsRes.statusCode}`));
          return;
        }
        let data = '';
        httpsRes.on('data', (chunk: Buffer) => data += chunk.toString());
        httpsRes.on('end', () => resolve(data));
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

// ---------------------------------------------------------------------------
// 纯解析函数 — 无网络 I/O，接受 cheerio API，可供外部（小诺智能体）复用
// ---------------------------------------------------------------------------

/**
 * 解析单个引证 `<tr>` 元素。
 * 解析失败时对应字段保持空字符串（不抛异常）。
 */
export function parseCitationElement(
  $: cheerio.CheerioAPI,
  element: AnyNode,
  logger: Logger = noopLogger,
): Citation {
  const result: Citation = {
    patent_number: '',
    priority_date: '',
    pub_date: '',
  };

  const $el = $(element);

  try {
    const pubNum = $el.find('span[itemprop="publicationNumber"]').first();
    if (pubNum.length > 0) {
      result.patent_number = pubNum.text().trim();
    }
  } catch (e) {
    logger.warn('解析引证专利号失败', e);
  }

  try {
    const priorityDate = $el.find('td[itemprop="priorityDate"]').first();
    if (priorityDate.length > 0) {
      result.priority_date = priorityDate.text().trim();
    }
  } catch (e) {
    logger.warn('解析引证优先权日失败', e);
  }

  try {
    const pubDate = $el.find('td[itemprop="publicationDate"]').first();
    if (pubDate.length > 0) {
      result.pub_date = pubDate.text().trim();
    }
  } catch (e) {
    logger.warn('解析引证公开日失败', e);
  }

  return result;
}

interface ExtractCitationsResult {
  forwardCitesNoFamily: Citation[];
  forwardCitesYesFamily: Citation[];
  backwardCitesNoFamily: Citation[];
  backwardCitesYesFamily: Citation[];
}

/** 提取前后向引证，返回结构化结果 */
export function extractCitations(
  $: cheerio.CheerioAPI,
  logger: Logger = noopLogger,
): ExtractCitationsResult {
  const selectors: [keyof ExtractCitationsResult, string][] = [
    ['forwardCitesNoFamily', 'tr[itemprop="forwardReferencesOrig"]'],
    ['forwardCitesYesFamily', 'tr[itemprop="forwardReferencesFamily"]'],
    ['backwardCitesNoFamily', 'tr[itemprop="backwardReferences"]'],
    ['backwardCitesYesFamily', 'tr[itemprop="backwardReferencesFamily"]'],
  ];

  const result = {} as ExtractCitationsResult;
  for (const [key, selector] of selectors) {
    const citations: Citation[] = [];
    $(selector).each((_i, elem) => {
      citations.push(parseCitationElement($, elem, logger));
    });
    result[key] = citations;
  }
  return result;
}

/** 提取时间线事件 */
export function extractEvents(
  $: cheerio.CheerioAPI,
  logger: Logger = noopLogger,
): {
  priority_date: string;
  filing_date: string;
  grant_date: string;
  expiration_date: string;
  pub_date: string;
} {
  const result = {
    priority_date: '',
    filing_date: '',
    grant_date: '',
    expiration_date: '',
    pub_date: '',
  };

  $('dd[itemprop="events"]').each((_index: number, appEvent: AnyNode) => {
    try {
      const $event = $(appEvent);
      const titleInfo = $event.find('span[itemprop="type"]').first();
      if (titleInfo.length === 0) return;

      const titleText = titleInfo.text().trim();
      const timeTag = $event.find('time[itemprop="date"]').first();
      if (timeTag.length === 0) return;

      const timeEvent = timeTag.text().trim();

      switch (titleText) {
        case 'priority':
          result.priority_date = timeEvent;
          break;
        case 'filed':
          result.filing_date = timeEvent;
          break;
        case 'granted':
          result.grant_date = timeEvent;
          break;
        case 'publication':
          if (!result.pub_date) result.pub_date = timeEvent;
          break;
      }

      const titleSpan = $event.find('span[itemprop="title"]').first();
      if (titleSpan.length > 0 && titleSpan.text().toLowerCase().includes('expiration')) {
        result.expiration_date = timeEvent;
      }
    } catch (e) {
      logger.warn('解析时间线事件失败', e);
    }
  });

  return result;
}

/** 提取法律状态 */
export function extractLegalStatus(
  $: cheerio.CheerioAPI,
  logger: Logger = noopLogger,
): LegalStatus {
  const legal: LegalStatus = {
    status: '',
    ifi_status: '',
    estimated_expiration: '',
    events: [],
  };

  try {
    const ifiElem = $('dd[itemprop="legalStatusIfi"]').first();
    if (ifiElem.length > 0) {
      const ifiText = ifiElem.text().trim();
      legal.ifi_status = ifiText;

      if (ifiText.includes(',')) {
        const parts = ifiText.split(',');
        legal.status = parts[0].trim();
        if (parts.length > 1) {
          const expMatch = ifiText.match(/expires?\s*(\d{4}-\d{2}-\d{2})/);
          if (expMatch) {
            legal.estimated_expiration = expMatch[1];
          }
        }
      }
    }
  } catch (e) {
    logger.warn('解析 IFI 法律状态失败', e);
  }

  $('dd[itemprop="events"]').each((_index: number, appEvent: AnyNode) => {
    try {
      const $event = $(appEvent);
      const titleInfo = $event.find('span[itemprop="type"]').first();
      if (titleInfo.length === 0) return;

      const titleText = titleInfo.text().trim();
      if (titleText !== 'legal-status') return;

      const timeTag = $event.find('time[itemprop="date"]').first();
      if (timeTag.length === 0) return;

      const dateText = timeTag.text().trim();

      if (dateText === 'Status') {
        const titleSpan = $event.find('span[itemprop="title"]').first();
        if (titleSpan.length > 0) {
          const statusText = titleSpan.text().trim();
          legal.status = statusText.replace('Current', '').trim();
        }
      } else if (dateText && /^\d/.test(dateText)) {
        legal.estimated_expiration = dateText;
        const titleSpan = $event.find('span[itemprop="title"]').first();
        if (titleSpan.length > 0) {
          legal.events.push({
            type: titleSpan.text().trim(),
            date: dateText,
            title: '',
          });
        }
      }
    } catch (e) {
      logger.warn('解析法律状态事件失败', e);
    }
  });

  return legal;
}

/** 提取 IPC/CPC 分类 */
export function extractClassifications(
  $: cheerio.CheerioAPI,
  logger: Logger = noopLogger,
): string[] {
  const clsArray: string[] = [];
  try {
    $('dd[itemprop="classifications"]').each((_index: number, elem: AnyNode) => {
      clsArray.push($(elem).text().trim());
    });
  } catch (e) {
    logger.warn('解析分类信息失败', e);
  }
  return clsArray;
}

// ---------------------------------------------------------------------------
// 核心解析：HTML → PatentData（带 parseWarnings）
// ---------------------------------------------------------------------------

interface ProcessResult {
  data: PatentData;
  warnings: ParseWarning[];
}

/**
 * 从 Google Patents HTML 提取所有字段。
 * 与 `GooglePatentsScraper.processPatentHtml` 功能相同，但额外返回
 * `parseWarnings` 数组，告知哪些字段可能因页面结构变化而未能解析。
 */
export function parsePatentHtml(
  $: cheerio.CheerioAPI,
  options: { returnAbstract?: boolean; returnLegal?: boolean; logger?: Logger } = {},
): ProcessResult {
  const { returnAbstract = true, returnLegal = true, logger = noopLogger } = options;
  const warnings: ParseWarning[] = [];

  // --- 标题 ---
  let titleText = '';
  try {
    const title = $('meta[name="DC.title"]').first();
    if (title.length > 0) {
      titleText = title.attr('content')?.trim() ?? '';
    }
    if (!titleText) {
      warnings.push({ field: 'title', message: '未找到 DC.title meta 标签' });
    }
  } catch (e) {
    warnings.push({ field: 'title', message: `解析异常: ${e}` });
    logger.warn('解析标题失败', e);
  }

  // --- 发明人 ---
  let inventorName = '';
  try {
    const inventors: Array<{ inventor_name: string }> = [];
    $('dd[itemprop="inventor"]').each((_index: number, elem: AnyNode) => {
      inventors.push({ inventor_name: $(elem).text().trim() });
    });
    inventorName = JSON.stringify(inventors);
  } catch (e) {
    warnings.push({ field: 'inventor_name', message: `解析异常: ${e}` });
    inventorName = '[]';
    logger.warn('解析发明人失败', e);
  }

  // --- 原始受让人 ---
  let assigneeNameOrig = '';
  try {
    const assignees: Array<{ assignee_name: string }> = [];
    $('dd[itemprop="assigneeOriginal"]').each((_index: number, elem: AnyNode) => {
      assignees.push({ assignee_name: $(elem).text().trim() });
    });
    assigneeNameOrig = JSON.stringify(assignees);
  } catch (e) {
    warnings.push({ field: 'assignee_name_orig', message: `解析异常: ${e}` });
    assigneeNameOrig = '[]';
    logger.warn('解析原始受让人失败', e);
  }

  // --- 当前受让人 ---
  let assigneeNameCurrent = '';
  try {
    const assignees: Array<{ assignee_name: string }> = [];
    $('dd[itemprop="assigneeCurrent"]').each((_index: number, elem: AnyNode) => {
      assignees.push({ assignee_name: $(elem).text().trim() });
    });
    assigneeNameCurrent = JSON.stringify(assignees);
  } catch (e) {
    warnings.push({ field: 'assignee_name_current', message: `解析异常: ${e}` });
    assigneeNameCurrent = '[]';
    logger.warn('解析当前受让人失败', e);
  }

  // --- 公开日 ---
  let pubDate = '';
  try {
    const pubDateElem = $('dd[itemprop="publicationDate"]').first();
    if (pubDateElem.length > 0) {
      pubDate = pubDateElem.text().trim();
    }
  } catch (e) {
    warnings.push({ field: 'pub_date', message: `解析异常: ${e}` });
    logger.warn('解析公开日失败', e);
  }

  // --- 申请号 ---
  let applicationNumber = '';
  try {
    const appNumElem = $('dd[itemprop="applicationNumber"]').first();
    if (appNumElem.length > 0) {
      applicationNumber = appNumElem.text().trim();
    }
  } catch (e) {
    warnings.push({ field: 'application_number', message: `解析异常: ${e}` });
    logger.warn('解析申请号失败', e);
  }

  // --- 事件（时间线） ---
  const events = extractEvents($, logger);

  if (!pubDate && events.pub_date) {
    pubDate = events.pub_date;
  }

  // --- 法律状态 ---
  let legal: LegalStatus;
  if (returnLegal) {
    legal = extractLegalStatus($, logger);
  } else {
    legal = { status: '', ifi_status: '', estimated_expiration: '', events: [] };
  }

  // --- 引证 ---
  const citations = extractCitations($, logger);
  const forwardCitesNoFamily = JSON.stringify(citations.forwardCitesNoFamily);
  const forwardCitesYesFamily = JSON.stringify(citations.forwardCitesYesFamily);
  const backwardCitesNoFamily = JSON.stringify(citations.backwardCitesNoFamily);
  const backwardCitesYesFamily = JSON.stringify(citations.backwardCitesYesFamily);

  // --- 摘要 ---
  let abstractText = '';
  if (returnAbstract) {
    try {
      const abstract = $('meta[name="DC.description"]').first();
      if (abstract.length > 0) {
        abstractText = abstract.attr('content')?.trim() ?? '';
      }
      if (!abstractText) {
        warnings.push({ field: 'abstract_text', message: '未找到 DC.description meta 标签' });
      }
    } catch (e) {
      warnings.push({ field: 'abstract_text', message: `解析异常: ${e}` });
      logger.warn('解析摘要失败', e);
    }
  }

  // --- PDF URL ---
  let pdfUrl = '';
  try {
    const pdfMeta = $('meta[name="citation_pdf_url"]').first();
    if (pdfMeta.length > 0) {
      pdfUrl = pdfMeta.attr('content') ?? '';
    }
    if (!pdfUrl) {
      warnings.push({ field: 'pdf_url', message: '未找到 citation_pdf_url meta 标签' });
    }
  } catch (e) {
    warnings.push({ field: 'pdf_url', message: `解析异常: ${e}` });
    logger.warn('解析 PDF URL 失败', e);
  }

  // --- 分类 ---
  const classifications = JSON.stringify(extractClassifications($, logger));

  const data: PatentData = {
    title: titleText,
    application_number: applicationNumber,
    inventor_name: inventorName,
    assignee_name_orig: assigneeNameOrig,
    assignee_name_current: assigneeNameCurrent,
    pub_date: pubDate,
    filing_date: events.filing_date,
    priority_date: events.priority_date,
    grant_date: events.grant_date,
    expiration_date: events.expiration_date,
    legal_status: legal.status,
    ifi_status: legal.ifi_status,
    estimated_expiration: legal.estimated_expiration,
    pdf_url: pdfUrl,
    classifications,
    forward_cite_no_family: forwardCitesNoFamily,
    forward_cite_yes_family: forwardCitesYesFamily,
    backward_cite_no_family: backwardCitesNoFamily,
    backward_cite_yes_family: backwardCitesYesFamily,
    abstract_text: abstractText,
  };

  return { data, warnings };
}

// ---------------------------------------------------------------------------
// 无状态抓取 API（推荐智能体使用）
// ---------------------------------------------------------------------------

/**
 * 抓取单个专利的元数据（无状态，推荐智能体使用）。
 *
 * 始终返回 `ScrapeResult`，不抛异常。智能体通过 `result.success` 判断成败，
 * 通过 `result.parseWarnings` 了解非致命解析问题。
 *
 * @example
 * ```typescript
 * import { scrapePatent, validatePatentNumber } from 'nuo-patent';
 *
 * const validation = validatePatentNumber('US11452699B2');
 * if (!validation.valid) throw new Error(validation.reason);
 *
 * const result = await scrapePatent(validation.normalized!, {
 *   timeout: 15000,
 *   signal: abortController.signal,
 * });
 *
 * if (result.success) {
 *   console.log(result.data!.title);
 *   if (result.parseWarnings.length > 0) {
 *     console.warn('解析警告:', result.parseWarnings);
 *   }
 * } else {
 *   console.error(`[${result.errorCode}] ${result.errorMessage}`);
 * }
 * ```
 */
export async function scrapePatent(
  patentNumber: string,
  options: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const {
    signal,
    timeout = 30000,
    logger = noopLogger,
    headers = {},
    returnAbstract = true,
    returnLegal = true,
    fetchImpl,
  } = options;

  // 1. 校验专利号
  const validation = validatePatentNumber(patentNumber);
  if (!validation.valid) {
    return {
      success: false,
      patent: patentNumber,
      url: '',
      data: null,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: validation.reason ?? '专利号校验失败',
      parseWarnings: [],
    };
  }

  const normalizedPatent = validation.normalized!;
  const requestUrl = `https://patents.google.com/patent/${normalizedPatent}`;

  // 2. 请求页面
  let html: string;
  try {
    logger.info(`正在请求 ${requestUrl}`);
    html = await fetchHtml(requestUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
      signal,
      timeout,
      logger,
      fetchImpl,
    });
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    const message = err.message;

    if (message === 'Request aborted' || signal?.aborted) {
      return {
        success: false,
        patent: normalizedPatent,
        url: requestUrl,
        data: null,
        errorCode: 'ABORTED',
        errorMessage: '请求已被取消',
        parseWarnings: [],
      };
    }

    if (err instanceof TimeoutError || message.includes('timeout')) {
      return {
        success: false,
        patent: normalizedPatent,
        url: requestUrl,
        data: null,
        errorCode: 'TIMEOUT',
        errorMessage: `请求超时 (${timeout}ms)`,
        parseWarnings: [],
      };
    }

    if (message.includes('HTTP 404') || message.includes('HTTP 410')) {
      return {
        success: false,
        patent: normalizedPatent,
        url: requestUrl,
        data: null,
        errorCode: 'NOT_FOUND',
        errorMessage: `专利 ${normalizedPatent} 未找到 (404)`,
        parseWarnings: [],
      };
    }

    if (message.startsWith('HTTP ')) {
      return {
        success: false,
        patent: normalizedPatent,
        url: requestUrl,
        data: null,
        errorCode: 'HTTP_ERROR',
        errorMessage: message,
        parseWarnings: [],
      };
    }

    return {
      success: false,
      patent: normalizedPatent,
      url: requestUrl,
      data: null,
      errorCode: 'NETWORK_ERROR',
      errorMessage: message,
      parseWarnings: [],
    };
  }

  // 3. 解析 HTML
  try {
    const $ = cheerio.load(html);
    const { data, warnings } = parsePatentHtml($, { returnAbstract, returnLegal, logger });

    // 检查是否为空页面（专利不存在但 Google 返回 200）
    if (!data.title && !data.application_number && !data.abstract_text) {
      return {
        success: false,
        patent: normalizedPatent,
        url: requestUrl,
        data: null,
        errorCode: 'NOT_FOUND',
        errorMessage: `专利 ${normalizedPatent} 的页面无有效数据（可能不存在或页面结构调整）`,
        parseWarnings: warnings,
      };
    }

    return {
      success: true,
      patent: normalizedPatent,
      url: requestUrl,
      data: { ...data, patent: normalizedPatent, url: requestUrl },
      errorCode: '',
      errorMessage: '',
      parseWarnings: warnings,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      patent: normalizedPatent,
      url: requestUrl,
      data: null,
      errorCode: 'PARSE_ERROR',
      errorMessage: `HTML 解析失败: ${message}`,
      parseWarnings: [],
    };
  }
}

// ---------------------------------------------------------------------------
// GooglePatentsScraper 类（保留向后兼容）
// ---------------------------------------------------------------------------

export class GooglePatentsScraper {
  private listOfPatents: string[] = [];
  private scrapeStatus: Record<string, string> = {};
  private parsedPatents: Record<string, PatentData> = {};
  private returnAbstract: boolean;
  private returnLegal: boolean;

  constructor(returnAbstract: boolean = true, returnLegal: boolean = true) {
    this.returnAbstract = returnAbstract;
    this.returnLegal = returnLegal;
  }

  addPatents(patent: string): void {
    if (typeof patent !== 'string') {
      throw new PatentClassError("'patent' variable must be a string");
    }
    this.listOfPatents.push(patent);
  }

  deletePatents(patent: string): void {
    const index = this.listOfPatents.indexOf(patent);
    if (index !== -1) {
      this.listOfPatents.splice(index, 1);
    } else {
      console.log(`Patent ${patent} not in patent list`);
    }
  }

  addScrapeStatus(patent: string, value: string): void {
    this.scrapeStatus[patent] = value;
  }

  /**
   * @deprecated 推荐使用无状态的 `scrapePatent()` 函数，避免状态污染。
   */
  async requestSinglePatent(
    patent: string,
    url: boolean = false,
  ): Promise<[string, cheerio.CheerioAPI | null, string]> {
    try {
      let requestUrl: string;
      if (!url) {
        requestUrl = `https://patents.google.com/patent/${patent}`;
      } else {
        requestUrl = patent;
      }

      const html = await fetchHtml(requestUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const $ = cheerio.load(html);
      return ['Success', $, requestUrl];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`Patent: ${patent}, Error: ${errorMessage}`);
      return [errorMessage, null, patent];
    }
  }

  parseCitation($: cheerio.CheerioAPI, element: AnyNode): Citation {
    return parseCitationElement($, element);
  }

  /**
   * @deprecated 推荐使用无状态的 `parsePatentHtml()` 函数，可获取 parseWarnings。
   */
  processPatentHtml($: cheerio.CheerioAPI): PatentData {
    const { data } = parsePatentHtml($, {
      returnAbstract: this.returnAbstract,
      returnLegal: this.returnLegal,
    });
    return data;
  }

  getScrapedData($: cheerio.CheerioAPI, patent: string, url: string): PatentData {
    const parsing = this.processPatentHtml($);
    parsing.url = url;
    parsing.patent = patent;
    return parsing;
  }

  /**
   * @deprecated 推荐逐专利调用 `scrapePatent()`，避免实例状态残留。
   */
  async scrapeAllPatents(): Promise<void> {
    if (this.listOfPatents.length === 0) {
      throw new NoPatentsError(
        "no patents to scrape specified in 'patent' variable: " +
        "add patent using class.addPatents([<PATENTNUMBER>])",
      );
    }

    for (const patent of this.listOfPatents) {
      const [errorStatus, soup, url] = await this.requestSinglePatent(patent);
      this.addScrapeStatus(patent, errorStatus);
      if (errorStatus === 'Success' && soup) {
        this.parsedPatents[patent] = this.getScrapedData(soup, patent, url);
      } else {
        this.parsedPatents[patent] = {} as PatentData;
      }
    }
  }

  // Getters
  get list_of_patents(): string[] {
    return this.listOfPatents;
  }

  get scrape_status(): Record<string, string> {
    return this.scrapeStatus;
  }

  get parsed_patents(): Record<string, PatentData> {
    return this.parsedPatents;
  }
}

/** @deprecated Use `GooglePatentsScraper` directly. */
export const scraper_class = GooglePatentsScraper;
