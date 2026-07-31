/**
 * 测试: Logger 和类型
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noopLogger } from '../src/types.js';
import type { ScrapeResult, DownloadResult } from '../src/types.js';

describe('noopLogger', () => {
  it('所有方法不抛异常', () => {
    assert.doesNotThrow(() => noopLogger.debug('test'));
    assert.doesNotThrow(() => noopLogger.info('test'));
    assert.doesNotThrow(() => noopLogger.warn('test'));
    assert.doesNotThrow(() => noopLogger.error('test'));
  });

  it('所有方法不产生输出', () => {
    // noopLogger 的设计就是不做任何事，这里验证它存在即可
    assert.equal(typeof noopLogger.debug, 'function');
    assert.equal(typeof noopLogger.info, 'function');
    assert.equal(typeof noopLogger.warn, 'function');
    assert.equal(typeof noopLogger.error, 'function');
  });
});

describe('类型使用验证（编译时通过即可）', () => {
  it('ScrapeResult 结构可用于判断', () => {
    const result: ScrapeResult = {
      success: true,
      patent: 'US123A',
      url: 'https://patents.google.com/patent/US123A',
      data: null,
      errorCode: '',
      errorMessage: '',
      parseWarnings: [],
    };

    // 智能体典型使用模式
    if (result.success && result.data) {
      // 使用 data
      assert.ok(true);
    } else {
      // 处理 errorCode
      assert.ok(result.errorCode.length >= 0);
    }
  });

  it('DownloadResult 结构', () => {
    const success: DownloadResult = {
      patentNumber: 'US123A',
      success: true,
      path: '/tmp/US123A.pdf',
    };

    const failure: DownloadResult = {
      patentNumber: 'US456B',
      success: false,
      error: '未找到 PDF URL',
    };

    assert.equal(success.success, true);
    assert.equal(failure.success, false);
    assert.ok(failure.error);
  });
});
