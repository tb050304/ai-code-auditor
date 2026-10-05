/**
 * 代码块提取与编辑器插入纯函数（Day 23）
 *
 * 职责：
 * 1. extractCodeBlocks —— 从模型输出的 Markdown 中解析围栏代码块，
 *    供控制台为每个代码块渲染"插入光标处 / 替换选中 / 新建文件"操作。
 * 2. insertAtOffset / replaceRange —— 纯字符串编辑原语，
 *    与 Monaco 无关，便于测试；UI 层在有 Monaco 时走 executeEdits
 *    （原生撤销栈/光标语义），无编辑器时可用本函数兜底。
 * 3. suggestFileName —— 按代码块语言建议新建文件名。
 *
 * 不依赖 React / Monaco / Node API。
 */

/** 从 Markdown 中解析出的一个围栏代码块 */
export interface ExtractedCodeBlock {
  /** 围栏语言标记（```ts 中的 ts），未标注时为空串 */
  lang: string;
  /** 代码内容（已去除围栏与末尾单个换行） */
  code: string;
  /** 该块在原文中的字符区间（半开），含围栏标记本身 */
  start: number;
  end: number;
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)?\s*$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * 解析 Markdown 中全部围栏代码块（与 GFM 规则一致：``` 或 ~~~，至少 3 个）。
 * - 流式/截断场景下未闭合的尾部块也会尽力提取；
 * - 跳过 Agent 工具调用块（```tool），它不是面向用户的代码；
 * - 同一围栏标记字符配对，4 个反引号开启的块可以包含 3 反引号文本。
 */
export function extractCodeBlocks(markdown: string): ExtractedCodeBlock[] {
  const blocks: ExtractedCodeBlock[] = [];
  const lines = markdown.split("\n");

  let inBlock = false;
  let fenceChar = "";
  let fenceLen = 0;
  let buffer: string[] = [];
  let lang = "";
  let blockStart = 0;
  let offset = 0;

  const flush = (endOffset: number) => {
    const code = buffer.join("\n").replace(/\n$/, "");
    if (lang !== "tool" && code.length > 0) {
      blocks.push({ lang, code, start: blockStart, end: endOffset });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineWithNewline = i < lines.length - 1 ? line.length + 1 : line.length;

    if (!inBlock) {
      const m = FENCE_OPEN.exec(line);
      if (m) {
        inBlock = true;
        fenceChar = m[2][0];
        fenceLen = m[2].length;
        lang = (m[3] ?? "").trim().toLowerCase();
        buffer = [];
        blockStart = offset;
      }
    } else {
      const close = FENCE_CLOSE.exec(line);
      const isClose =
        close !== null &&
        close[1][0] === fenceChar &&
        close[1].length >= fenceLen;
      if (isClose) {
        flush(offset + line.length);
        inBlock = false;
        lang = "";
      } else {
        buffer.push(line);
      }
    }
    offset += lineWithNewline;
  }

  // 未闭合的尾部块（流式截断 / 模型漏写围栏）：尽力提取
  if (inBlock && buffer.length > 0) flush(offset);

  return blocks;
}

// ---------------------------------------------------------------------------
// 纯字符串编辑原语（offset 为字符偏移，半开区间）
// ---------------------------------------------------------------------------

/** 在指定偏移处插入片段，返回新文本 */
export function insertAtOffset(code: string, offset: number, snippet: string): string {
  const pos = Math.max(0, Math.min(offset, code.length));
  return code.slice(0, pos) + snippet + code.slice(pos);
}

/**
 * 计算在 (line, column)（1-based，Monaco 坐标）处插入 text 后，
 * 片段末尾的光标位置：无换行时列右移，有换行时按最后一行长度定位。
 */
export function cursorAfterInsert(
  line: number,
  column: number,
  text: string,
): { lineNumber: number; column: number } {
  const lines = text.split("\n");
  if (lines.length === 1) {
    return { lineNumber: line, column: column + lines[0].length };
  }
  return { lineNumber: line + lines.length - 1, column: lines[lines.length - 1].length + 1 };
}

/** 用 snippet 替换 [start, end) 区间；越界自动收窄 */
export function replaceRange(
  code: string,
  start: number,
  end: number,
  snippet: string,
): string {
  const s = Math.max(0, Math.min(start, code.length));
  const e = Math.max(s, Math.min(end, code.length));
  return code.slice(0, s) + snippet + code.slice(e);
}

// ---------------------------------------------------------------------------
// 新建文件命名
// ---------------------------------------------------------------------------

/** 语言标记 → 文件扩展名 */
const LANG_EXTENSIONS: Record<string, string> = {
  ts: ".ts",
  typescript: ".ts",
  tsx: ".tsx",
  js: ".js",
  javascript: ".js",
  jsx: ".jsx",
  mjs: ".mjs",
  cjs: ".cjs",
  json: ".json",
  css: ".css",
  scss: ".scss",
  less: ".less",
  html: ".html",
  vue: ".vue",
  py: ".py",
  python: ".py",
  sh: ".sh",
  bash: ".sh",
  shell: ".sh",
  yml: ".yml",
  yaml: ".yaml",
  md: ".md",
  markdown: ".md",
  sql: ".sql",
};

/** 按代码块语言取扩展名（未知类型回退 .txt） */
export function extensionForLang(lang: string): string {
  return LANG_EXTENSIONS[lang.trim().toLowerCase()] ?? ".txt";
}

/**
 * 生成不冲突的新建文件建议名：snippet<序号><扩展名>。
 * @param lang     代码块语言
 * @param exists   判断某文件名是否已占用（调用方接项目文件表）
 * @param basename 文件名主体，缺省 snippet
 */
export function suggestFileName(
  lang: string,
  exists: (name: string) => boolean = () => false,
  basename = "snippet",
): string {
  const ext = extensionForLang(lang);
  if (!exists(`${basename}${ext}`)) return `${basename}${ext}`;
  for (let i = 2; i < 1000; i++) {
    const name = `${basename}-${i}${ext}`;
    if (!exists(name)) return name;
  }
  return `${basename}-${Date.now()}${ext}`;
}
