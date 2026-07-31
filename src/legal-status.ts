/**
 * nuo-patent · 法律状态 & 年费查询器
 */

import * as cheerio from 'cheerio';
import type {
  LegalStatusResult,
  AnnuityStatus,
  TimelineEvent,
  Logger,
  LegalStatusOptions,
} from './types.js';
import { noopLogger } from './types.js';
import { GooglePatentsScraper } from './scraper.js';

export class LegalStatusChecker {
  private scraper: GooglePatentsScraper;

  constructor(scraper?: GooglePatentsScraper) {
    this.scraper = scraper ?? new GooglePatentsScraper(false, true);
  }

  /**
   * 查询单个专利的法律状态。
   *
   * @param patentNumber - 专利号
   * @param signal - 可选的 AbortSignal
   * @param logger - 可选日志接口
   */
  async check(
    patentNumber: string,
    signal?: AbortSignal,
    logger: Logger = noopLogger,
  ): Promise<LegalStatusResult> {
    const [error, soup, url] = await this.scraper.requestSinglePatent(patentNumber);

    if (error !== 'Success' || !soup) {
      logger.warn(`查询 ${patentNumber} 法律状态失败: ${error}`);
      return {
        patent_number: patentNumber,
        title: '',
        status: 'UNKNOWN',
        ifi_status: '',
        estimated_expiration: '',
        filing_date: '',
        grant_date: '',
        applicant: '',
        inventor: '',
        events_summary: [],
        url: url,
        error: String(error),
      };
    }

    // 响应取消信号
    if (signal?.aborted) {
      return {
        patent_number: patentNumber,
        title: '',
        status: 'UNKNOWN',
        ifi_status: '',
        estimated_expiration: '',
        filing_date: '',
        grant_date: '',
        applicant: '',
        inventor: '',
        events_summary: [],
        url: url,
        error: '请求已被取消',
      };
    }

    const data = this.scraper.processPatentHtml(soup);
    const eventsSummary = this.extractEvents(soup);

    return {
      patent_number: patentNumber,
      title: data.title || '',
      status: data.legal_status || '',
      ifi_status: data.ifi_status || '',
      estimated_expiration: data.estimated_expiration || '',
      filing_date: data.filing_date || '',
      grant_date: data.grant_date || '',
      applicant: data.assignee_name_current || '',
      inventor: data.inventor_name || '',
      events_summary: eventsSummary,
      url: url,
    };
  }

  /**
   * 批量查询法律状态（并发执行）。
   *
   * @param patentNumbers - 专利号列表
   * @param options - 查询选项（signal, logger, maxConcurrency）
   */
  async checkBatch(
    patentNumbers: string[],
    options: LegalStatusOptions = {},
  ): Promise<Record<string, LegalStatusResult>> {
    const { signal, logger = noopLogger, maxConcurrency = 4 } = options;
    const results: Record<string, LegalStatusResult> = {};

    logger.info(`开始批量查询 ${patentNumbers.length} 篇专利法律状态 (并发数: ${maxConcurrency})`);

    // 并发分批处理
    for (let i = 0; i < patentNumbers.length; i += maxConcurrency) {
      if (signal?.aborted) {
        for (const pn of patentNumbers.slice(i)) {
          results[pn] = {
            patent_number: pn,
            title: '',
            status: 'UNKNOWN',
            ifi_status: '',
            estimated_expiration: '',
            filing_date: '',
            grant_date: '',
            applicant: '',
            inventor: '',
            events_summary: [],
            url: '',
            error: '请求已被取消',
          };
        }
        break;
      }

      const batch = patentNumbers.slice(i, i + maxConcurrency);
      const batchPromises = batch.map(pn =>
        this.check(pn, signal, logger),
      );

      const batchResults = await Promise.allSettled(batchPromises);
      for (let j = 0; j < batch.length; j++) {
        const settled = batchResults[j];
        if (settled.status === 'fulfilled') {
          results[batch[j]] = settled.value;
        } else {
          const error = settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason);
          logger.warn(`${batch[j]} 查询失败: ${error}`);
          results[batch[j]] = {
            patent_number: batch[j],
            title: '',
            status: 'UNKNOWN',
            ifi_status: '',
            estimated_expiration: '',
            filing_date: '',
            grant_date: '',
            applicant: '',
            inventor: '',
            events_summary: [],
            url: '',
            error,
          };
        }
      }
    }

    return results;
  }

  /**
   * 格式化法律状态报告（面向人类可读输出）。
   */
  formatStatusReport(result: LegalStatusResult): string {
    const lines: string[] = [];
    lines.push(`📋 专利: ${result.patent_number}`);
    lines.push(`  标题: ${result.title || 'N/A'}`);
    lines.push(`  法律状态: ${result.status || 'N/A'}`);
    lines.push(`  预估到期日: ${result.estimated_expiration || 'N/A'}`);
    lines.push(`  申请日: ${result.filing_date || 'N/A'}`);
    lines.push(`  授权日: ${result.grant_date || 'N/A'}`);

    // 过期检查
    const expiration = result.estimated_expiration;
    if (expiration) {
      try {
        const expDate = new Date(expiration);
        const now = new Date();
        if (expDate < now) {
          lines.push(`  ⚠️  已过期 (${expiration})`);
        } else {
          const remainingDays = Math.ceil(
            (expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );
          lines.push(`  ✅ 有效, 剩余 ${remainingDays} 天`);
        }
      } catch {
        // 日期解析错误时跳过
      }
    }

    return lines.join('\n');
  }

  /**
   * 查询年费状态。
   *
   * @param patentNumber - 专利号
   * @param signal - 可选的 AbortSignal
   * @param logger - 可选日志接口
   */
  async checkAnnuityStatus(
    patentNumber: string,
    signal?: AbortSignal,
    logger: Logger = noopLogger,
  ): Promise<AnnuityStatus> {
    const result = await this.check(patentNumber, signal, logger);
    const feeEvents: TimelineEvent[] = [];

    for (const event of result.events_summary) {
      const eventText = `${event.title} ${event.type}`.toLowerCase();
      const feeKeywords = ['fee', 'maintenance', 'annuity', 'payment'];

      if (feeKeywords.some(keyword => eventText.includes(keyword))) {
        feeEvents.push(event);
      }
    }

    return {
      patent_number: patentNumber,
      status: result.status || '',
      estimated_expiration: result.estimated_expiration || '',
      fee_events: feeEvents,
      note: '年费详情建议查询 USPTO Patent Maintenance Fee Store 或对应国家专利局',
    };
  }

  private extractEvents($: cheerio.CheerioAPI): TimelineEvent[] {
    const eventsSummary: TimelineEvent[] = [];

    $('dd[itemprop="events"]').each((_i, ev) => {
      try {
        const $ev = $(ev);
        const evType = $ev.find('span[itemprop="type"]').first();
        const evTime = $ev.find('time[itemprop="date"]').first();
        const evTitle = $ev.find('span[itemprop="title"]').first();

        if (evType.length > 0 && evTime.length > 0) {
          eventsSummary.push({
            type: evType.text().trim(),
            date: evTime.text().trim(),
            title: evTitle.length > 0 ? evTitle.text().trim() : '',
          });
        }
      } catch {
        // 跳过格式不正确的元素
      }
    });

    return eventsSummary;
  }
}
