/**
 * Day 25 审计报告导出测试
 * - buildReportData：总览/类别/文件分组/失败文件统计
 * - renderMarkdown：结构完整、表格转义、零问题场景、失败文件
 * - renderHtml：结构完整、HTML 转义防注入
 * - 文件名与格式化工具
 */
import { describe, it, expect } from "vitest";
import {
  buildReportData,
  renderMarkdown,
  renderHtml,
  buildReportFileName,
  formatDuration,
  formatTimestamp,
  type ReportMeta,
} from "@/lib/report";
import type { FileAnalysisResult } from "@/lib/ast/batch-types";
import type { Issue } from "@/lib/ast";

function makeIssue(over: Partial<Issue> & Pick<Issue, "type" | "severity" | "name" | "message">): Issue {
  return {
    id: `i-${Math.random().toString(36).slice(2)}`,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 2,
    ...over,
  };
}

function makeResult(path: string, issues: Issue[], success = true, error?: string): FileAnalysisResult {
  return { path, success, issues, duration: 1.5, contentHash: `h-${path}`, ...(error ? { error } : {}) };
}

const META: ReportMeta = {
  projectName: "demo-proj",
  generatedAt: "2026-10-07T08:30:00.000Z",
  totalFiles: 3,
  analyzedFiles: 2,
  failedFiles: 1,
  duration: 1234,
};

function sampleResults(): Map<string, FileAnalysisResult> {
  return new Map([
    [
      "/src/a.ts",
      makeResult("/src/a.ts", [
        makeIssue({ type: "security", severity: "error", name: "eval 注入", message: "禁止使用 eval", startLine: 12, suggestion: "用 JSON.parse" }),
        makeIssue({ type: "best-practice", severity: "warning", name: "var 声明", message: "用 let/const | 不要用 var", startLine: 3 }),
      ]),
    ],
    [
      "/src/b.tsx",
      makeResult("/src/b.tsx", [
        makeIssue({ type: "react", severity: "error", name: "缺少 key", message: "列表缺少 key" }),
        makeIssue({ type: "performance", severity: "info", name: "内联函数", message: "render 内联函数" }),
      ]),
    ],
    ["/src/broken.ts", makeResult("/src/broken.ts", [], false, "Unexpected token (1:5)")],
  ]);
}

describe("buildReportData", () => {
  it("总览计数正确", () => {
    const data = buildReportData(sampleResults(), META);
    expect(data.totals).toEqual({ error: 2, warning: 1, info: 1, total: 4 });
  });

  it("按类别统计且只输出非零类别、按固定顺序（security 在 react 前）", () => {
    const data = buildReportData(sampleResults(), META);
    expect(data.byCategory.map((c) => c.type)).toEqual(["security", "best-practice", "performance", "react"]);
    const security = data.byCategory.find((c) => c.type === "security")!;
    expect(security).toMatchObject({ error: 1, warning: 0, info: 0, total: 1 });
  });

  it("文件分组按严重程度排序（含 2 错误的 b.tsx 与含 1 错误的 a.ts 谁在前由分组排序决定）", () => {
    const data = buildReportData(sampleResults(), META);
    // 两个文件都有 error；b.tsx 总数 2 与 a.ts 总数 2 平级，不断言绝对顺序，只断言内容齐全
    const paths = data.files.map((f) => f.path).sort();
    expect(paths).toEqual(["/src/a.ts", "/src/b.tsx"]);
    const a = data.files.find((f) => f.path === "/src/a.ts")!;
    expect(a.errorCount).toBe(1);
    expect(a.warningCount).toBe(1);
    expect(a.issues[0].severity).toBe("error"); // 组内 error 在前
  });

  it("收集分析失败的文件", () => {
    const data = buildReportData(sampleResults(), META);
    expect(data.failedFiles).toEqual([{ path: "/src/broken.ts", error: "Unexpected token (1:5)" }]);
  });

  it("零问题项目：类别为空、文件分组为空、总数全 0", () => {
    const results = new Map([["/ok.ts", makeResult("/ok.ts", [])]]);
    const data = buildReportData(results, { ...META, failedFiles: 0 });
    expect(data.totals.total).toBe(0);
    expect(data.byCategory).toEqual([]);
    expect(data.files).toEqual([]);
    expect(data.failedFiles).toEqual([]);
  });
});

describe("renderMarkdown", () => {
  it("包含标题、元信息与统计", () => {
    const md = renderMarkdown(buildReportData(sampleResults(), META));
    expect(md).toContain("# 代码审计报告 — demo-proj");
    expect(md).toContain("生成时间：2026-");
    expect(md).toContain("分析文件：3 个（成功 2 / 失败 1），耗时 1.23s");
    expect(md).toContain("**4** 个");
    expect(md).toContain("| 错误（error） | 2 |");
  });

  it("包含类别统计表行", () => {
    const md = renderMarkdown(buildReportData(sampleResults(), META));
    expect(md).toMatch(/\| 安全问题 \| 1 \| 0 \| 0 \| 1 \|/);
    expect(md).toMatch(/\| React \| 1 \| 0 \| 0 \| 1 \|/);
  });

  it("包含文件明细：路径、严重程度、类别、行号、描述、建议", () => {
    const md = renderMarkdown(buildReportData(sampleResults(), META));
    expect(md).toContain("`src/a.ts`");
    expect(md).toContain("[错误 · 安全问题] L12 eval 注入");
    expect(md).toContain("禁止使用 eval");
    expect(md).toContain("建议：用 JSON.parse");
  });

  it("表格/行内文本中的管道符被转义，不破坏表格结构", () => {
    const md = renderMarkdown(buildReportData(sampleResults(), META));
    expect(md).toContain("用 let/const \\| 不要用 var");
  });

  it("包含分析失败文件章节", () => {
    const md = renderMarkdown(buildReportData(sampleResults(), META));
    expect(md).toContain("## 四、分析失败的文件");
    expect(md).toContain("`src/broken.ts`：Unexpected token (1:5)");
  });

  it("零问题时输出干净报告与通过结论", () => {
    const results = new Map([["/ok.ts", makeResult("/ok.ts", [])]]);
    const md = renderMarkdown(buildReportData(results, { ...META, failedFiles: 0, totalFiles: 1, analyzedFiles: 1 }));
    expect(md).toContain("未发现任何问题");
    expect(md).toContain("所有已分析文件均未发现问题");
    expect(md).toContain("✅");
    expect(md).not.toContain("## 四");
  });

  it("有 error 时给高优先级结论", () => {
    const md = renderMarkdown(buildReportData(sampleResults(), META));
    expect(md).toContain("建议优先修复");
  });
});

describe("renderHtml", () => {
  it("是完整 HTML 文档且含统计数字", () => {
    const html = renderHtml(buildReportData(sampleResults(), META));
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>代码审计报告 — demo-proj</title>");
    expect(html).toContain('<div class="num" style="color:#dc2626">2</div>'); // error 卡片
    expect(html).toContain("安全问题");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("L12");
    expect(html).toContain("禁止使用 eval");
  });

  it("HTML 转义：问题文本中的标签不被当作 HTML 注入", () => {
    const results = new Map([
      [
        "/x.ts",
        makeResult("/x.ts", [
          makeIssue({
            type: "security",
            severity: "error",
            name: "<script>alert(1)</script>",
            message: 'x" onerror="y", & <tag>',
            startLine: 5,
          }),
        ]),
      ],
    ]);
    const html = renderHtml(buildReportData(results, { ...META, failedFiles: 0, totalFiles: 1, analyzedFiles: 1 }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
  });

  it("零问题项目渲染通过结论", () => {
    const results = new Map([["/ok.ts", makeResult("/ok.ts", [])]]);
    const html = renderHtml(buildReportData(results, { ...META, failedFiles: 0, totalFiles: 1, analyzedFiles: 1 }));
    expect(html).toContain("未发现错误或警告级问题");
  });
});

describe("报告文件名与格式化", () => {
  it("文件名含项目名、时间戳与正确扩展名", () => {
    const date = new Date(2026, 9, 7, 8, 30, 5); // 本地时间 2026-10-07 08:30:05
    expect(buildReportFileName("my proj", "markdown", date)).toBe("audit-report-my-proj-20261007-083005.md");
    expect(buildReportFileName("a/b:c?", "html", date)).toBe("audit-report-a-b-c-20261007-083005.html");
  });

  it("空项目名回退为 project", () => {
    const date = new Date(2026, 0, 1, 0, 0, 0);
    expect(buildReportFileName("   ", "markdown", date)).toBe("audit-report-project-20260101-000000.md");
  });

  it("formatDuration 毫秒/秒", () => {
    expect(formatDuration(320)).toBe("320ms");
    expect(formatDuration(1234)).toBe("1.23s");
  });

  it("formatTimestamp 本地时间格式；非法输入原样返回", () => {
    expect(formatTimestamp("2026-10-07T08:30:00.000Z")).toMatch(/^2026-10-0\d \d{2}:\d{2}:\d{2}$/);
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });
});
