/**
 * 测试: 错误类
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NuoPatentError,
  PatentClassError,
  NoPatentsError,
  PDFDownloadError,
  CNIPAQueryError,
  TimeoutError,
  ParseError,
} from '../src/errors.js';

describe('NuoPatentError', () => {
  it('基础属性和继承链', () => {
    const err = new NuoPatentError('test error');
    assert.equal(err.name, 'NuoPatentError');
    assert.equal(err.message, 'test error');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof NuoPatentError);
  });

  it('携带 patentNumber 上下文', () => {
    const err = new NuoPatentError('test', 'US123A');
    assert.equal(err.patentNumber, 'US123A');
  });
});

describe('PatentClassError', () => {
  it('正确的错误名称和继承链', () => {
    const err = new PatentClassError('bad type');
    assert.equal(err.name, 'PatentClassError');
    assert.ok(err instanceof NuoPatentError);
    assert.ok(err instanceof PatentClassError);
  });
});

describe('NoPatentsError', () => {
  it('正确的错误名称', () => {
    const err = new NoPatentsError('no patents');
    assert.equal(err.name, 'NoPatentsError');
    assert.ok(err instanceof NuoPatentError);
  });
});

describe('PDFDownloadError', () => {
  it('携带专利号', () => {
    const err = new PDFDownloadError('download failed', 'US123A');
    assert.equal(err.name, 'PDFDownloadError');
    assert.equal(err.patentNumber, 'US123A');
  });
});

describe('CNIPAQueryError', () => {
  it('正确的错误名称', () => {
    const err = new CNIPAQueryError('cnipa failed');
    assert.equal(err.name, 'CNIPAQueryError');
  });
});

describe('TimeoutError', () => {
  it('携带超时时间', () => {
    const err = new TimeoutError('timeout', 30000, 'US123A');
    assert.equal(err.name, 'TimeoutError');
    assert.equal(err.timeoutMs, 30000);
    assert.equal(err.patentNumber, 'US123A');
  });
});

describe('ParseError', () => {
  it('携带字段名', () => {
    const err = new ParseError('parse failed', 'title', 'US123A');
    assert.equal(err.name, 'ParseError');
    assert.equal(err.field, 'title');
    assert.equal(err.patentNumber, 'US123A');
  });
});

describe('错误分类处理（智能体使用场景）', () => {
  it('可通过 instanceof 区分错误类型', () => {
    const networkErr = new NuoPatentError('network down');
    const timeoutErr = new TimeoutError('timeout', 5000);
    const parseErr = new ParseError('bad html', 'abstract_text');

    // 智能体可以这样处理
    function handleError(err: Error): string {
      if (err instanceof TimeoutError) return 'RETRY';
      if (err instanceof ParseError) return 'WARN_PARSE';
      if (err instanceof NuoPatentError) return 'ERROR';
      return 'UNKNOWN';
    }

    assert.equal(handleError(networkErr), 'ERROR');
    assert.equal(handleError(timeoutErr), 'RETRY');
    assert.equal(handleError(parseErr), 'WARN_PARSE');
  });
});
