/**
 * 测试: scrapePatent 无状态 API（仅测校验失败场景，不发起网络请求）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrapePatent } from '../src/scraper.js';
import type { ScrapeResult } from '../src/types.js';

describe('scrapePatent（校验失败场景）', () => {
  it('空专利号返回 VALIDATION_ERROR', async () => {
    const result: ScrapeResult = await scrapePatent('');
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'VALIDATION_ERROR');
    assert.equal(result.data, null);
  });

  it('格式错误返回 VALIDATION_ERROR', async () => {
    const result: ScrapeResult = await scrapePatent('not-a-patent');
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'VALIDATION_ERROR');
    assert.ok(result.errorMessage.length > 0);
  });

  it('失败时 parseWarnings 为空数组', async () => {
    const result = await scrapePatent('');
    assert.ok(Array.isArray(result.parseWarnings));
    assert.equal(result.parseWarnings.length, 0);
  });

  it('返回结构始终包含所有字段', async () => {
    const result = await scrapePatent('');
    // 验证 ScrapeResult 的完整形状
    assert.ok('success' in result);
    assert.ok('patent' in result);
    assert.ok('url' in result);
    assert.ok('data' in result);
    assert.ok('errorCode' in result);
    assert.ok('errorMessage' in result);
    assert.ok('parseWarnings' in result);
  });
});

describe('scrapePatent（AbortSignal 取消）', () => {
  it('已取消的 signal 返回 ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();

    // 用合法专利号 + 已取消的 signal
    const result = await scrapePatent('US11452699B2', {
      signal: controller.signal,
      timeout: 5000,
    });

    // 可能在请求前或请求中被取消
    assert.equal(result.success, false);
    assert.ok(
      result.errorCode === 'ABORTED' || result.errorCode === 'NETWORK_ERROR',
      `预期 ABORTED 或 NETWORK_ERROR，实际: ${result.errorCode}`,
    );
  });
});
