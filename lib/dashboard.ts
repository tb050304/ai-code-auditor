/**
 * 问题统计仪表板（Day 26）
 *
 * 把批量 AST 分析结果聚合为可视化仪表盘数据：
 *   - computeDashboardStats：问题总数 / 按类别分布 / 高危文件 Top N / 分析覆盖
 *   - 趋势：每次批量分析完成后把快照存入 localStorage，面板读取历史并渲染折线
 *
 * 全部为纯函数（除趋势存储外），无 React 依赖，可独立测试。
 */

import type { IssueType } from "./ast";
import type { FileAnalysisResult, BatchAnalysisResult } from "./ast/batch-types";
import { CATEGORY_LABELS } from "./report";

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface DashboardCategory {
  type: IssueType;
  label: string;
  error: number;
  warning: number;
  info: number;
  total: number;
  /** 占总问题数的百分比（0~100） */
  pct: number;
}

export interface DashboardFileItem {
  path: string;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  total: number;
  /** 高危 = 含 error */
  hasError: boolean;
}

/** 一次分析的轻量趋势点（存入 localStorage） */
export interface TrendPoint {
  /** 完成时间戳（ms） */
  at: number;
  totalIssues: number;
  error: number;
  warning: number;
  info: number;
  analyzedFiles: number;
}

export interface DashboardStats {
  /** 问题总览 */
  totals: { error: number; warning: number; info: number; total: number };
  /** 按类别分布（按 total 降序） */
  categories: DashboardCategory[];
  /** 高危文件 Top N（默认含 error 优先，再按总数降序） */
  topFiles: DashboardFileItem[];
  /** 分析覆盖：成功 / 失败 / 总文件 / 耗时 */
  coverage: { analyzed: number; failed: number; total: number; duration: number };
  /** 是否存在任何分析问题 */
  hasIssues: boolean;
}

// ---------------------------------------------------------------------------
// 统计计算
// ---------------------------------------------------------------------------

export function computeDashboardStats(
  fileResults: Map<string, FileAnalysisResult>,
  batchResult: BatchAnalysisResult | null,
  topN = 10,
): DashboardStats {
  let error = 0;
  let warning = 0;
  let info = 0;
  const catMap = new Map<IssueType, DashboardCategory>();
  const files: DashboardFileItem[] = [];

  for (const [path, result] of fileResults.entries()) {
    if (!result.success) continue;
    let fError = 0;
    let fWarning = 0;
    let fInfo = 0;
    for (const issue of result.issues) {
      if (issue.severity === "error") { error++; fError++; }
      else if (issue.severity === "warning") { warning++; fWarning++; }
      else { info++; fInfo++; }

      const cat = catMap.get(issue.type) ?? {
        type: issue.type,
        label: CATEGORY_LABELS[issue.type],
        error: 0, warning: 0, info: 0, total: 0, pct: 0,
      };
      cat[issue.severity]++;
      cat.total++;
      catMap.set(issue.type, cat);
    }
    const total = fError + fWarning + fInfo;
    if (total > 0) {
      files.push({ path, errorCount: fError, warningCount: fWarning, infoCount: fInfo, total, hasError: fError > 0 });
    }
  }

  const grandTotal = error + warning + info;

  // 类别分布：按 total 降序，计算百分比
  const categories = [...catMap.values()]
    .sort((a, b) => b.total - a.total)
    .map((c) => ({ ...c, pct: grandTotal > 0 ? Math.round((c.total / grandTotal) * 100) : 0 }));

  // Top N 高危文件：先按是否含 error，再按 error 数，再按总数
  const topFiles = [...files]
    .sort((a, b) => {
      if (a.hasError !== b.hasError) return a.hasError ? -1 : 1;
      if (a.errorCount !== b.errorCount) return b.errorCount - a.errorCount;
      return b.total - a.total;
    })
    .slice(0, topN);

  return {
    totals: { error, warning, info, total: grandTotal },
    categories,
    topFiles,
    coverage: {
      analyzed: batchResult?.analyzedFiles ?? countSuccessful(fileResults),
      failed: batchResult?.failedFiles ?? countFailed(fileResults),
      total: batchResult?.totalFiles ?? fileResults.size,
      duration: batchResult?.duration ?? 0,
    },
    hasIssues: grandTotal > 0,
  };
}

function countSuccessful(results: Map<string, FileAnalysisResult>): number {
  let n = 0;
  for (const r of results.values()) if (r.success) n++;
  return n;
}

function countFailed(results: Map<string, FileAnalysisResult>): number {
  let n = 0;
  for (const r of results.values()) if (!r.success) n++;
  return n;
}

// ---------------------------------------------------------------------------
// 趋势历史（localStorage）
// ---------------------------------------------------------------------------

const TREND_KEY_PREFIX = "ai-code-auditor:trend:";
/** 每个项目最多保留的趋势点数量 */
export const TREND_MAX_POINTS = 30;

interface TrendStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 获取趋势存储。浏览器用 window.localStorage；
 * 测试 / SSR 通过 globalThis.__TREND_STORAGE__ 注入 mock。
 */
function storage(): TrendStorageLike | null {
  try {
    const g = globalThis as unknown as { __TREND_STORAGE__?: TrendStorageLike; window?: { localStorage?: TrendStorageLike } };
    if (g.__TREND_STORAGE__) return g.__TREND_STORAGE__;
    if (g.window?.localStorage) return g.window.localStorage;
  } catch {
    /* 忽略 */
  }
  return null;
}

function trendKey(projectId: string): string {
  return `${TREND_KEY_PREFIX}${projectId}`;
}

/** 读取某项目的趋势点（旧 → 新，按时间升序）。读取失败返回空数组。 */
export function loadTrend(projectId: string): TrendPoint[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(trendKey(projectId));
    if (!raw) return [];
    const arr = JSON.parse(raw) as TrendPoint[];
    if (!Array.isArray(arr)) return [];
    // 过滤掉损坏的点并排序
    return arr
      .filter((p) => p && typeof p.at === "number" && typeof p.totalIssues === "number")
      .sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

/**
 * 追加一个趋势点（分析完成后调用）。超出上限时淘汰最旧的。
 * 返回是否写入成功（SSR / 隐私模式下静默失败）。
 */
export function appendTrendPoint(
  projectId: string,
  point: Omit<TrendPoint, "at"> & { at?: number },
): boolean {
  const s = storage();
  if (!s) return false;
  try {
    const history = loadTrend(projectId);
    const next: TrendPoint = { at: point.at ?? Date.now(), ...point };
    // 去掉可能覆盖的 at 之外字段重复
    const clean: TrendPoint = { at: next.at, totalIssues: next.totalIssues, error: next.error, warning: next.warning, info: next.info, analyzedFiles: next.analyzedFiles };
    history.push(clean);
    const trimmed = history.slice(-TREND_MAX_POINTS);
    s.setItem(trendKey(projectId), JSON.stringify(trimmed));
    return true;
  } catch {
    return false;
  }
}

/** 清空某项目趋势（删除项目时调用） */
export function clearTrend(projectId: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem?.(trendKey(projectId));
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 图表辅助（SVG 折线用）
// ---------------------------------------------------------------------------

/** 折线图的单个数据点（归一化坐标，0~1 区间） */
export interface NormalizedPoint {
  x: number; // 0~1
  y: number; // 0~1
  value: number;
  label: string;
}

/**
 * 把一组数值归一化为 SVG 折线点。
 * 始终留顶部/底部各 10% 空白，避免贴边。
 */
export function normalizeTrendLine(
  values: number[],
  labels: string[],
): NormalizedPoint[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const n = values.length;
  return values.map((v, i) => ({
    x: n === 1 ? 0.5 : i / (n - 1),
    // 10% 顶部/底部留白
    y: 0.9 - ((v - min) / range) * 0.8,
    value: v,
    label: labels[i] ?? "",
  }));
}

/** 生成 SVG polyline 的 points 字符串 */
export function trendLinePoints(pts: NormalizedPoint[], width: number, height: number): string {
  return pts.map((p) => `${(p.x * width).toFixed(1)},${(p.y * height).toFixed(1)}`).join(" ");
}
