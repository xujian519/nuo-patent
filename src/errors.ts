/**
 * nuo-patent · 自定义错误类
 */

export class NuoPatentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NuoPatentError';
  }
}

export class PatentClassError extends NuoPatentError {
  constructor(message: string) {
    super(message);
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
  constructor(message: string) {
    super(message);
    this.name = 'PDFDownloadError';
  }
}

export class CNIPAQueryError extends NuoPatentError {
  constructor(message: string) {
    super(message);
    this.name = 'CNIPAQueryError';
  }
}
