/**
 * Day 16 自动修复规则测试
 * 端到端：analyzeCode 产出 issue.fix → applyFixes 应用 → 断言结果代码。
 */
import { describe, it, expect } from "vitest";
import { analyzeCode } from "@/lib/ast";
import { applyFixes, isFixable } from "@/lib/ast/fixer";

function firstFix(code: string, ruleId: string) {
  const issue = analyzeCode(code).issues.find((i) => i.id === ruleId);
  expect(issue, `应命中规则 ${ruleId}`).toBeDefined();
  expect(isFixable(issue!), `规则 ${ruleId} 应带自动修复`).toBe(true);
  return issue!.fix!;
}

function applyAll(code: string) {
  const fixes = analyzeCode(code).issues
    .filter(isFixable)
    .map((i) => i.fix!);
  return applyFixes(code, fixes);
}

describe("规则自动修复 — no-debugger", () => {
  it("删除 debugger 语句", () => {
    const code = "let a = 1;\ndebugger;\nlet b = 2;";
    const r = applyFixes(code, [firstFix(code, "no-debugger")]);
    expect(r.applied[0]).toMatchObject({ ruleId: "no-debugger", risk: "safe" });
    // 删除语句后留下空行，不影响语义
    expect(r.code.replace(/\n{2,}/g, "\n")).toBe("let a = 1;\nlet b = 2;");
  });
});

describe("规则自动修复 — no-var", () => {
  it("将 var 替换为 let（保守，不猜 const）", () => {
    const code = "var x = 1;\nvar y;";
    const r = applyAll(code);
    expect(r.code).toBe("let x = 1;\nlet y;");
    expect(r.applied.every((f) => f.ruleId === "no-var")).toBe(true);
  });

  it("多行 var 声明仅替换首个关键字", () => {
    const code = "var a = 1,\n    b = 2,\n    c = 3;";
    const r = applyAll(code);
    expect(r.code).toBe("let a = 1,\n    b = 2,\n    c = 3;");
  });
});

describe("规则自动修复 — eqeqeq", () => {
  it("将 == 替换为 ===", () => {
    const code = "if (a == b) {}";
    const r = applyFixes(code, [firstFix(code, "eqeqeq")]);
    expect(r.code).toBe("if (a === b) {}");
  });

  it("将 != 替换为 !==", () => {
    const code = "if (a != b) {}";
    const r = applyFixes(code, [firstFix(code, "eqeqeq")]);
    expect(r.code).toBe("if (a !== b) {}");
  });

  it("无空格的操作符也能正确替换", () => {
    const code = "a==b";
    const r = applyFixes(code, [firstFix(code, "eqeqeq")]);
    // 中间区间被替换为 " === "
    expect(r.code).toBe("a === b");
  });
});

describe("规则自动修复 — no-console-log", () => {
  it("删除独立的 console.log 语句", () => {
    const code = "let a = 1;\nconsole.log(a);\nlet b = 2;";
    const r = applyFixes(code, [firstFix(code, "no-console-log")]);
    expect(r.applied[0]).toMatchObject({ ruleId: "no-console-log", risk: "risky" });
    expect(r.code.replace(/\n{2,}/g, "\n")).toBe("let a = 1;\nlet b = 2;");
  });

  it("console.log 作为子表达式时不提供 fix（避免破坏语法/副作用）", () => {
    const code = "const x = fn(console.log(1));";
    const issue = analyzeCode(code).issues.find((i) => i.id === "no-console-log");
    expect(issue).toBeDefined();
    expect(isFixable(issue!)).toBe(false);
  });

  it("console.log 同行内联语句也能移除", () => {
    const code = "if (a) console.log(1);";
    const r = applyFixes(code, [firstFix(code, "no-console-log")]);
    // ExpressionStatement 的 loc.end 包含分号，删除后留下 "if (a) "（合法）
    expect(r.code).toBe("if (a) ");
  });
});

describe("混合规则批量修复", () => {
  it("四条规则同时命中，一次应用全部生效", () => {
    const code =
      "var x = 1;\n" +
      "debugger;\n" +
      "console.log(x);\n" +
      "if (x == 1) {\n" +
      "  console.log('hi');\n" +
      "}";
    const r = applyAll(code);
    // var→let, debugger 删, 两处 console.log 删, ==→===
    expect(r.applied.map((f) => f.ruleId).sort()).toEqual(
      ["no-var", "no-debugger", "no-console-log", "no-console-log", "eqeqeq"].sort(),
    );
    const clean = r.code.replace(/\n{2,}/g, "\n").replace(/^\s*\n/gm, "");
    expect(clean).toBe("let x = 1;\nif (x === 1) {\n}");
  });
});
