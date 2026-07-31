/**
 * nuo-patent · ego-browser (ego-lite) 抓取后端
 *
 * ego-browser 是基于 Chromium 的浏览器运行时，AI Agent 通过
 * `ego-browser nodejs` 以 stdin 传入 Node.js 脚本驱动真实浏览器。
 * 相比原生 fetch / 代理隧道，浏览器环境能稳定通过 Google Patents
 * 等站点的反爬校验（真实指纹、JS 渲染、Cookie 状态），在 macOS 上
 * 效果更佳，故优先使用；不可用时自动回退原生网络栈。
 */

import { exec, execFile } from 'node:child_process';
import type { ExecException } from 'node:child_process';
import type { Logger } from './types.js';
import { noopLogger } from './types.js';

/** 环境变量开关：NUO_PATENT_EGO_BROWSER=0 禁用，=1 强制启用（非 macOS 也可用） */
const EGO_ENV_KEY = 'NUO_PATENT_EGO_BROWSER';

/** 命令检测结果缓存 — 首次调用时才执行 which，避免模块加载 I/O */
let _egoAvailable: boolean | null = null;

/**
 * 判断 ego-browser 是否可用。
 * - 默认仅 macOS (darwin) 平台启用；其他平台需环境变量强制。
 * - NUO_PATENT_EGO_BROWSER=0 显式禁用。
 * - NUO_PATENT_EGO_BROWSER=1 强制启用（跳过平台与命令检测）。
 */
export function isEgoBrowserAvailable(): boolean {
  if (_egoAvailable !== null) return _egoAvailable;

  const env = process.env[EGO_ENV_KEY];
  if (env === '0') {
    _egoAvailable = false;
    return false;
  }
  if (env === '1') {
    _egoAvailable = true;
    return true;
  }

  // 非 macOS 默认关闭，除非强制启用
  if (process.platform !== 'darwin') {
    _egoAvailable = false;
    return false;
  }

  try {
    execFile('which', ['ego-browser'], { timeout: 3000 });
    _egoAvailable = true;
  } catch {
    _egoAvailable = false;
  }
  return _egoAvailable;
}

/** 仅供测试：重置缓存 */
export function resetEgoBrowserCache(): void {
  _egoAvailable = null;
}

export interface EgoFetchOptions {
  signal?: AbortSignal;
  timeout?: number;
  logger?: Logger;
}

/**
 * 通过 ego-browser 打开页面并取回完整渲染后的 HTML。
 * 使用独立 task space（随机后缀）避免并发请求竞争，取回后立即关闭。
 */
export function fetchHtmlWithEgoBrowser(
  targetUrl: string,
  options: EgoFetchOptions = {},
): Promise<string> {
  const { signal, timeout = 30000, logger = noopLogger } = options;
  const spaceName = `nuo-patent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tabTimeoutSec = Math.max(10, Math.floor(timeout / 1000));

  // heredoc 脚本体：在 ego-browser 的 Node 运行时中执行
  const script = [
    `const task = await useOrCreateTaskSpace(${JSON.stringify(spaceName)})`,
    `try {`,
    `  await openOrReuseTab(${JSON.stringify(targetUrl)}, { wait: true, timeout: ${tabTimeoutSec} })`,
    `  const status = await js(String.raw\`performance.getEntriesByType('navigation')[0]?.responseStatus ?? 0\`)`,
    `  if (!status || status >= 400) throw new Error('HTTP ' + status)`,
    `  const html = await js(String.raw\`document.documentElement.outerHTML\`)`,
    `  cliLog('NUO_START')`,
    `  cliLog(Buffer.from(html, 'utf8').toString('base64'))`,
    `  cliLog('NUO_END')`,
    `} finally {`,
    `  await completeTaskSpace(task.id, { keep: false })`,
    `}`,
  ].join('\n');

  return new Promise<string>((resolve, reject) => {
    logger.info(`[ego-browser] 打开 ${targetUrl}`);

    const child = exec(
      'ego-browser nodejs',
      {
        timeout: timeout + 15000, // 子进程整体多给 15s（浏览器启动、页面加载）
        maxBuffer: 128 * 1024 * 1024, // HTML base64 可能达数 MB，放宽 stdout 上限
        signal,
      },
      (err: ExecException | null, stdout: string, stderr: string) => {
        if (err) {
          const detail = (stderr || '').trim().split('\n').pop() || err.message;
          reject(new Error(`ego-browser 抓取失败: ${detail}`));
          return;
        }
        try {
          // ego-browser 的 cliLog 输出到 stderr，成功时合并两流提取标记
          resolve(extractHtmlFromStdout(`${stdout}\n${stderr}`));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    );
    // exec 不支持 input 选项，手动写入脚本后关闭 stdin
    child.stdin?.write(script + '\n');
    child.stdin?.end();

    // execFile 的 signal 选项在 abort 时 kill 子进程，但未提供明确回调；
    // 这里补一个监听，保证 abort 时 Promise 一定被拒绝
    if (signal) {
      const onAbort = () => {
        child.kill('SIGKILL');
        reject(new Error('Request aborted'));
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

/** 从 ego-browser stdout 中提取 NUO_START / NUO_END 标记之间的 base64 并解码 */
function extractHtmlFromStdout(stdout: string): string {
  const start = stdout.indexOf('NUO_START');
  const end = stdout.lastIndexOf('NUO_END');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('ego-browser 输出中未找到有效 HTML 标记');
  }
  const b64 = stdout.slice(start + 'NUO_START'.length, end).replace(/\s+/g, '');
  return Buffer.from(b64, 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------
// 默认导出的便捷聚合
// ---------------------------------------------------------------------------

export default {
  isEgoBrowserAvailable,
  fetchHtmlWithEgoBrowser,
  resetEgoBrowserCache,
};
