/**
 * 测试: 纯解析函数（使用 cheerio + mock HTML）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import {
  parsePatentHtml,
  extractCitations,
  extractEvents,
  extractLegalStatus,
  extractClassifications,
} from '../src/scraper.js';

// 模拟 Google Patents 页面的最小 HTML
function mockPatentHtml(overrides: Record<string, string> = {}): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta name="DC.title" content="${overrides.title ?? 'Test Patent Title'}">
  <meta name="DC.description" content="${overrides.abstract ?? 'This is a test patent abstract.'}">
  <meta name="citation_pdf_url" content="${overrides.pdf_url ?? 'https://patentimages.example.com/pdfs/US1234567B2.pdf'}">
</head>
<body>
  <dd itemprop="applicationNumber">${overrides.app_number ?? 'US2020123456'}</dd>

  <dd itemprop="inventor">John Doe</dd>
  <dd itemprop="inventor">Jane Smith</dd>

  <dd itemprop="assigneeOriginal">Original Corp</dd>
  <dd itemprop="assigneeCurrent">Current Corp</dd>

  <dd itemprop="publicationDate">2023-06-15</dd>

  <dd itemprop="legalStatusIfi">Active, expires 2035-01-15</dd>

  <dd itemprop="classifications">H01L 29/78</dd>
  <dd itemprop="classifications">G06F 17/00</dd>

  <dd itemprop="events">
    <span itemprop="type">priority</span>
    <time itemprop="date">2022-01-15</time>
  </dd>
  <dd itemprop="events">
    <span itemprop="type">filed</span>
    <time itemprop="date">2023-01-15</time>
  </dd>
  <dd itemprop="events">
    <span itemprop="type">granted</span>
    <time itemprop="date">2024-06-15</time>
  </dd>
  <dd itemprop="events">
    <span itemprop="type">publication</span>
    <time itemprop="date">2023-06-15</time>
  </dd>
  <dd itemprop="events">
    <span itemprop="type">legal-status</span>
    <time itemprop="date">Status</time>
    <span itemprop="title">Active</span>
  </dd>

  <table>
  <tr itemprop="forwardReferencesOrig">
    <td><span itemprop="publicationNumber">US8888888B2</span></td>
    <td itemprop="priorityDate">2020-01-01</td>
    <td itemprop="publicationDate">2022-01-01</td>
  </tr>
  <tr itemprop="backwardReferences">
    <td><span itemprop="publicationNumber">US7777777A</span></td>
    <td itemprop="priorityDate">2018-01-01</td>
    <td itemprop="publicationDate">2020-01-01</td>
  </tr>
  </table>
</body>
</html>`;
}

describe('parsePatentHtml', () => {
  it('解析完整专利 HTML', () => {
    const html = mockPatentHtml();
    const $ = cheerio.load(html);
    const { data, warnings } = parsePatentHtml($);

    // 完整 HTML 解析不应产生警告
    assert.equal(warnings.length, 0);
    assert.equal(data.title, 'Test Patent Title');
    assert.equal(data.application_number, 'US2020123456');
    assert.equal(data.pub_date, '2023-06-15');
    assert.equal(data.filing_date, '2023-01-15');
    assert.equal(data.priority_date, '2022-01-15');
    assert.equal(data.grant_date, '2024-06-15');
    assert.equal(data.abstract_text, 'This is a test patent abstract.');
    assert.equal(data.legal_status, 'Active');
    assert.equal(data.ifi_status, 'Active, expires 2035-01-15');
    assert.equal(data.estimated_expiration, '2035-01-15');
    assert.ok(data.pdf_url.includes('US1234567B2.pdf'));
  });

  it('发明人是 JSON 字符串', () => {
    const html = mockPatentHtml();
    const $ = cheerio.load(html);
    const { data } = parsePatentHtml($);

    const inventors = JSON.parse(data.inventor_name);
    assert.equal(inventors.length, 2);
    assert.equal(inventors[0].inventor_name, 'John Doe');
  });

  it('受让人是 JSON 字符串', () => {
    const html = mockPatentHtml();
    const $ = cheerio.load(html);
    const { data } = parsePatentHtml($);

    const orig = JSON.parse(data.assignee_name_orig);
    assert.equal(orig[0].assignee_name, 'Original Corp');

    const current = JSON.parse(data.assignee_name_current);
    assert.equal(current[0].assignee_name, 'Current Corp');
  });

  it('分类是 JSON 字符串', () => {
    const html = mockPatentHtml();
    const $ = cheerio.load(html);
    const { data } = parsePatentHtml($);

    const cls = JSON.parse(data.classifications);
    assert.ok(Array.isArray(cls));
    assert.ok(cls.includes('H01L 29/78'));
  });

  it('returnAbstract=false 时不提取摘要', () => {
    const html = mockPatentHtml();
    const $ = cheerio.load(html);
    const { data } = parsePatentHtml($, { returnAbstract: false });

    assert.equal(data.abstract_text, '');
  });

  it('returnLegal=false 时不提取法律状态', () => {
    const html = mockPatentHtml();
    const $ = cheerio.load(html);
    const { data } = parsePatentHtml($, { returnLegal: false });

    assert.equal(data.legal_status, '');
    assert.equal(data.ifi_status, '');
  });

  it('缺失字段时产生 parseWarnings', () => {
    const minimalHtml = `
<!DOCTYPE html>
<html>
<head></head>
<body></body>
</html>`;
    const $ = cheerio.load(minimalHtml);
    const { data, warnings } = parsePatentHtml($);

    assert.equal(data.title, '');
    assert.ok(warnings.length > 0, '应该有警告');
    assert.ok(warnings.some(w => w.field === 'title'), '标题缺失应有警告');
  });

  it('空 HTML 不会崩溃', () => {
    const $ = cheerio.load('');
    const { data, warnings } = parsePatentHtml($);

    assert.equal(data.title, '');
    assert.ok(Array.isArray(warnings));
  });
});

describe('extractCitations', () => {
  it('提取前后向引证', () => {
    const html = mockPatentHtml();
    const $ = cheerio.load(html);
    const citations = extractCitations($);

    assert.equal(citations.forwardCitesNoFamily.length, 1);
    assert.equal(citations.forwardCitesNoFamily[0].patent_number, 'US8888888B2');
    assert.equal(citations.backwardCitesNoFamily.length, 1);
    assert.equal(citations.backwardCitesNoFamily[0].patent_number, 'US7777777A');
  });

  it('无引证时不崩溃', () => {
    const $ = cheerio.load('<html><body></body></html>');
    const citations = extractCitations($);
    assert.equal(citations.forwardCitesNoFamily.length, 0);
  });
});

describe('extractEvents', () => {
  it('提取时间线事件', () => {
    const html = mockPatentHtml();
    const $ = cheerio.load(html);
    const events = extractEvents($);

    assert.equal(events.priority_date, '2022-01-15');
    assert.equal(events.filing_date, '2023-01-15');
    assert.equal(events.grant_date, '2024-06-15');
    assert.equal(events.pub_date, '2023-06-15');
  });
});

describe('extractLegalStatus', () => {
  it('提取法律状态', () => {
    const html = mockPatentHtml();
    const $ = cheerio.load(html);
    const legal = extractLegalStatus($);

    assert.equal(legal.status, 'Active');
    assert.equal(legal.ifi_status, 'Active, expires 2035-01-15');
    assert.equal(legal.estimated_expiration, '2035-01-15');
  });
});

describe('extractClassifications', () => {
  it('提取 IPC/CPC 分类', () => {
    const html = mockPatentHtml();
    const $ = cheerio.load(html);
    const cls = extractClassifications($);

    assert.ok(cls.includes('H01L 29/78'));
    assert.ok(cls.includes('G06F 17/00'));
  });
});
