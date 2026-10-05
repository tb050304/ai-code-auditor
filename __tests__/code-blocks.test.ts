/**
 * 代码块提取与编辑器编辑原语测试（Day 23）
 *
 * 覆盖：
 * - extractCodeBlocks：单块/多块/语言标记/未闭合尾部块/tool 围栏跳过/波浪线围栏/嵌套反引号
 * - insertAtOffset / replaceRange：字符串编辑与越界收窄
 * - cursorAfterInsert：Monaco 坐标的单行/多行定位
 * - extensionForLang / suggestFileName：扩展名映射与不冲突命名
 */

import { describe, it, expect } from "vitest";
import {
  extractCodeBlocks,
  insertAtOffset,
  replaceRange,
  cursorAfterInsert,
  extensionForLang,
  suggestFileName,
} from "@/lib/code-blocks";

describe("extractCodeBlocks", () => {
  it("提取单个代码块及语言标记", () => {
    const md = "说明文字\n```ts\nconst a = 1;\n```\n结尾";
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("ts");
    expect(blocks[0].code).toBe("const a = 1;");
    // start/end 覆盖含围栏的完整区间
    expect(md.slice(blocks[0].start, blocks[0].end)).toBe("```ts\nconst a = 1;\n```");
  });

  it("提取多个代码块并保持顺序", () => {
    const md = ["```js", "a();", "```", "中间说明", "```css", ".x{}", "```"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks.map((b) => b.lang)).toEqual(["js", "css"]);
    expect(blocks.map((b) => b.code)).toEqual(["a();", ".x{}"]);
  });

  it("无语言标记时 lang 为空串仍可提取", () => {
    const blocks = extractCodeBlocks("```\nplain\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("");
    expect(blocks[0].code).toBe("plain");
  });

  it("跳过 Agent 工具调用块（tool 围栏不展示操作条）", () => {
    const md = [
      "思考",
      "```tool",
      '{"tool":"readFile","args":{}}',
      "```",
      "```ts",
      "let x = 1;",
      "```",
    ].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("ts");
  });

  it("流式截断的未闭合尾部块也尽力提取", () => {
    const md = "```ts\nconst a = 1;\nconst b = 2;";
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code).toBe("const a = 1;\nconst b = 2;");
  });

  it("支持 ~~~ 波浪线围栏", () => {
    const blocks = extractCodeBlocks("~~~\ncode here\n~~~");
    expect(blocks[0].code).toBe("code here");
  });

  it("4 反引号围栏内可包含 3 反引号文本", () => {
    const md = "````\n```ts\ninner\n```\n````";
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code).toBe("```ts\ninner\n```");
  });

  it("代码块内容保留末尾空行以外的换行结构", () => {
    const blocks = extractCodeBlocks("```js\nline1\nline2\n```");
    expect(blocks[0].code.split("\n")).toEqual(["line1", "line2"]);
  });

  it("没有代码块时返回空数组", () => {
    expect(extractCodeBlocks("纯文本\n第二段")).toEqual([]);
  });
});

describe("insertAtOffset", () => {
  it("在指定偏移插入", () => {
    expect(insertAtOffset("ac", 1, "b")).toBe("abc");
  });
  it("开头与结尾插入", () => {
    expect(insertAtOffset("xy", 0, "0")).toBe("0xy");
    expect(insertAtOffset("xy", 2, "z")).toBe("xyz");
  });
  it("越界偏移自动收窄", () => {
    expect(insertAtOffset("ab", 99, "c")).toBe("abc");
    expect(insertAtOffset("ab", -5, "c")).toBe("cab");
  });
});

describe("replaceRange", () => {
  it("替换半开区间", () => {
    expect(replaceRange("hello world", 6, 11, "there")).toBe("hello there");
  });
  it("start > end 时收窄为空替换（等同插入）", () => {
    expect(replaceRange("abc", 2, 1, "X")).toBe("abXc");
  });
  it("越界区间收窄到字符串范围", () => {
    expect(replaceRange("abc", -10, 2, "X")).toBe("Xc");
    expect(replaceRange("abc", 2, 99, "X")).toBe("abX");
  });
});

describe("cursorAfterInsert", () => {
  it("单行片段：列右移，行不变", () => {
    expect(cursorAfterInsert(3, 5, "abc")).toEqual({ lineNumber: 3, column: 8 });
  });
  it("多行片段：定位到最后一行末尾之后", () => {
    expect(cursorAfterInsert(1, 1, "a\nbc\ndef")).toEqual({ lineNumber: 3, column: 4 });
  });
  it("片段以换行结尾时，最后一行为空、列为 1", () => {
    expect(cursorAfterInsert(2, 1, "x\n")).toEqual({ lineNumber: 3, column: 1 });
  });
});

describe("extensionForLang / suggestFileName", () => {
  it("常见语言标记映射扩展名", () => {
    expect(extensionForLang("ts")).toBe(".ts");
    expect(extensionForLang("TypeScript")).toBe(".ts");
    expect(extensionForLang("tsx")).toBe(".tsx");
    expect(extensionForLang("js")).toBe(".js");
    expect(extensionForLang("python")).toBe(".py");
    expect(extensionForLang("sh")).toBe(".sh");
  });

  it("未知类型回退 .txt，空串也回退", () => {
    expect(extensionForLang("brainfuck")).toBe(".txt");
    expect(extensionForLang("")).toBe(".txt");
  });

  it("无冲突时返回默认名", () => {
    expect(suggestFileName("ts", () => false)).toBe("snippet.ts");
    expect(suggestFileName("py", () => false, "hook")).toBe("hook.py");
  });

  it("名字被占用时递增序号避让", () => {
    const taken = new Set(["/snippet.ts", "/snippet-2.ts"]);
    expect(suggestFileName("ts", (n) => taken.has(`/${n}`))).toBe("snippet-3.ts");
  });
});
