/**
 * 测试: searchPatents 检索 API + 纯解析函数
 * 通过注入 fetchImpl 绕过网络；禁用 ego-browser 走 fetchImpl 路径。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import {
  searchPatents,
  parseSearchResultsJson,
  parseSearchResultsHtml,
} from '../src/search.js';
import { resetEgoBrowserCache } from '../src/ego-browser.js';

before(() => {
  // 禁用 ego-browser，确保 fetchImpl 注入路径生效
  process.env.NUO_PATENT_EGO_BROWSER = '0';
  resetEgoBrowserCache();
});

/** XHR JSON 接口 fixture */
const XHR_FIXTURE = {
  results: {
    total_num_results: 2,
    cluster: [
      {
        result: [
          {
            patent: {
              publication_number: 'US11452699B2',
              title: 'Thermal management system',
              assignee_current: 'Apple Inc.',
              publication_date: '2022-09-27',
              priority_date: '2019-12-31',
              abstract: 'A thermal management system for electronic devices.',
            },
          },
          {
            patent: {
              publication_number: 'US11563056B2',
              title: 'Battery pack',
              assignee_current: ['Samsung'],
              publication_date: '2023-01-24',
              priority_date: '2020-01-01',
              abstract: '',
            },
          },
        ],
      },
    ],
  },
};

/** HTML 搜索结果页 fixture（回退路径） */
const HTML_FIXTURE = `
<html>
<body>
<search-result>
  <h3><a href="/patent/US11452699B2">Thermal management system</a></h3>
  <dd itemprop="assigneeCurrent">Apple Inc.</dd>
  <dd itemprop="publicationDate">2022-09-27</dd>
  <dd itemprop="priorityDate">2019-12-31</dd>
  <div class="abstract">A thermal management system for electronic devices.</div>
</search-result>
<search-result>
  <h3><a href="/patent/US11563056B2">Battery pack</a></h3>
  <dd itemprop="assigneeCurrent">Samsung</dd>
  <dd itemprop="publicationDate">2023-01-24</dd>
  <dd itemprop="priorityDate">2020-01-01</dd>
  <div class="abstract">Battery pack with improved cooling.</div>
</search-result>
</body>
</html>
`;

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseSearchResultsJson（XHR JSON 解析）', () => {
  it('解析标准结构，assignee 兼容 string', () => {
    const { total, hits } = parseSearchResultsJson(XHR_FIXTURE);
    assert.equal(total, 2);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].patent, 'US11452699B2');
    assert.equal(hits[0].assignee, 'Apple Inc.');
    assert.equal(hits[0].url, 'https://patents.google.com/patent/US11452699B2');
  });

  it('assignee 兼容 string[] 与缺失字段', () => {
    const { hits } = parseSearchResultsJson(XHR_FIXTURE);
    assert.equal(hits[1].assignee, 'Samsung');
    assert.equal(hits[1].abstract, '');
  });

  it('空/畸形结构返回空结果不抛异常', () => {
    assert.deepEqual(parseSearchResultsJson(null), { total: 0, hits: [] });
    assert.deepEqual(parseSearchResultsJson({}), { total: 0, hits: [] });
    assert.deepEqual(parseSearchResultsJson({ results: { cluster: [] } }), { total: 0, hits: [] });
  });

  it('缺 publication_number 的条目被跳过', () => {
    const raw = {
      results: {
        total_num_results: 1,
        cluster: [{ result: [{ patent: { title: 'no number' } }] }],
      },
    };
    const { hits } = parseSearchResultsJson(raw);
    assert.equal(hits.length, 0);
  });
});

describe('parseSearchResultsHtml（HTML 回退解析）', () => {
  it('解析 search-result 元素', () => {
    const $ = cheerio.load(HTML_FIXTURE);
    const { hits, warnings } = parseSearchResultsHtml($);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].patent, 'US11452699B2');
    assert.equal(hits[0].title, 'Thermal management system');
    assert.equal(hits[0].assignee, 'Apple Inc.');
    assert.equal(hits[0].publication_date, '2022-09-27');
    assert.equal(hits[0].priority_date, '2019-12-31');
    assert.match(hits[0].abstract, /thermal management/);
    assert.equal(warnings.length, 0);
  });

  it('无 search-result 元素时返回空 + 警告', () => {
    const $ = cheerio.load('<html><body><p>no results</p></body></html>');
    const { hits, warnings } = parseSearchResultsHtml($);
    assert.equal(hits.length, 0);
    assert.ok(warnings.some(w => w.includes('未解析到任何结果')));
  });
});

describe('searchPatents（无状态检索）', () => {
  it('XHR JSON 主路径：返回结构化命中', async () => {
    const result = await searchPatents('thermal management', {
      limit: 10,
      fetchImpl: async () => jsonResponse(XHR_FIXTURE),
    });
    assert.equal(result.hits.length, 2);
    assert.equal(result.total, 2);
    assert.equal(result.hits[0].patent, 'US11452699B2');
    assert.equal(result.warnings.length, 0);
  });

  it('XHR JSON 返回空时回退 HTML 搜索页解析', async () => {
    const emptyXhr = { results: { total_num_results: 0, cluster: [] } };
    let calls = 0;
    const result = await searchPatents('thermal', {
      limit: 10,
      fetchImpl: async (url: string | URL | Request) => {
        calls++;
        const u = String(url);
        if (u.includes('/xhr/query')) return jsonResponse(emptyXhr);
        return new Response(HTML_FIXTURE, { status: 200 });
      },
    });
    assert.equal(calls, 2, 'XHR + HTML 各请求一次');
    assert.equal(result.hits.length, 2);
    assert.equal(result.hits[0].patent, 'US11452699B2');
  });

  it('网络失败返回空结果 + 警告（不抛异常）', async () => {
    const result = await searchPatents('thermal', {
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    assert.equal(result.hits.length, 0);
    assert.ok(result.warnings.some(w => w.includes('检索失败')));
  });

  it('HTTP 错误返回空结果 + 警告', async () => {
    const result = await searchPatents('thermal', {
      fetchImpl: async () => new Response('Forbidden', { status: 403 }),
    });
    assert.equal(result.hits.length, 0);
  });

  it('空查询返回警告不请求', async () => {
    const result = await searchPatents('   ', { fetchImpl: async () => { throw new Error('should not call'); } });
    assert.equal(result.hits.length, 0);
    assert.ok(result.warnings.includes('查询条件为空'));
  });

  it('limit 钳制到 1-50', async () => {
    let requestedNum = '';
    await searchPatents('x', {
      limit: 999,
      fetchImpl: async (url: string | URL | Request) => {
        requestedNum = String(url);
        return jsonResponse(XHR_FIXTURE);
      },
    });
    assert.match(requestedNum, /num=50/);
  });
});
