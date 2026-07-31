/**
 * 测试: CLI 命令（仅测非网络部分）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const execFileAsync = promisify(execFile);
const cliPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../dist/cli.js',
);

async function runCli(...args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'node',
      [cliPath, ...args],
      { timeout: 5000 },
    );
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout?.trim() ?? '',
      stderr: e.stderr?.trim() ?? '',
      exitCode: e.code ?? 1,
    };
  }
}

describe('CLI', () => {
  describe('--help', () => {
    it('输出帮助信息', async () => {
      const { stdout, exitCode } = await runCli('--help');
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes('用法'));
      assert.ok(stdout.includes('scrape'));
      assert.ok(stdout.includes('validate'));
      assert.ok(stdout.includes('download'));
      assert.ok(stdout.includes('legal-status'));
    });

    it('-h 也可显示帮助', async () => {
      const { stdout, exitCode } = await runCli('-h');
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes('用法'));
    });
  });

  describe('无参数', () => {
    it('无参数显示帮助', async () => {
      const { stdout, exitCode } = await runCli();
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes('用法'));
    });
  });

  describe('未知命令', () => {
    it('显示错误并退出码 1', async () => {
      const { stderr, exitCode } = await runCli('unknown');
      assert.equal(exitCode, 1);
      assert.ok(stderr.includes('未知命令'));
    });
  });

  describe('validate', () => {
    it('合法专利号返回 JSON 且退出码 0', async () => {
      const { stdout, exitCode } = await runCli('validate', 'US11452699B2');
      assert.equal(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.equal(result.valid, true);
      assert.equal(result.normalized, 'US11452699B2');
    });

    it('含空格专利号返回规范化结果', async () => {
      const { stdout, exitCode } = await runCli('validate', 'US 11452699 B2');
      assert.equal(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.equal(result.valid, true);
      assert.equal(result.normalized, 'US11452699B2');
    });

    it('非法专利号退出码 1', async () => {
      const { stdout, exitCode } = await runCli('validate', 'bad');
      assert.equal(exitCode, 1);
      const result = JSON.parse(stdout);
      assert.equal(result.valid, false);
      assert.ok(result.reason);
    });

    it('空字符串退出码 1', async () => {
      const { stdout, exitCode } = await runCli('validate', '');
      assert.equal(exitCode, 1);
      const result = JSON.parse(stdout);
      assert.equal(result.valid, false);
    });
  });

  describe('scrape', () => {
    it('缺少参数报错', async () => {
      const { stderr, exitCode } = await runCli('scrape');
      assert.equal(exitCode, 1);
      assert.ok(stderr.includes('需要'));
    });

    it('非法专利号返回 VALIDATION_ERROR', async () => {
      const { stdout, exitCode } = await runCli('scrape', 'bad-input');
      assert.equal(exitCode, 1);
      const result = JSON.parse(stdout);
      assert.equal(result.success, false);
      assert.equal(result.errorCode, 'VALIDATION_ERROR');
    });
  });

  describe('download', () => {
    it('缺少参数报错', async () => {
      const { stderr, exitCode } = await runCli('download');
      assert.equal(exitCode, 1);
      assert.ok(stderr.includes('需要'));
    });
  });

  describe('legal-status', () => {
    it('缺少参数报错', async () => {
      const { stderr, exitCode } = await runCli('legal-status');
      assert.equal(exitCode, 1);
      assert.ok(stderr.includes('需要'));
    });
  });

  describe('--pretty', () => {
    it('格式化 JSON 输出', async () => {
      const { stdout, exitCode } = await runCli(
        'validate', 'US11452699B2', '--pretty',
      );
      assert.equal(exitCode, 0);
      assert.ok(stdout.includes('\n'));
      assert.ok(stdout.includes('  ')); // 缩进
    });
  });
});
