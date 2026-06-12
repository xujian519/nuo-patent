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
} from './types.js';
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
  // 环境变量
  typeof process !== 'undefined' && process.env.CNIPA_TOOL_PATH ? process.env.CNIPA_TOOL_PATH : '',
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

function _toolWorkdir(): string | null {
  /** 返回 CNIPA 工具的工作目录（父目录）。 */
  const tool = _findTool();
  if (tool) {
    return dirname(tool);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class CNIPAClient {
  /** CNIPA 公布公告查询客户端。 */

  private toolPath: string;
  private workDir: string;

  /**
   * 创建 CNIPA 客户端实例。
   *
   * @param toolPath - 可选的 cnipa_epub_client.py 脚本路径
   * @param workDir - 可选的工作目录
   *
   * @throws {CNIPAQueryError} 当找不到工具脚本时抛出
   *
   * @example
   * ```typescript
   * const client = new CNIPAClient();
   *
   * // 搜索
   * const result = await client.search('人工智能');
   *
   * // 查详情
   * const detail = await client.detail('CN122072823A');
   *
   * // 查法律状态（申请号）
   * const records = await client.transaction('2023113560975');
   *
   * // 查法律状态（公布号）
   * const records = await client.patentTransactions('CN122072823A');
   *
   * // 下载 PDF
   * const pdfPath = await client.downloadPdf('CN122072823A', '/tmp/');
   * ```
   */
  constructor(toolPath?: string, workDir?: string) {
    this.toolPath = toolPath ?? _findTool() ?? '';
    if (!this.toolPath) {
      throw new CNIPAQueryError(
        '找不到 CNIPA 查询工具。请通过环境变量 CNIPA_TOOL_PATH 指定，\n' +
        '或安装 YunXi 项目 (https://github.com/xujian/YunXi)'
      );
    }
    this.workDir = workDir ?? _toolWorkdir() ?? dirname(this.toolPath);
  }

  // ------------------------------------------------------------------
  // 底层执行
  // ------------------------------------------------------------------

  private async _run(...args: string[]): Promise<string> {
    /** 运行 CNIPA 客户端命令，返回 stdout。 */
    const cmd = ['python3', this.toolPath, ...args];

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
      if (error instanceof Error) {
        // 检查是否是超时错误
        if ('killed' in error && 'signal' in error) {
          throw new CNIPAQueryError(
            'CNIPA 查询超时 (180s)，网络或 WAF 验证可能过慢'
          );
        }

        // 检查是否是文件不存在错误
        if ('code' in error && error.code === 'ENOENT') {
          throw new CNIPAQueryError(`找不到脚本: ${this.toolPath}`);
        }

        // 其他错误
        if ('stderr' in error && typeof error.stderr === 'string') {
          throw new CNIPAQueryError(`CNIPA 查询失败: ${error.stderr.trim()}`);
        }

        throw new CNIPAQueryError(`CNIPA 查询失败: ${error.message}`);
      }

      throw new CNIPAQueryError('CNIPA 查询失败: 未知错误');
    }
  }

  private _parseJsonOutput<T = unknown>(output: string): T | null {
    /** 解析 CLI 输出的 JSON 数据。 */
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return JSON.parse(trimmed) as T;
        } catch {
          continue;
        }
      }
    }
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
      // 只包含 PatentDetail 接口中定义的字段
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
    } catch (error) {
      if (error instanceof Error) {
        console.error(`[CNIPA] PDF 下载失败: ${error.message}`);
      }
    }
    return null;
  }

  /**
   * 检查 CNIPA 工具是否可用的快速检测。
   *
   * @returns 是否可用
   */
  isAvailable(): boolean {
    if (!existsSync(this.toolPath)) {
      return false;
    }
    // 不真的发起查询（可能触发 WAF），只检查文件存在
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