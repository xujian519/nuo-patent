/**
 * 测试: 专利号校验与规范化
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePatentNumber, normalizePatentNumber } from '../src/scraper.js';

describe('validatePatentNumber', () => {
  it('合法美国专利号', () => {
    const result = validatePatentNumber('US11452699B2');
    assert.equal(result.valid, true);
    assert.equal(result.normalized, 'US11452699B2');
  });

  it('合法中国专利号', () => {
    const result = validatePatentNumber('CN122072823A');
    assert.equal(result.valid, true);
    assert.equal(result.normalized, 'CN122072823A');
  });

  it('合法欧洲专利号', () => {
    const result = validatePatentNumber('EP1234567B1');
    assert.equal(result.valid, true);
    assert.equal(result.normalized, 'EP1234567B1');
  });

  it('合法 PCT 专利号', () => {
    const result = validatePatentNumber('WO2020123456A1');
    assert.equal(result.valid, true);
    assert.equal(result.normalized, 'WO2020123456A1');
  });

  it('合法 DE 专利号', () => {
    const result = validatePatentNumber('DE102022123456A1');
    assert.equal(result.valid, true);
  });

  it('小写自动转大写', () => {
    const result = validatePatentNumber('us11452699b2');
    assert.equal(result.valid, true);
    assert.equal(result.normalized, 'US11452699B2');
  });

  it('含空格自动去除', () => {
    const result = validatePatentNumber('US 11452699 B2');
    assert.equal(result.valid, true);
    assert.equal(result.normalized, 'US11452699B2');
  });

  it('首尾空格去除', () => {
    const result = validatePatentNumber('  US11452699B2  ');
    assert.equal(result.valid, true);
    assert.equal(result.normalized, 'US11452699B2');
  });

  it('空字符串不合法', () => {
    const result = validatePatentNumber('');
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes('不能为空'));
  });

  it('空白字符串不合法', () => {
    const result = validatePatentNumber('   ');
    assert.equal(result.valid, false);
  });

  it('过短不合法', () => {
    const result = validatePatentNumber('US');
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes('过短'));
  });

  it('纯数字不合法', () => {
    const result = validatePatentNumber('11452699');
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes('格式不正确'));
  });

  it('缺少国家码不合法', () => {
    const result = validatePatentNumber('11452699B2');
    assert.equal(result.valid, false);
  });
});

describe('normalizePatentNumber', () => {
  it('去空格、转大写', () => {
    assert.equal(normalizePatentNumber('us 11452699 b2'), 'US11452699B2');
  });

  it('已规范化输入不变', () => {
    assert.equal(normalizePatentNumber('US11452699B2'), 'US11452699B2');
  });

  it('非法格式也处理', () => {
    assert.equal(normalizePatentNumber('abc 123'), 'ABC123');
  });
});
