/**
 * nuo-patent · CNIPA 中国专利查询客户端
 *
 * 封装 CNIPA 公布公告网站 (http://epub.cnipa.gov.cn/) 的查询功能。
 * 基于小诺项目中的 cnipa_epub_client.py 工具。
 *
 * 支持:
 * - search(keyword)           — 关键词检索
 * - detail(pubNumber)         — 专利详情
 * - transaction(appNumber)    — 事务数据查询（法律状态）
 * - patentTransactions(pub)   — 通过公布号查法律状态
 * - downloadPdf(pubNumber, outputDir)  — PDF 下载
 * - legalStatusSummary(pub)   — 法律状态摘要
 *
 * 注意：此模块通过 child_process 调用 Python 脚本，需要 python3 和
 * cnipa_epub_client.py（来自 YunXi 项目）。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type {
  PatentDetail,
  TransactionRecord,
  SearchResult,
  Logger,
} from './types.js';
import { noopLogger } from './types.js';
import { CNIPAQueryError } from './errors.js';

const execFileAsync = promisify(execFile);

function _getModuleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

const _TOOL_CANDIDATE_PATHS = [
  join(_getModuleDir(), '../cnipa_tool/cnipa_epub_client.py'),
  typeof process !== 'undefined' && process.env.CNIPA_TOOL_PATH
    ? process.env.CNIPA_TOOL_PATH
    : '',
];

function _findTool(): string | null {
  /** 查找 CNIPA 客户端脚本路径。 */
  for (const p of _TOOL_CANDIDATE_PATHS) {
    if (p && existsSync(p)) {
      return p;
    }
  }
  return null;
}

function _toolWorkdir(toolPath: string): string | null {
  return dirname(toolPath);
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class CNIPAClient {
  /** CNIPA 公布公告查询客户端。 */

  private toolPath: string;
  private workDir: string;
  private logger: Logger;

  /**
   * 创建 CNIPA 客户端实例。
   *
   * 构造函数不会因找不到工具脚本而抛异常——可用 `isAvailable()` 预先检查。
   * 实际查询时如果工具脚本不存在，会抛出 `CNIPAQueryError`。
   *
   * @param toolPath - 可选的 cnipa_epub_client.py 脚本路径
   * @param workDir - 可选的工作目录
   * @param logger - 可选的日志接口
   *
   * @example
   * ```typescript
   * const client = new CNIPAClient();
   * if (!client.isAvailable()) {
   *   console.error('CNIPA 查询不可用，请安装 YunXi 项目');
   *   return;
   * }
   *
   * // 搜索
   * const result = await client.search('人工智能');
   *
   * // 查法律状态
   * const summary = await client.legalStatusSummary('CN122072823A');
   * ```
   */
  constructor(toolPath?: string, workDir?: string, logger?: Logger) {
    this.logger = logger ?? noopLogger;

    const resolvedPath = toolPath ?? _findTool() ?? '';
    this.toolPath = resolvedPath;

    if (resolvedPath) {
      this.workDir = workDir ?? _toolWorkdir(resolvedPath) ?? dirname(resolvedPath);
    } else {
      this.workDir = workDir ?? process.cwd();
    }
  }

  // ------------------------------------------------------------------
  // 底层执行
  // ------------------------------------------------------------------

  private async _run(...args: string[]): Promise<string> {
    /** 运行 CNIPA 客户端命令，返回 stdout。 */
    if (!this.toolPath) {
      throw new CNIPAQueryError(
        '找不到 CNIPA 查询工具。请通过环境变量 CNIPA_TOOL_PATH 指定，\n' +
        '或安装 YunXi 项目 (https://github.com/xujian/YunXi)',
      );
    }

    const cmd = ['python3', this.toolPath, ...args];
    this.logger.debug(`执行命令: ${cmd.join(' ')}`);

    try {
      const { stdout, stderr } = await execFileAsync(cmd[0], cmd.slice(1), {
        timeout: 180000,
        cwd: this.workDir,
      });

      if (stdout.trim()) {
        return stdout.trim();
      }

      // 检查 stderr
      if (stderr.trim()) {
        throw new CNIPAQueryError(`CNIPA 查询失败: ${stderr.trim()}`);
      }

      return stdout.trim();
    } catch (error) {
      if (error instanceof CNIPAQueryError) {
        throw error;
      }

      if (error instanceof Error) {
        // 超时
        if ('killed' in error && 'signal' in error) {
          this.logger.warn('CNIPA 查询超时 (180s)');
          throw new CNIPAQueryError(
            'CNIPA 查询超时 (180s)，网络或 WAF 验证可能过慢',
          );
        }

        // 文件不存在
        if ('code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new CNIPAQueryError(
            `找不到脚本或 Python3: ${this.toolPath}。请确认 python3 已安装且脚本路径正确。`,
          );
        }

        // 带 stderr 的错误
        if ('stderr' in error && typeof (error as any).stderr === 'string') {
          const stderrText = (error as any).stderr.trim();
          this.logger.warn(`CNIPA stderr: ${stderrText}`);
          throw new CNIPAQueryError(`CNIPA 查询失败: ${stderrText}`);
        }

        throw new CNIPAQueryError(`CNIPA 查询失败: ${error.message}`);
      }

      throw new CNIPAQueryError('CNIPA 查询失败: 未知错误');
    }
  }

  /**
   * 解析 CLI 输出的 JSON 数据。
   * 按行扫描，取第一个成功解析的 JSON 对象/数组。
   */
  private _parseJsonOutput<T = unknown>(output: string): T | null {
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 只尝试以 { 或 [ 开头且足够长的行（跳过短 JSON 片段）
      if (
        (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
        trimmed.length >= 4
      ) {
        try {
          return JSON.parse(trimmed) as T;
        } catch {
          // 不是有效 JSON，继续下一行
          continue;
        }
      }
    }
    this.logger.warn('_parseJsonOutput: 未找到有效 JSON 行');
    return null;
  }

  // ------------------------------------------------------------------
  // 高级 API
  // ------------------------------------------------------------------

  /**
   * 关键词检索。
   *
   * @param keyword - 关键词、申请号或公布号
   * @returns SearchResult 对象
   */
  async search(keyword: string): Promise<SearchResult> {
    const output = await this._run('search', keyword);
    const data = this._parseJsonOutput<Record<string, unknown>[]>(output);

    if (data && Array.isArray(data)) {
      return {
        keyword,
        total_hits: data.length,
        patents: data,
      };
    }

    return {
      keyword,
      total_hits: 0,
      patents: [],
    };
  }

  /**
   * 查询专利详情。
   *
   * @param pubNumber - 公布号，如 'CN122072823A'
   * @returns PatentDetail 对象
   */
  async detail(pubNumber: string): Promise<PatentDetail> {
    const output = await this._run('detail', pubNumber);
    const data = this._parseJsonOutput<Partial<PatentDetail>>(output);

    if (data && typeof data === 'object') {
      const validFields: Record<string, unknown> = {};
      const detailFields: (keyof PatentDetail)[] = [
        'title',
        'pub_number',
        'pub_date',
        'app_number',
        'app_date',
        'applicant',
        'address',
        'inventor',
        'classification',
        'agency',
        'agent',
        'abstract',
        'first_page_image_url',
      ];

      for (const field of detailFields) {
        if (field in data) {
          validFields[field] = data[field];
        }
      }

      return {
        title: '',
        pub_number: pubNumber,
        pub_date: '',
        app_number: '',
        app_date: '',
        applicant: '',
        address: '',
        inventor: '',
        classification: '',
        agency: '',
        agent: '',
        abstract: '',
        first_page_image_url: '',
        ...validFields,
      } as PatentDetail;
    }

    return {
      title: '',
      pub_number: pubNumber,
      pub_date: '',
      app_number: '',
      app_date: '',
      applicant: '',
      address: '',
      inventor: '',
      classification: '',
      agency: '',
      agent: '',
      abstract: '',
      first_page_image_url: '',
    };
  }

  /**
   * 查询法律状态/事务数据。
   *
   * @param appNumber - 13位申请号（纯数字，去掉小数点）
   * @returns TransactionRecord 列表
   */
  async transaction(appNumber: string): Promise<TransactionRecord[]> {
    const output = await this._run('transaction', appNumber);
    const data = this._parseJsonOutput<Partial<TransactionRecord>[]>(output);

    if (data && Array.isArray(data)) {
      return data.map((item): TransactionRecord => ({
        index: item.index ?? 0,
        app_number: item.app_number ?? '',
        date: item.date ?? '',
        description: item.description ?? '',
      }));
    }

    return [];
  }

  /**
   * 通过公布号查询法律状态。
   *
   * @param pubNumber - 公布号，如 'CN122072823A'
   * @returns TransactionRecord 列表
   */
  async patentTransactions(pubNumber: string): Promise<TransactionRecord[]> {
    const output = await this._run('patent-transactions', pubNumber);
    const data = this._parseJsonOutput<Partial<TransactionRecord>[]>(output);

    if (data && Array.isArray(data)) {
      return data.map((item): TransactionRecord => ({
        index: item.index ?? 0,
        app_number: item.app_number ?? '',
        date: item.date ?? '',
        description: item.description ?? '',
      }));
    }

    return [];
  }

  /**
   * 下载中国专利 PDF。
   *
   * @param pubNumber - 公布号，如 'CN122072823A'
   * @param outputDir - 输出目录，默认 '/tmp'
   * @returns PDF 文件路径，失败返回 null
   */
  async downloadPdf(pubNumber: string, outputDir: string = '/tmp'): Promise<string | null> {
    const outputPath = join(outputDir, `${pubNumber}.pdf`);
    try {
      await this._run('pdf', pubNumber, '-o', outputPath);
      if (existsSync(outputPath)) {
        return outputPath;
      }
      this.logger.warn(`PDF 命令执行成功但文件不存在: ${outputPath}`);
    } catch (error) {
      this.logger.warn(`PDF 下载失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }

  /**
   * 检查 CNIPA 工具是否可用。
   *
   * 仅检查脚本文件和 python3 是否可执行，不实际发起网络请求（避免触发 WAF）。
   *
   * @returns 是否可用
   */
  isAvailable(): boolean {
    if (!this.toolPath || !existsSync(this.toolPath)) {
      return false;
    }
    return true;
  }

  /**
   * 格式化事务记录为可读文本。
   *
   * @param records - 事务记录列表
   * @returns 格式化的文本
   */
  formatTransactions(records: TransactionRecord[]): string {
    const lines: string[] = [];
    for (const r of records) {
      lines.push(`  #${r.index}  [${r.date}] ${r.description}`);
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------------
  // 法律状态快捷方法
  // ------------------------------------------------------------------

  /**
   * 返回法律状态摘要文本。
   *
   * @param pubNumber - 公布号
   * @returns 可读的法律状态摘要
   */
  async legalStatusSummary(pubNumber: string): Promise<string> {
    const detail = await this.detail(pubNumber);
    const records = await this.patentTransactions(pubNumber);

    const lines: string[] = [
      `📋 中国专利: ${pubNumber}`,
      `  标题: ${detail.title}`,
      `  申请人: ${detail.applicant}`,
      `  申请日: ${detail.app_date}`,
      `  申请号: ${detail.app_number}`,
    ];

    // 分析最后一条事务判断当前状态
    if (records.length > 0) {
      const last = records[records.length - 1];
      lines.push(`  最近事务: [${last.date}] ${last.description}`);

      // 状态推断
      const desc = last.description;
      if (desc.includes('授权') && !desc.includes('驳回')) {
        lines.push('  状态推断: ✅ 已授权');
      } else if (desc.includes('驳回')) {
        lines.push('  状态推断: ❌ 已驳回');
      } else if (desc.includes('撤回')) {
        lines.push('  状态推断: ⏹️ 已撤回');
      } else if (desc.includes('终止') || desc.includes('失效')) {
        lines.push('  状态推断: ⚠️ 已终止/失效');
      } else {
        lines.push(`  状态推断: 🔄 待确认 (最新: ${desc})`);
      }

      lines.push(`  事务记录 (${records.length} 条):`);
      for (const r of records.slice(-5)) {  // 最近5条
        lines.push(`    [${r.date}] ${r.description}`);
      }
    } else {
      lines.push('  状态: 未查询到事务数据');
    }

    return lines.join('\n');
  }
}
