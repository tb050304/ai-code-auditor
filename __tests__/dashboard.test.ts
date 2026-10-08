/**
 * Day 26 问题统计仪表板测试
 * - computeDashboardStats：总数/类别分布/Top N/覆盖率
 * - 趋势：append/load/clear，localStorage mock，去重、上限、损坏容错
 * - normalizeTrendLine：归一化坐标（含单点、空数据、相同值）
 * - trendLinePoints：SVG points 字符串
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  computeDashboardStats,
  loadTrend,
  appendTrendPoint,
  clearTrend,
  normalizeTrendLine,
  trendLinePoints,
  TREND_MAX_POINTS,
} from "@/lib/dashboard";
import type { FileAnalysisResult, BatchAnalysisResult } from "@/lib/ast/batch-types";
import type { Issue } from "@/lib/ast";

function makeIssue(over: Partial<Issue> & Pick<Issue, "type" | "severity">): Issue {
  return {
    id: `i-${Math.random().toString(36).slice(2)}`,
    name: "t",
    message: "m",
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 2,
    ...over,
  };
}

function makeResult(path: string, issues: Issue[], success = true): FileAnalysisResult {
  return { path, success, issues, duration: 1, contentHash: `h-${path}` };
}

function makeBatch(over: Partial<BatchAnalysisResult> = {}): BatchAnalysisResult {
  return {
    totalFiles: 3,
    analyzedFiles: 2,
    failedFiles: 1,
    totalIssues: 0,
    highSeverity: 0,
    duration: 1000,
    results: new Map(),
    ...over,
  };
}

describe("computeDashboardStats", () => {
  it("总数按严重程度正确累加，hasIssues 正确", () => {
    const results = new Map([
      ["/a.ts", makeResult("/a.ts", [
        makeIssue({ type: "security", severity: "error" }),
        makeIssue({ type: "security", severity: "error" }),
        makeIssue({ type: "react", severity: "warning" }),
      ])],
      ["/b.ts", makeResult("/b.ts", [makeIssue({ type: "typescript", severity: "info" })])],
    ]);
    const s = computeDashboardStats(results, makeBatch(), 10);
    expect(s.totals).toEqual({ error: 2, warning: 1, info: 1, total: 4 });
    expect(s.hasIssues).toBe(true);
  });

  it("失败文件不计入问题统计但计入 coverage", () => {
    const results = new Map([
      ["/a.ts", makeResult("/a.ts", [makeIssue({ type: "security", severity: "error" })])],
      ["/bad.ts", makeResult("/bad.ts", [], false)],
    ]);
    const s = computeDashboardStats(results, makeBatch({ analyzedFiles: 1, failedFiles: 1 }), 10);
    expect(s.totals.total).toBe(1);
    expect(s.coverage.failed).toBe(1);
  });

  it("类别分布按 total 降序、百分比总和 100", () => {
    const results = new Map([
      ["/a.ts", makeResult("/a.ts", [
        makeIssue({ type: "security", severity: "error" }),
        makeIssue({ type: "security", severity: "error" }),
        makeIssue({ type: "security", severity: "warning" }),
        makeIssue({ type: "react", severity: "warning" }),
      ])],
    ]);
    const s = computeDashboardStats(results, makeBatch(), 10);
    expect(s.categories[0].type).toBe("security");
    expect(s.categories[0].total).toBe(3);
    expect(s.categories[0].pct).toBe(75);
    expect(s.categories[1].type).toBe("react");
    expect(s.categories[1].pct).toBe(25);
    const sumPct = s.categories.reduce((a, c) => a + c.pct, 0);
    expect(sumPct).toBe(100);
  });

  it("Top N：含 error 优先，再按 errorCount / total 排序", () => {
    const results = new Map([
      ["/a.ts", makeResult("/a.ts", [makeIssue({ type: "security", severity: "warning" })])], // 无 error
      ["/b.ts", makeResult("/b.ts", [
        makeIssue({ type: "security", severity: "error" }),
        makeIssue({ type: "security", severity: "error" }),
        makeIssue({ type: "security", severity: "warning" }),
      ])],
      ["/c.ts", makeResult("/c.ts", [
        makeIssue({ type: "security", severity: "error" }),
        makeIssue({ type: "security", severity: "warning" }),
        makeIssue({ type: "security", severity: "warning" }),
      ])],
      ["/d.ts", makeResult("/d.ts", [makeIssue({ type: "security", severity: "error" })])],
    ]);
    const s = computeDashboardStats(results, makeBatch(), 10);
    expect(s.topFiles.map((f) => f.path)).toEqual(["/b.ts", "/c.ts", "/d.ts", "/a.ts"]);
    expect(s.topFiles[0].errorCount).toBe(2);
    expect(s.topFiles[1].errorCount).toBe(1);
    // a.ts 无 error 在最后
    expect(s.topFiles[3].hasError).toBe(false);
  });

  it("Top N 截断：只取前 N 个", () => {
    const results = new Map(
      Array.from({ length: 15 }, (_, i) => [
        `/f${i}.ts`,
        makeResult(`/f${i}.ts`, [makeIssue({ type: "security", severity: "error" })]),
      ]),
    );
    const s = computeDashboardStats(results, makeBatch(), 5);
    expect(s.topFiles.length).toBe(5);
  });

  it("零问题：categories/topFiles 为空，hasIssues 为 false", () => {
    const results = new Map([["/ok.ts", makeResult("/ok.ts", [])]]);
    const s = computeDashboardStats(results, makeBatch(), 10);
    expect(s.hasIssues).toBe(false);
    expect(s.categories).toEqual([]);
    expect(s.topFiles).toEqual([]);
  });

  it("batchResult 为 null 时，coverage 从 fileResults 推导", () => {
    const results = new Map([
      ["/a.ts", makeResult("/a.ts", [makeIssue({ type: "security", severity: "error" })])],
      ["/bad.ts", makeResult("/bad.ts", [], false)],
    ]);
    const s = computeDashboardStats(results, null, 10);
    expect(s.coverage.total).toBe(2);
    expect(s.coverage.analyzed).toBe(1);
    expect(s.coverage.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 趋势存储（mock localStorage）
// ---------------------------------------------------------------------------

function makeStorageMock() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, String(v)),
    removeItem: (k: string) => { map.delete(k); },
    __map: map,
  };
}

type G = typeof globalThis & { __TREND_STORAGE__?: ReturnType<typeof makeStorageMock> };

function setTrendStorage() {
  const mock = makeStorageMock();
  (globalThis as G).__TREND_STORAGE__ = mock;
  return mock;
}

describe("trend localStorage", () => {
  beforeEach(() => {
    setTrendStorage();
  });

  it("appendTrendPoint 追加并保留时间升序", () => {
    appendTrendPoint("p1", { totalIssues: 5, error: 2, warning: 2, info: 1, analyzedFiles: 3, at: 1000 });
    appendTrendPoint("p1", { totalIssues: 3, error: 1, warning: 1, info: 1, analyzedFiles: 3, at: 2000 });
    const t = loadTrend("p1");
    expect(t.length).toBe(2);
    expect(t[0].at).toBe(1000);
    expect(t[1].at).toBe(2000);
    expect(t[1].totalIssues).toBe(3);
  });

  it("未指定 at 时使用当前时间", () => {
    const before = Date.now();
    appendTrendPoint("p1", { totalIssues: 1, error: 0, warning: 1, info: 0, analyzedFiles: 1 });
    const t = loadTrend("p1");
    expect(t[0].at).toBeGreaterThanOrEqual(before);
  });

  it("按 projectId 隔离", () => {
    appendTrendPoint("p1", { totalIssues: 1, error: 0, warning: 1, info: 0, analyzedFiles: 1 });
    appendTrendPoint("p2", { totalIssues: 9, error: 9, warning: 0, info: 0, analyzedFiles: 1 });
    expect(loadTrend("p1").length).toBe(1);
    expect(loadTrend("p2")[0].totalIssues).toBe(9);
  });

  it("超过上限时淘汰最旧的", () => {
    for (let i = 0; i < TREND_MAX_POINTS + 5; i++) {
      appendTrendPoint("p1", {
        totalIssues: i,
        error: 0, warning: 0, info: 0,
        analyzedFiles: 1,
        at: 1000 + i,
      });
    }
    const t = loadTrend("p1");
    expect(t.length).toBe(TREND_MAX_POINTS);
    expect(t[0].totalIssues).toBe(5);
    expect(t[TREND_MAX_POINTS - 1].totalIssues).toBe(TREND_MAX_POINTS + 4);
  });

  it("clearTrend 清空", () => {
    appendTrendPoint("p1", { totalIssues: 1, error: 0, warning: 1, info: 0, analyzedFiles: 1 });
    clearTrend("p1");
    expect(loadTrend("p1")).toEqual([]);
  });

  it("损坏的 JSON 返回空数组而不抛错", () => {
    setTrendStorage().setItem("ai-code-auditor:trend:p1", "{not valid json");
    expect(loadTrend("p1")).toEqual([]);
  });

  it("字段不完整的点被过滤", () => {
    setTrendStorage().setItem(
      "ai-code-auditor:trend:p1",
      JSON.stringify([
        { at: 1000, totalIssues: 5, error: 1, warning: 1, info: 1, analyzedFiles: 3 },
        { at: "not-a-number" },
        null,
        { at: 2000, totalIssues: 3, error: 0, warning: 1, info: 0, analyzedFiles: 3 },
      ]),
    );
    const t = loadTrend("p1");
    expect(t.length).toBe(2);
    expect(t[0].totalIssues).toBe(5);
    expect(t[1].totalIssues).toBe(3);
  });

  it("乱序存储读取后按 at 升序", () => {
    setTrendStorage().setItem(
      "ai-code-auditor:trend:p1",
      JSON.stringify([
        { at: 3000, totalIssues: 1, error: 0, warning: 0, info: 0, analyzedFiles: 1 },
        { at: 1000, totalIssues: 5, error: 0, warning: 0, info: 0, analyzedFiles: 1 },
        { at: 2000, totalIssues: 3, error: 0, warning: 0, info: 0, analyzedFiles: 1 },
      ]),
    );
    const t = loadTrend("p1");
    expect(t.map((x) => x.at)).toEqual([1000, 2000, 3000]);
  });
});

// ---------------------------------------------------------------------------
// normalizeTrendLine / trendLinePoints
// ---------------------------------------------------------------------------

describe("normalizeTrendLine", () => {
  it("空数组返回空", () => {
    expect(normalizeTrendLine([], [])).toEqual([]);
  });

  it("单点 x=0.5（居中）", () => {
    const pts = normalizeTrendLine([5], ["a"]);
    expect(pts.length).toBe(1);
    expect(pts[0].x).toBe(0.5);
    expect(pts[0].value).toBe(5);
  });

  it("两个点 x 为 0 和 1", () => {
    const pts = normalizeTrendLine([1, 3], ["a", "b"]);
    expect(pts[0].x).toBe(0);
    expect(pts[1].x).toBe(1);
  });

  it("值域相同时不除以 0（range=1 兜底）", () => {
    const pts = normalizeTrendLine([2, 2, 2], ["a", "b", "c"]);
    // 所有 y 应该相同（都在中间位置）
    expect(pts.every((p) => Math.abs(p.y - pts[0].y) < 1e-9)).toBe(true);
  });

  it("最大/最小值映射到 y 上下边界（10% 留白）", () => {
    const pts = normalizeTrendLine([0, 10], ["a", "b"]);
    // v=0 → y=0.9（底部）；v=10 → y=0.1（顶部）
    expect(pts[0].y).toBeCloseTo(0.9);
    expect(pts[1].y).toBeCloseTo(0.1);
  });

  it("labels 透传", () => {
    const pts = normalizeTrendLine([1, 2], ["t1", "t2"]);
    expect(pts[0].label).toBe("t1");
    expect(pts[1].label).toBe("t2");
  });
});

describe("trendLinePoints", () => {
  it("输出 SVG polyline points 字符串", () => {
    const pts = normalizeTrendLine([0, 10], ["a", "b"]);
    const s = trendLinePoints(pts, 800, 120);
    // x1=0, y1=108 (0.9*120); x2=800, y2=12 (0.1*120)
    expect(s).toBe("0.0,108.0 800.0,12.0");
  });

  it("空数组输出空字符串", () => {
    expect(trendLinePoints([], 100, 100)).toBe("");
  });
});
