# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

`nuo-patent` 是小诺（Xiaonuo）智能体生态的专利数据采集层，TypeScript 实现。从 Python 版重构而来（归档于 `_archive/python/`），性能提升约 2x。

核心能力：Google Patents 元数据抓取、PDF 批量下载、法律状态查询、CNIPA 中国专利查询。

## 常用命令

```bash
npm run build          # tsup 构建 ESM + CJS 产物到 dist/
npm run typecheck      # tsc --noEmit 类型检查
npm run dev            # tsup --watch 开发模式
npm test               # Node 原生 test runner（需 tsx 加载器）
npm run bench          # 性能基准测试（TS vs Python 对比）
```

测试使用 Node 内置 `node:test`，通过 `tsx` 直接运行 TypeScript 文件。无 Jest/Vitest 依赖。

## 架构

### 模块分层

```
src/
├── index.ts            # 公共 API 入口，统一 re-export
├── types.ts            # 所有共享类型定义（PatentData, Citation, LegalStatusResult 等）
├── errors.ts           # 自定义错误类层次（NuoPatentError → PatentClassError/PDFDownloadError/CNIPAQueryError...）
├── scraper.ts          # 核心：GooglePatentsScraper 类 + 纯解析函数
├── ego-browser.ts      # ego-browser (ego-lite) 抓取后端：macOS 优先，自动回退
├── pdf-downloader.ts   # PDFDownloader：流式下载 + 进度显示 + 并发控制
├── legal-status.ts     # LegalStatusChecker：法律状态/年费查询
└── cnipa-client.ts     # CNIPAClient：通过 child_process 调用 Python 脚本查询中国专利
```

### 核心设计决策

1. **ego-browser 优先抓取（macOS）**：`fetchHtml` 在 macOS 上优先调用 `ego-browser`（ego-lite，真实 Chromium）抓取渲染后的 HTML，通过 `child_process.exec` 以 stdin 传入脚本（`openOrReuseTab` + `js(document.documentElement.outerHTML)`），结果 base64 编码经 cliLog 输出。比原生 fetch 更稳（真实指纹、JS 渲染、过反爬）。不可用时自动回退原生网络栈；`NUO_PATENT_EGO_BROWSER=0` 禁用、`=1` 强制启用（非 macOS 也可用）。实现见 `src/ego-browser.ts`。注意：ego-browser 的 `cliLog` 输出到 stderr，解析时需合并两流。

2. **惰性代理检测**：`getSystemProxy()` 首次调用时才检测系统代理（环境变量 → macOS `scutil`），避免模块加载时的 I/O。结果缓存于模块级变量 `_cachedProxy`。

3. **纯解析函数导出**：`parseCitationElement`、`extractCitations`、`extractEvents`、`extractLegalStatus`、`extractClassifications` 是独立导出的纯函数，接受 cheerio API 无网络依赖。小诺智能体的 `GooglePatentsTool` 可以直接复用这些函数处理已获取的 HTML。

4. **CNIPA 依赖外部 Python 脚本**：`CNIPAClient` 通过 `child_process.execFile` 调用 `cnipa_epub_client.py`（来自 YunXi 项目）。查找路径优先级：构造路径 → 环境变量 `CNIPA_TOOL_PATH`。超时 180s（CNIPA 网站可能触发 WAF 验证导致延迟）。

5. **代理穿透**：`fetchHtml` 和 `PDFDownloader.fetchBinary` 都支持 HTTP CONNECT 隧道代理。无代理时走原生 `fetch`；有代理时手动构建 `http.request` + `https.request` over socket。

6. **PDF 下载跳过已存在文件**：`downloadSingle` 在下载前检查文件是否存在，避免重复下载。

7. **向后兼容别名**：`scraper.ts` 导出 `scraper_class` 作为 `GooglePatentsScraper` 的别名，`systemProxy` 作为 `getSystemProxy` 的 `@deprecated` 别名。

### 网络请求策略

- macOS 上 Google Patents 优先走 ego-browser（真实 Chromium，可过反爬），失败自动回退 `fetch` 或代理 CONNECT 隧道（无 Playwright 依赖）
- Google Patents 页面结构以 `meta` 标签和 `itemprop` 属性为主，用 cheerio 选择器提取
- CNIPA 需要绕过 WAF，因此通过 Python 子进程执行（Python 脚本内部可能使用 Playwright/DrissionPage）

### 构建产物

`tsup` 输出 ESM (`.js`) 和 CJS (`.cjs`) 双格式，附带 `.d.ts` 类型声明和 source map。`package.json` 的 `exports` 字段同时支持 `import` 和 `require`。

### 可选依赖

`playwright` 是 optionalDependency，仅 CNIPA 功能链路上需要（通过 Python 脚本间接使用）。基础 Google Patents 抓取不需要。

### 向后兼容注意

`PatentData` 中引证和发明人等字段存储为 JSON 字符串（非结构化对象），这是从 Python 原版继承的约定，不要改为结构化类型以避免破坏下游消费者。
