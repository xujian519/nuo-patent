/**
 * nuo-patent · Google Patents 核心爬虫 (TypeScript 版本)
 *
 * 抓取 https://patents.google.com/ 的专利元数据。
 * 已适配 2025+ 最新页面结构。
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { execSync } from 'child_process';
import type { PatentData, Citation, LegalStatus } from './types.js';
import { PatentClassError, NoPatentsError } from './errors.js';

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
    } catch {}
  }

  // macOS system proxy detection via scutil
  if (process.platform === 'darwin') {
    try {
      const output = execSync('scutil --proxy', { encoding: 'utf8', timeout: 3000 });
      const enabled = output.match(/HTTPSEnable\s*:\s*1/);
      const host = output.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (enabled && host && port) return { host, port: parseInt(port) };
    } catch {}
  }
  return undefined;
}

/** Lazily-initialized system proxy — no I/O at module load time. */
let _cachedProxy: ProxyConfig | undefined | null = null;

export function getSystemProxy(): ProxyConfig | undefined {
  if (_cachedProxy === null) {
    _cachedProxy = detectSystemProxy();
  }
  return _cachedProxy;
}

/** @deprecated Use getSystemProxy() instead. */
export const systemProxy = getSystemProxy;

export async function fetchHtml(targetUrl: string, headers: Record<string, string> = {}): Promise<string> {
  const proxy = getSystemProxy();

  if (!proxy) {
    const resp = await fetch(targetUrl, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  }

  const target = new URL(targetUrl);
  return new Promise<string>((resolve, reject) => {
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
        // socket is not in RequestOptions type but supported by Node.js for tunneling
      } as https.RequestOptions, (httpsRes) => {
        if (httpsRes.statusCode && httpsRes.statusCode >= 300 && httpsRes.statusCode < 400 && httpsRes.headers.location) {
          resolve(fetchHtml(httpsRes.headers.location, headers));
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

    connectReq.on('error', reject);
    connectReq.setTimeout(15000, () => {
      connectReq.destroy(new Error('Proxy CONNECT timeout'));
    });
    connectReq.end();
  });
}

// ---------------------------------------------------------------------------
// Pure parsing functions — no network I/O, accept cheerio API only.
// These are the functions XiaoNuo imports to enrich GooglePatentsTool.
// ---------------------------------------------------------------------------

/** Parse a single citation <tr> element. */
export function parseCitationElement($: cheerio.CheerioAPI, element: AnyNode): Citation {
  const result: Citation = {
    patent_number: '',
    priority_date: '',
    pub_date: ''
  };

  const $el = $(element);

  try {
    const pubNum = $el.find('span[itemprop="publicationNumber"]').first();
    if (pubNum.length > 0) {
      result.patent_number = pubNum.text().trim();
    }
  } catch {}

  try {
    const priorityDate = $el.find('td[itemprop="priorityDate"]').first();
    if (priorityDate.length > 0) {
      result.priority_date = priorityDate.text().trim();
    }
  } catch {}

  try {
    const pubDate = $el.find('td[itemprop="publicationDate"]').first();
    if (pubDate.length > 0) {
      result.pub_date = pubDate.text().trim();
    }
  } catch {}

  return result;
}

interface ExtractCitationsResult {
  forwardCitesNoFamily: Citation[];
  forwardCitesYesFamily: Citation[];
  backwardCitesNoFamily: Citation[];
  backwardCitesYesFamily: Citation[];
}

/** Extract forward/backward citations from a Google Patents page. */
export function extractCitations($: cheerio.CheerioAPI): ExtractCitationsResult {
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
      citations.push(parseCitationElement($, elem));
    });
    result[key] = citations;
  }
  return result;
}

/** Extract timeline events (priority, filed, granted, publication, etc.). */
export function extractEvents($: cheerio.CheerioAPI): {
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
    pub_date: ''
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

      if (titleText === 'priority') {
        result.priority_date = timeEvent;
      } else if (titleText === 'filed') {
        result.filing_date = timeEvent;
      } else if (titleText === 'granted') {
        result.grant_date = timeEvent;
      } else if (titleText === 'publication') {
        if (!result.pub_date) {
          result.pub_date = timeEvent;
        }
      }

      const titleSpan = $event.find('span[itemprop="title"]').first();
      if (titleSpan.length > 0 && titleSpan.text().toLowerCase().includes('expiration')) {
        result.expiration_date = timeEvent;
      }
    } catch {
      // Continue
    }
  });

  return result;
}

/** Extract legal status (IFI status, estimated expiration, events). */
export function extractLegalStatus($: cheerio.CheerioAPI): LegalStatus {
  const legal: LegalStatus = {
    status: '',
    ifi_status: '',
    estimated_expiration: '',
    events: []
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
  } catch {
    // Ignore
  }

  $('dd[itemprop="events"]').each((_index: number, appEvent: AnyNode) => {
    try {
      const $event = $(appEvent);
      const titleInfo = $event.find('span[itemprop="type"]').first();

      if (titleInfo.length === 0) return;

      const titleText = titleInfo.text().trim();

      if (titleText === 'legal-status') {
        const timeTag = $event.find('time[itemprop="date"]').first();
        if (timeTag.length > 0) {
          const dateText = timeTag.text().trim();

          if (dateText === 'Status') {
            const titleSpan = $event.find('span[itemprop="title"]').first();
            if (titleSpan.length > 0) {
              const statusText = titleSpan.text().trim();
              legal.status = statusText.replace('Current', '').trim();
            }
          } else if (dateText && dateText[0] && /\d/.test(dateText[0])) {
            legal.estimated_expiration = dateText;
            const titleSpan = $event.find('span[itemprop="title"]').first();
            if (titleSpan.length > 0) {
              legal.events.push({
                type: titleSpan.text().trim(),
                date: dateText,
                title: ''
              });
            }
          }
        }
      }
    } catch {
      // Continue
    }
  });

  return legal;
}

/** Extract IPC/CPC classification strings. */
export function extractClassifications($: cheerio.CheerioAPI): string[] {
  const clsArray: string[] = [];
  $('dd[itemprop="classifications"]').each((_index: number, elem: AnyNode) => {
    clsArray.push($(elem).text().trim());
  });
  return clsArray;
}

// ---------------------------------------------------------------------------
// GooglePatentsScraper class
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

  async requestSinglePatent(patent: string, url: boolean = false): Promise<[string, cheerio.CheerioAPI | null, string]> {
    try {
      let requestUrl: string;
      if (!url) {
        requestUrl = `https://patents.google.com/patent/${patent}`;
      } else {
        requestUrl = patent;
      }

      const html = await fetchHtml(requestUrl, {
        'User-Agent': 'Mozilla/5.0',
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

  private extractEvents($: cheerio.CheerioAPI) {
    return extractEvents($);
  }

  private extractLegalStatus($: cheerio.CheerioAPI): LegalStatus {
    return extractLegalStatus($);
  }

  processPatentHtml($: cheerio.CheerioAPI): PatentData {
    let titleText = '';
    try {
      const title = $('meta[name="DC.title"]').first();
      if (title.length > 0) {
        titleText = title.attr('content')?.trim() ?? '';
      }
    } catch {
      // Ignore
    }

    let inventorName = '';
    try {
      const inventors: Array<{ inventor_name: string }> = [];
      $('dd[itemprop="inventor"]').each((_index: number, elem: AnyNode) => {
        inventors.push({
          inventor_name: $(elem).text().trim()
        });
      });
      inventorName = JSON.stringify(inventors);
    } catch {
      inventorName = '[]';
    }

    let assigneeNameOrig = '';
    try {
      const assignees: Array<{ assignee_name: string }> = [];
      $('dd[itemprop="assigneeOriginal"]').each((_index: number, elem: AnyNode) => {
        assignees.push({
          assignee_name: $(elem).text().trim()
        });
      });
      assigneeNameOrig = JSON.stringify(assignees);
    } catch {
      assigneeNameOrig = '[]';
    }

    let assigneeNameCurrent = '';
    try {
      const assignees: Array<{ assignee_name: string }> = [];
      $('dd[itemprop="assigneeCurrent"]').each((_index: number, elem: AnyNode) => {
        assignees.push({
          assignee_name: $(elem).text().trim()
        });
      });
      assigneeNameCurrent = JSON.stringify(assignees);
    } catch {
      assigneeNameCurrent = '[]';
    }

    let pubDate = '';
    try {
      const pubDateElem = $('dd[itemprop="publicationDate"]').first();
      if (pubDateElem.length > 0) {
        pubDate = pubDateElem.text().trim();
      }
    } catch {
      // Ignore
    }

    let applicationNumber = '';
    try {
      const appNumElem = $('dd[itemprop="applicationNumber"]').first();
      if (appNumElem.length > 0) {
        applicationNumber = appNumElem.text().trim();
      }
    } catch {
      // Ignore
    }

    const events = this.extractEvents($);

    if (!pubDate && events.pub_date) {
      pubDate = events.pub_date;
    }

    let legal: LegalStatus;
    if (this.returnLegal) {
      legal = this.extractLegalStatus($);
    } else {
      legal = {
        status: '',
        ifi_status: '',
        estimated_expiration: '',
        events: []
      };
    }

    const citations = extractCitations($);
    const forwardCitesNoFamily = JSON.stringify(citations.forwardCitesNoFamily);
    const forwardCitesYesFamily = JSON.stringify(citations.forwardCitesYesFamily);
    const backwardCitesNoFamily = JSON.stringify(citations.backwardCitesNoFamily);
    const backwardCitesYesFamily = JSON.stringify(citations.backwardCitesYesFamily);

    let abstractText = '';
    if (this.returnAbstract) {
      try {
        const abstract = $('meta[name="DC.description"]').first();
        if (abstract.length > 0) {
          abstractText = abstract.attr('content')?.trim() ?? '';
        }
      } catch {
        // Ignore
      }
    }

    let pdfUrl = '';
    try {
      const pdfMeta = $('meta[name="citation_pdf_url"]').first();
      if (pdfMeta.length > 0) {
        pdfUrl = pdfMeta.attr('content') ?? '';
      }
    } catch {
      // Ignore
    }

    const classifications = JSON.stringify(extractClassifications($));

    return {
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
      abstract_text: abstractText
    };
  }

  getScrapedData($: cheerio.CheerioAPI, patent: string, url: string): PatentData {
    const parsing = this.processPatentHtml($);
    parsing.url = url;
    parsing.patent = patent;
    return parsing;
  }

  async scrapeAllPatents(): Promise<void> {
    if (this.listOfPatents.length === 0) {
      throw new NoPatentsError(
        "no patents to scrape specified in 'patent' variable: " +
        "add patent using class.addPatents([<PATENTNUMBER>])"
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

// 向后兼容别名
export const scraper_class = GooglePatentsScraper;