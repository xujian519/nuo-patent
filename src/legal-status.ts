/**
 * nuo-patent · 法律状态 & 年费查询器
 */

import * as cheerio from 'cheerio';
import {
  LegalStatusResult,
  AnnuityStatus,
  TimelineEvent
} from './types.js';
import { GooglePatentsScraper } from './scraper.js';

export class LegalStatusChecker {
  private scraper: GooglePatentsScraper;

  constructor(scraper?: GooglePatentsScraper) {
    this.scraper = scraper ?? new GooglePatentsScraper(false, true);
  }

  async check(patentNumber: string): Promise<LegalStatusResult> {
    const [error, soup, url] = await this.scraper.requestSinglePatent(patentNumber);

    if (error !== 'Success' || !soup) {
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
        error: String(error)
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
      url: url
    };
  }

  async checkBatch(patentNumbers: string[]): Promise<Record<string, LegalStatusResult>> {
    const results: Record<string, LegalStatusResult> = {};

    for (const pn of patentNumbers) {
      results[pn] = await this.check(pn);
    }

    return results;
  }

  formatStatusReport(result: LegalStatusResult): string {
    const lines: string[] = [];
    lines.push(`📋 专利: ${result.patent_number}`);
    lines.push(`  标题: ${result.title || 'N/A'}`);
    lines.push(`  法律状态: ${result.status || 'N/A'}`);
    lines.push(`  预估到期日: ${result.estimated_expiration || 'N/A'}`);
    lines.push(`  申请日: ${result.filing_date || 'N/A'}`);
    lines.push(`  授权日: ${result.grant_date || 'N/A'}`);

    // 检查是否已过期
    const expiration = result.estimated_expiration;
    if (expiration) {
      try {
        const expDate = new Date(expiration);
        const now = new Date();
        if (expDate < now) {
          lines.push(`  ⚠️  已过期 (${expiration})`);
        } else {
          const remainingDays = Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          lines.push(`  ✅ 有效, 剩余 ${remainingDays} 天`);
        }
      } catch (e) {
        // 日期解析错误时跳过
      }
    }

    return lines.join('\n');
  }

  async checkAnnuityStatus(patentNumber: string): Promise<AnnuityStatus> {
    const result = await this.check(patentNumber);
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
      status: result.status,
      estimated_expiration: result.estimated_expiration,
      fee_events: feeEvents,
      note: '年费详情建议查询 USPTO Patent Maintenance Fee Store 或对应国家专利局'
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
            title: evTitle.length > 0 ? evTitle.text().trim() : ''
          });
        }
      } catch {
        // skip malformed elements
      }
    });

    return eventsSummary;
  }
}
