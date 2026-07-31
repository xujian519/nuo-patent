/**
 * nuo-patent · 自定义错误类
 *
 * 所有错误继承自 NuoPatentError，智能体可通过 `instanceof` 或 `error.name` 做分类处理。
 * 每个错误携带 `patentNumber` 上下文（如适用），方便智能体定位问题。
 */

export class NuoPatentError extends Error {
  /** 关联的专利号（如适用） */
  public patentNumber?: string;

  constructor(message: string, patentNumber?: string) {
    super(message);
    this.name = 'NuoPatentError';
    this.patentNumber = patentNumber;
  }
}

export class PatentClassError extends NuoPatentError {
  constructor(message: string, patentNumber?: string) {
    super(message, patentNumber);
    this.name = 'PatentClassError';
  }
}

export class NoPatentsError extends NuoPatentError {
  constructor(message: string) {
    super(message);
    this.name = 'NoPatentsError';
  }
}

export class PDFDownloadError extends NuoPatentError {
  constructor(message: string, patentNumber?: string) {
    super(message, patentNumber);
    this.name = 'PDFDownloadError';
  }
}

export class CNIPAQueryError extends NuoPatentError {
  constructor(message: string) {
    super(message);
    this.name = 'CNIPAQueryError';
  }
}

/** 网络请求超时 */
export class TimeoutError extends NuoPatentError {
  /** 超时阈值（毫秒） */
  public timeoutMs: number;

  constructor(message: string, timeoutMs: number, patentNumber?: string) {
    super(message, patentNumber);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** HTML 解析失败（页面结构不匹配） */
export class ParseError extends NuoPatentError {
  /** 解析失败的字段名 */
  public field?: string;

  constructor(message: string, field?: string, patentNumber?: string) {
    super(message, patentNumber);
    this.name = 'ParseError';
    this.field = field;
  }
}
