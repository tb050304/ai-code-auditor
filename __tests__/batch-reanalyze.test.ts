/**
 * Day 18 批量修复配套测试
 * - 共享 hashContent / analyzeFileContent（Worker 与主线程 reanalyzeFile 共用）
 * - 端到端：分析 → 取可修复提案 → applyFixes → 重新分析，问题应消失且 contentHash 变化
 */
import { describe, it, expect } from "vitest";
import {
  analyzeFileContent,
  hashContent,
  isAnalyzableFile,
} from "@/lib/ast/batch-types";
import { applyFixes, isFixable } from "@/lib/ast/fixer";

describe("hashContent", () => {
  it("相同内容稳定返回同一哈希", () => {
    expect(hashContent("var x = 1;")).toBe(hashContent("var x = 1;"));
  });

  it("不同内容返回不同哈希", () => {
    expect(hashContent("var x = 1;")).not.toBe(hashContent("var x = 2;"));
  });

  it("空字符串也有稳定哈希", () => {
    expect(hashContent("")).toBe(hashContent(""));
    expect(typeof hashContent("")).toBe("string");
  });
});

describe("analyzeFileContent", () => {
  it("正常代码：success 且返回问题列表与 contentHash", () => {
    const r = analyzeFileContent("/src/a.js", "debugger;");
    expect(r.path).toBe("/src/a.js");
    expect(r.success).toBe(true);
    expect(r.issues.some((i) => i.id === "no-debugger")).toBe(true);
    expect(r.contentHash).toBe(hashContent("debugger;"));
    expect(r.duration).toBeGreaterThanOrEqual(0);
  });

  it("语法错误代码：success=false 且带 error，不抛异常", () => {
    const broken = "function (((";
    const r = analyzeFileContent("/src/b.js", broken);
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.contentHash).toBe(hashContent(broken));
  });

  it("TSX 内容按 .tsx 路径正常分析 JSX", () => {
    const code = 'const els = items.map(item => <li>{item}</li>);';
    const r = analyzeFileContent("/src/C.tsx", code);
    expect(r.success).toBe(true);
    expect(r.issues.some((i) => i.id === "react-no-missing-key")).toBe(true);
  });
});

describe("自动修复 → 重新分析 端到端", () => {
  it("Day 16/17 规则修复后重新分析：问题消失、hash 更新", () => {
    const before = "var x = 1;\ndebugger;\nconst y = \"a\" + x;";
    const r1 = analyzeFileContent("/src/fix.js", before);
    const fixable = r1.issues.filter(isFixable);
    expect(fixable.length).toBeGreaterThanOrEqual(3);

    const applied = applyFixes(
      before,
      fixable.map((i) => i.fix!),
    );
    expect(applied.code).not.toBe(before);
    expect(applied.code).toContain("let x = 1;");
    expect(applied.code).toContain("`a${x}`");

    // 模拟 page.tsx syncFixedFile：修复落地后原地 reanalyze
    const r2 = analyzeFileContent("/src/fix.js", applied.code);
    expect(r2.success).toBe(true);
    expect(r2.issues.some((i) => i.id === "no-var")).toBe(false);
    expect(r2.issues.some((i) => i.id === "no-debugger")).toBe(false);
    expect(r2.issues.some((i) => i.id === "prefer-template")).toBe(false);
    expect(r2.issues.length).toBeLessThan(r1.issues.length);
    expect(r2.contentHash).not.toBe(r1.contentHash);
  });

  it("回退到修复前内容后：问题重新出现且哈希还原", () => {
    // 注意：引用 used 的语句不能自身可被修复（如 console.log 会被删掉），
    // 否则修复后 used 反而真的变成未使用
    const before = "import { used, unused } from 'm';\nfn(used);";
    const r1 = analyzeFileContent("/src/imp.js", before);
    const fixes = r1.issues.filter(isFixable).map((i) => i.fix!);
    const after = applyFixes(before, fixes).code;

    const fixed = analyzeFileContent("/src/imp.js", after);
    expect(fixed.issues.some((i) => i.id === "no-unused-imports")).toBe(false);

    // DiffViewer rollback-all：before 写回后重新分析
    const rolledBack = analyzeFileContent("/src/imp.js", before);
    expect(rolledBack.contentHash).toBe(r1.contentHash);
    expect(rolledBack.issues.some((i) => i.id === "no-unused-imports")).toBe(true);
  });

  it("修复对不可分析扩展名的判断保持一致", () => {
    expect(isAnalyzableFile("/a.tsx")).toBe(true);
    expect(isAnalyzableFile("/a.css")).toBe(false);
  });
});
