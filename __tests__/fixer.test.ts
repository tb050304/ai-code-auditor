/**
 * 自动修复框架测试（Day 15）
 * 只测纯框架（合成 TextEdit），具体规则的 fix 实现从 Day 16 起补。
 */
import { describe, it, expect } from "vitest";
import { applyFixes, isFixable, type IssueFix, type TextEdit } from "@/lib/ast/fixer";

function makeFix(ruleId: string, edits: TextEdit[], risk: IssueFix["risk"] = "safe"): IssueFix {
  return { ruleId, description: `test fix ${ruleId}`, risk, edits };
}

/** 替换某行的一段（列均 1-based，半开） */
function editOnLine(line: number, startCol: number, endCol: number, replacement: string): TextEdit {
  return { startLine: line, startColumn: startCol, endLine: line, endColumn: endCol, replacement };
}

describe("applyFixes — 基本编辑", () => {
  it("单个编辑替换同行区间", () => {
    const code = "var x = 1;";
    // 把 "var" (1~4 列) 换成 "let"
    const r = applyFixes(code, [makeFix("no-var", [editOnLine(1, 1, 4, "let")])]);
    expect(r.code).toBe("let x = 1;");
    expect(r.applied).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
    expect(r.applied[0]).toMatchObject({ ruleId: "no-var", risk: "safe" });
  });

  it("多个不重叠编辑同时生效，与输入顺序无关", () => {
    const code = "a\nb\nc";
    const fixA = makeFix("rule-a", [editOnLine(1, 1, 2, "A")]); // a → A
    const fixC = makeFix("rule-c", [editOnLine(3, 1, 2, "C")]); // c → C
    const r1 = applyFixes(code, [fixA, fixC]);
    const r2 = applyFixes(code, [
      { ...fixC, edits: fixC.edits.map((e) => ({ ...e })) },
      { ...fixA, edits: fixA.edits.map((e) => ({ ...e })) },
    ]);
    expect(r1.code).toBe("A\nb\nC");
    expect(r2.code).toBe("A\nb\nC");
    // applied 按源码位置升序，与输入顺序无关
    expect(r2.applied.map((f) => f.ruleId)).toEqual(["rule-a", "rule-c"]);
  });

  it("零长度编辑 = 插入（行首、行尾）", () => {
    const code = "ab\ncd";
    const r = applyFixes(code, [
      makeFix("ins", [
        { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, replacement: "[" },
        { startLine: 2, startColumn: 3, endLine: 2, endColumn: 3, replacement: "]" },
      ]),
    ]);
    expect(r.code).toBe("[ab\ncd]");
  });

  it("空 replacement = 删除；跨行编辑覆盖换行符", () => {
    const code = "var x = 1;\nkeep;\n";
    // 删除第一行整行 + 换行：(1,1) → (2,1) 恰好覆盖 "var x = 1;\n"
    const r = applyFixes(code, [
      makeFix("del", [{ startLine: 1, startColumn: 1, endLine: 2, endColumn: 1, replacement: "" }]),
    ]);
    expect(r.code).toBe("keep;\n");
  });

  it("跨行替换（多行区域换成新文本）", () => {
    const code = "l1\nl2\nl3";
    const r = applyFixes(code, [
      makeFix("multi", [{ startLine: 1, startColumn: 2, endLine: 3, endColumn: 2, replacement: "X" }]),
    ]);
    // 区间从 "l1" 的第2列 到 "l3" 的第2列：l[1\nl2\nl]3 → lX3
    expect(r.code).toBe("lX3");
  });

  it("同一规则的两处修复都被采纳，applied 按位置升序", () => {
    const code = "console.log(1);\nx();\nconsole.log(2);";
    const r = applyFixes(code, [
      makeFix("no-console-log", [editOnLine(3, 1, 16, "")]),
      makeFix("no-console-log", [editOnLine(1, 1, 16, "")]),
    ]);
    expect(r.code).toBe("\nx();\n");
    expect(r.applied).toHaveLength(2);
    expect(r.skipped).toHaveLength(0);
  });
});

describe("applyFixes — 冲突与非法输入", () => {
  it("两个修复区间重叠：起点靠后的整组跳过，靠前的正常应用", () => {
    const code = "abcdef";
    const early = makeFix("early", [editOnLine(1, 1, 4, "XYZ")]); // abc → XYZ
    const later = makeFix("later", [editOnLine(1, 3, 6, "Q")]); // cde → Q（与 abc 重叠于 c）
    const r = applyFixes(code, [later, early]); // 故意乱序输入
    expect(r.code).toBe("XYZdef");
    expect(r.applied.map((f) => f.ruleId)).toEqual(["early"]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ ruleId: "later", reason: "overlap" });
    expect(r.skipped[0].message).toContain("early");
  });

  it("首尾相接（半开区间 end == start）不算重叠", () => {
    const code = "ab";
    const r = applyFixes(code, [
      makeFix("f1", [editOnLine(1, 1, 2, "X")]),
      makeFix("f2", [editOnLine(1, 2, 3, "Y")]),
    ]);
    expect(r.code).toBe("XY");
    expect(r.skipped).toHaveLength(0);
  });

  it("同一提案内部编辑重叠 → invalid-edit，整组不应用", () => {
    const code = "abcdef";
    const r = applyFixes(code, [
      makeFix("broken", [editOnLine(1, 1, 3, "X"), editOnLine(1, 2, 4, "Y")]),
    ]);
    expect(r.code).toBe("abcdef");
    expect(r.skipped[0]).toMatchObject({ ruleId: "broken", reason: "invalid-edit" });
  });

  it("坐标超出代码范围 → out-of-range", () => {
    const code = "ab\ncd";
    const r1 = applyFixes("ab\ncd", [makeFix("oob-line", [editOnLine(9, 1, 1, "X")])]);
    expect(r1.skipped[0].reason).toBe("out-of-range");
    expect(r1.code).toBe(code);

    const r2 = applyFixes(code, [makeFix("oob-col", [editOnLine(1, 1, 99, "X")])]);
    expect(r2.skipped[0].reason).toBe("out-of-range");

    // endColumn = 行长+1 合法（行尾锚点）
    const r3 = applyFixes(code, [makeFix("edge", [editOnLine(1, 3, 3, "Z")])]);
    expect(r3.code).toBe("abZ\ncd");
  });

  it("非正整数坐标与起晚于止 → invalid-edit", () => {
    const code = "abc";
    expect(applyFixes(code, [makeFix("zero", [editOnLine(0, 1, 1, "X")])]).skipped[0].reason).toBe(
      "invalid-edit",
    );
    expect(applyFixes(code, [makeFix("neg", [editOnLine(1, -1, 1, "X")])]).skipped[0].reason).toBe(
      "invalid-edit",
    );
    expect(
      applyFixes(code, [makeFix("reverse", [editOnLine(1, 3, 2, "X")])]).skipped[0].reason,
    ).toBe("invalid-edit");
  });

  it("空提案 → empty；不产生变化的替换 → no-op", () => {
    const code = "abc";
    const empty = applyFixes(code, [makeFix("empty", [])]);
    expect(empty.skipped[0]).toMatchObject({ ruleId: "empty", reason: "empty" });

    const noop = applyFixes(code, [makeFix("noop", [editOnLine(1, 1, 4, "abc")])]);
    expect(noop.code).toBe("abc");
    expect(noop.skipped[0]).toMatchObject({ ruleId: "noop", reason: "no-op" });
  });

  it("一个修复非法不影响其他修复", () => {
    const code = "a\nb";
    const r = applyFixes(code, [
      makeFix("bad", [editOnLine(9, 1, 1, "X")]),
      makeFix("good", [editOnLine(1, 1, 2, "A")]),
    ]);
    expect(r.code).toBe("A\nb");
    expect(r.applied.map((f) => f.ruleId)).toEqual(["good"]);
    expect(r.skipped.map((f) => f.ruleId)).toEqual(["bad"]);
  });
});

describe("applyFixes — 锚点与归一化", () => {
  it("expected 锚点不匹配 → stale，防止分析后代码已变导致错改", () => {
    const code = "var x = 1;";
    const stale = applyFixes(code, [
      makeFix("f", [{ ...editOnLine(1, 1, 4, "let"), expected: "val" }]),
    ]);
    expect(stale.code).toBe(code);
    expect(stale.skipped[0].reason).toBe("stale");

    const fresh = applyFixes(code, [
      makeFix("f", [{ ...editOnLine(1, 1, 4, "let"), expected: "var" }]),
    ]);
    expect(fresh.code).toBe("let x = 1;");
  });

  it("CRLF 输入归一化为 LF 后按 LF 坐标应用", () => {
    const code = "var x = 1;\r\nkeep;";
    const r = applyFixes(code, [makeFix("f", [editOnLine(1, 1, 4, "let")])]);
    expect(r.code).toBe("let x = 1;\nkeep;");
    expect(r.code.includes("\r")).toBe(false);
  });

  it("空文档可在起始位置插入", () => {
    const r = applyFixes("", [makeFix("f", [editOnLine(1, 1, 1, "hello")])]);
    expect(r.code).toBe("hello");
  });

  it("空修复列表：原文返回（同样做 CRLF 归一化）", () => {
    expect(applyFixes("a\nb", []).code).toBe("a\nb");
    expect(applyFixes("a\r\nb", []).code).toBe("a\nb");
    expect(applyFixes("a\nb", []).applied).toEqual([]);
    expect(applyFixes("a\nb", []).skipped).toEqual([]);
  });
});

describe("isFixable", () => {
  it("按 fix 是否存在且含编辑判断", () => {
    expect(isFixable({})).toBe(false);
    expect(isFixable({ fix: null })).toBe(false);
    expect(isFixable({ fix: undefined })).toBe(false);
    expect(
      isFixable({ fix: makeFix("r", [editOnLine(1, 1, 1, "x")]) }),
    ).toBe(true);
    expect(isFixable({ fix: makeFix("r", []) })).toBe(false);
  });
});
