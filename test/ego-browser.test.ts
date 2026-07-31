/**
 * 测试: ego-browser 抓取后端
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { isEgoBrowserAvailable, fetchHtmlWithEgoBrowser, resetEgoBrowserCache } from '../src/ego-browser.js';

before(() => {
  resetEgoBrowserCache();
});

describe('ego-browser 抓取后端', () => {
  describe('isEgoBrowserAvailable', () => {
    it('返回布尔值（本机检测）', () => {
      const available = isEgoBrowserAvailable();
      assert.equal(typeof available, 'boolean');
    });

    it('环境变量 NUO_PATENT_EGO_BROWSER=0 时禁用', () => {
      resetEgoBrowserCache();
      process.env.NUO_PATENT_EGO_BROWSER = '0';
      assert.equal(isEgoBrowserAvailable(), false);
      delete process.env.NUO_PATENT_EGO_BROWSER;
      resetEgoBrowserCache();
    });
  });

  describe('fetchHtmlWithEgoBrowser', () => {
    it('能取回 example.com 渲染后 HTML（含 html 标签）', async () => {
      const available = isEgoBrowserAvailable();
      if (!available) {
        // 环境无 ego-browser 时跳过真实抓取
        assert.ok(true, 'ego-browser 不可用，跳过真实抓取测试');
        return;
      }
      const html = await fetchHtmlWithEgoBrowser('https://example.com/', {
        timeout: 45000,
      });
      assert.ok(html.length > 100, `HTML 过短: ${html.length}`);
      assert.match(html, /<html/i);
      assert.match(html, /Example Domain/);
    }, 120_000);

    it('不可达地址时抛错（含 ego-browser 前缀）', async () => {
      const available = isEgoBrowserAvailable();
      if (!available) {
        assert.ok(true, 'ego-browser 不可用，跳过');
        return;
      }
      await assert.rejects(
        fetchHtmlWithEgoBrowser('http://127.0.0.1:1/', { timeout: 15000 }),
        /ego-browser|抓取失败|not found/i,
      );
    }, 120_000);
  });
});
