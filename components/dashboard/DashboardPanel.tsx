"use client";
/**
 * 项目统计仪表板（Day 26）
 *
 * 面板内容：
 *   1. 顶部四张卡片：错误 / 警告 / 提示 / 合计
 *   2. 按类别分布：SVG 横向堆叠条形图（错误=红、警告=橙、提示=蓝）
 *   3. 高危文件 Top 10：表格，点击文件名打开对应文件
 *   4. 问题趋势：最近 30 次批量分析的折线图（totalIssues）
 *
 * 数据来自 page.tsx 传入的 fileResults + batchResult + trend（localStorage）。
 */
import React, { useMemo } from "react";
import type { FileAnalysisResult, BatchAnalysisResult } from "@/lib/ast/batch-types";
import {
  computeDashboardStats,
  loadTrend,
  normalizeTrendLine,
  trendLinePoints,
  type TrendPoint,
} from "@/lib/dashboard";
import { CATEGORY_LABELS } from "@/lib/report";

interface DashboardPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
  projectName: string;
  fileResults: Map<string, FileAnalysisResult>;
  batchResult: BatchAnalysisResult | null;
  /** 点击文件名时打开该文件 */
  onOpenFile?: (path: string) => void;
}

const SEVERITY_COLORS = {
  error: "#ef4444",
  warning: "#f59e0b",
  info: "#3b82f6",
} as const;

const CATEGORY_ORDER: Array<keyof typeof CATEGORY_LABELS> = [
  "security",
  "best-practice",
  "performance",
  "maintainability",
  "typescript",
  "react",
];

export default function DashboardPanel({
  open,
  onClose,
  projectId,
  projectName,
  fileResults,
  batchResult,
  onOpenFile,
}: DashboardPanelProps) {
  const stats = useMemo(
    () => computeDashboardStats(fileResults, batchResult, 10),
    [fileResults, batchResult],
  );

  const trend: TrendPoint[] = useMemo(
    () => (open && projectId ? loadTrend(projectId) : []),
    [open, projectId],
  );

  if (!open) return null;

  const hasData = stats.coverage.analyzed > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="项目统计仪表板"
    >
      <div className="w-[min(920px,94vw)] max-h-[90vh] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* 头部 */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-700 bg-slate-900/95 px-5 py-3 backdrop-blur">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-100">📊 项目统计</h2>
            <p className="truncate text-xs text-slate-500">{projectName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="p-5 space-y-6">
          {!hasData && (
            <div className="rounded-lg border border-dashed border-slate-700 bg-slate-800/40 p-8 text-center text-sm text-slate-400">
              还没有分析数据。请先点击「批量分析」运行一次完整项目分析。
            </div>
          )}

          {hasData && (
            <>
              {/* 一、总览卡片 */}
              <section aria-label="问题总览">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="错误" value={stats.totals.error} color={SEVERITY_COLORS.error} />
                  <StatCard label="警告" value={stats.totals.warning} color={SEVERITY_COLORS.warning} />
                  <StatCard label="提示" value={stats.totals.info} color={SEVERITY_COLORS.info} />
                  <StatCard label="合计" value={stats.totals.total} color="#e2e8f0" strong />
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  已分析 {stats.coverage.analyzed} / {stats.coverage.total} 个文件
                  {stats.coverage.failed > 0 && (
                    <span className="text-rose-400">（{stats.coverage.failed} 个失败）</span>
                  )}
                  {stats.coverage.duration > 0 && <> · 耗时 {(stats.coverage.duration / 1000).toFixed(2)}s</>}
                </p>
              </section>

              {/* 二、按类别分布 */}
              {stats.categories.length > 0 && (
                <section aria-label="按类别分布">
                  <h3 className="mb-3 text-sm font-medium text-slate-200">按类别分布</h3>
                  <div className="space-y-2">
                    {CATEGORY_ORDER.map((type) => {
                      const cat = stats.categories.find((c) => c.type === type);
                      if (!cat) return null;
                      return (
                        <div key={type} className="flex items-center gap-3 text-xs">
                          <span className="w-24 shrink-0 text-slate-400">{cat.label}</span>
                          <div className="h-4 flex-1 overflow-hidden rounded bg-slate-800">
                            <StackedBar
                              error={cat.error}
                              warning={cat.warning}
                              info={cat.info}
                              total={stats.totals.total}
                            />
                          </div>
                          <span className="w-14 shrink-0 text-right tabular-nums text-slate-400">
                            {cat.total}（{cat.pct}%）
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* 三、高危文件 Top 10 */}
              {stats.topFiles.length > 0 && (
                <section aria-label="高危文件 Top 10">
                  <h3 className="mb-3 text-sm font-medium text-slate-200">高危文件 Top {stats.topFiles.length}</h3>
                  <div className="overflow-hidden rounded-lg border border-slate-700">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-800/60 text-left text-slate-400">
                          <th className="px-3 py-2 font-medium">文件</th>
                          <th className="px-3 py-2 font-medium text-right" style={{ color: SEVERITY_COLORS.error }}>错误</th>
                          <th className="px-3 py-2 font-medium text-right" style={{ color: SEVERITY_COLORS.warning }}>警告</th>
                          <th className="px-3 py-2 font-medium text-right" style={{ color: SEVERITY_COLORS.info }}>提示</th>
                          <th className="px-3 py-2 font-medium text-right">合计</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {stats.topFiles.map((f, i) => (
                          <tr key={f.path} className="bg-slate-900 hover:bg-slate-800/50">
                            <td className="max-w-0 truncate px-3 py-2">
                              <button
                                type="button"
                                onClick={() => onOpenFile?.(f.path)}
                                className="truncate text-left text-cyan-400 hover:underline"
                                title={f.path}
                              >
                                {i + 1}. {f.path.slice(1)}
                              </button>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums" style={{ color: SEVERITY_COLORS.error }}>
                              {f.errorCount || "—"}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums" style={{ color: SEVERITY_COLORS.warning }}>
                              {f.warningCount || "—"}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums" style={{ color: SEVERITY_COLORS.info }}>
                              {f.infoCount || "—"}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-200">{f.total}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* 四、问题趋势 */}
              {trend.length > 0 && (
                <section aria-label="问题趋势">
                  <h3 className="mb-3 text-sm font-medium text-slate-200">问题趋势（最近 {trend.length} 次分析）</h3>
                  <TrendChart points={trend} />
                  <div className="mt-2 flex justify-between text-[10px] text-slate-500">
                    <span>{formatTime(trend[0].at)}</span>
                    <span>{formatTime(trend[trend.length - 1].at)}</span>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function StatCard({ label, value, color, strong }: { label: string; value: number; color: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <div className="text-2xl font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
      <div className={`mt-1 text-xs ${strong ? "font-medium text-slate-300" : "text-slate-500"}`}>{label}</div>
    </div>
  );
}

/** 横向堆叠条形图（纯 CSS），宽度按占总数百分比归一化 */
function StackedBar({ error, warning, info, total }: { error: number; warning: number; info: number; total: number }) {
  if (total === 0) return null;
  const w = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="flex h-full w-full">
      <div style={{ width: w(error), background: SEVERITY_COLORS.error }} title={`错误 ${error}`} />
      <div style={{ width: w(warning), background: SEVERITY_COLORS.warning }} title={`警告 ${warning}`} />
      <div style={{ width: w(info), background: SEVERITY_COLORS.info }} title={`提示 ${info}`} />
    </div>
  );
}

const TREND_W = 800;
const TREND_H = 120;

/** 问题趋势 SVG 折线图（totalIssues） */
function TrendChart({ points }: { points: TrendPoint[] }) {
  const values = points.map((p) => p.totalIssues);
  const labels = points.map((p) => formatTime(p.at));
  const norm = normalizeTrendLine(values, labels);
  const line = trendLinePoints(norm, TREND_W, TREND_H);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-950/50 p-3">
      <svg viewBox={`0 0 ${TREND_W} ${TREND_H}`} className="h-28 w-full" preserveAspectRatio="none" aria-hidden>
        {/* 网格 */}
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1="0"
            x2={TREND_W}
            y1={TREND_H * ratio}
            y2={TREND_H * ratio}
            stroke="#1e293b"
            strokeWidth="1"
          />
        ))}
        {norm.length > 1 ? (
          <polyline
            fill="none"
            stroke="#22d3ee"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={line}
          />
        ) : (
          // 单点时画一个圆点而不是线
          norm.length === 1 && (
            <circle cx={norm[0].x * TREND_W} cy={norm[0].y * TREND_H} r="4" fill="#22d3ee" />
          )
        )}
        {/* 数据点 */}
        {norm.map((p, i) => (
          <g key={i}>
            <circle cx={p.x * TREND_W} cy={p.y * TREND_H} r="3" fill="#0e7490" />
            <text
              x={p.x * TREND_W}
              y={p.y * TREND_H - 8}
              textAnchor="middle"
              className="fill-slate-400 text-[10px] tabular-nums"
            >
              {p.value}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
