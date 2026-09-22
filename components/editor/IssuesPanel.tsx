"use client";
import React, { useState, useMemo } from "react";
import { groupIssuesByFile, summarizeIssues, type NodeIssueSummary } from "@/lib/ast/issue-aggregate";
import type { FileAnalysisResult } from "@/lib/ast/batch-types";
import type { Issue } from "@/lib/ast";
import { isFixable } from "@/lib/ast/fixer";

interface IssuesPanelProps {
  fileResults: Map<string, FileAnalysisResult>;
  /** 点击问题时的回调：打开文件并滚动到指定行 */
  onIssueClick?: (path: string, line: number) => void;
  /** 当前激活的文件路径（用于高亮） */
  activeFilePath?: string | null;
  /** 对单个文件应用全部可自动修复的问题（弹出预览） */
  onAutoFixFile?: (path: string) => void;
  /** 对所有文件一键应用可自动修复的问题 */
  onAutoFixAll?: () => void;
  /** 修复流程进行中（禁用按钮避免并发写） */
  isFixing?: boolean;
}

type FilterType = "all" | "error" | "warning" | "info";

const SEVERITY_STYLES: Record<string, { dot: string; text: string; bg: string }> = {
  error: { dot: "bg-red-500", text: "text-red-400", bg: "bg-red-500/10" },
  warning: { dot: "bg-yellow-500", text: "text-yellow-400", bg: "bg-yellow-500/10" },
  info: { dot: "bg-blue-500", text: "text-blue-400", bg: "bg-blue-500/10" },
};

const SEVERITY_LABEL: Record<string, string> = {
  error: "错误",
  warning: "警告",
  info: "提示",
};

export default function IssuesPanel({
  fileResults,
  onIssueClick,
  activeFilePath,
  onAutoFixFile,
  onAutoFixAll,
  isFixing = false,
}: IssuesPanelProps) {
  const [filter, setFilter] = useState<FilterType>("all");
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => groupIssuesByFile(fileResults), [fileResults]);

  // 全项目可自动修复的问题总数（不受当前严重度过滤器影响）
  const totalFixable = useMemo(
    () =>
      grouped.reduce(
        (sum, g) => sum + g.issues.filter((i) => isFixable(i)).length,
        0,
      ),
    [grouped],
  );

  const summary = useMemo<NodeIssueSummary>(() => {
    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    for (const g of grouped) {
      errorCount += g.summary.errorCount;
      warningCount += g.summary.warningCount;
      infoCount += g.summary.infoCount;
    }
    return summarizeIssues(
      Array.from({ length: errorCount }, () => ({ severity: "error" } as Issue))
        .concat(Array.from({ length: warningCount }, () => ({ severity: "warning" } as Issue)))
        .concat(Array.from({ length: infoCount }, () => ({ severity: "info" } as Issue))),
    );
  }, [grouped]);

  // 按过滤器过滤
  const filteredGroups = useMemo(() => {
    if (filter === "all") return grouped;
    return grouped
      .map((g) => ({
        ...g,
        issues: g.issues.filter((i) => i.severity === filter),
      }))
      .filter((g) => g.issues.length > 0);
  }, [grouped, filter]);

  const toggleExpand = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleIssueClick = (path: string, line: number) => {
    onIssueClick?.(path, line);
  };

  if (grouped.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-xs text-slate-500">
        <div className="text-3xl mb-2">✅</div>
        <div>暂无问题</div>
        <div className="text-slate-600 mt-1">所有已分析文件都很干净</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-slate-900 text-slate-300">
      {/* 头部：统计 + 过滤器 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-slate-200">问题</span>
          <span className="text-slate-500">
            {summary.total} 个
          </span>
          {onAutoFixAll && totalFixable > 0 && (
            <button
              type="button"
              disabled={isFixing}
              onClick={onAutoFixAll}
              title="对所有文件应用可自动修复的问题（写前自动快照，可回退）"
              className="ml-1 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              🔧 一键修复 {totalFixable}
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5 text-xs">
          <FilterButton
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label="全部"
            count={summary.total}
          />
          <FilterButton
            active={filter === "error"}
            onClick={() => setFilter("error")}
            label="错误"
            count={summary.errorCount}
            color="error"
          />
          <FilterButton
            active={filter === "warning"}
            onClick={() => setFilter("warning")}
            label="警告"
            count={summary.warningCount}
            color="warning"
          />
          <FilterButton
            active={filter === "info"}
            onClick={() => setFilter("info")}
            label="提示"
            count={summary.infoCount}
            color="info"
          />
        </div>
      </div>

      {/* 问题列表 */}
      <div className="flex-1 overflow-y-auto">
        {filteredGroups.length === 0 ? (
          <div className="p-4 text-center text-xs text-slate-500">
            当前筛选下无问题
          </div>
        ) : (
          filteredGroups.map((group) => {
            const isExpanded = expandedFiles.has(group.path) || activeFilePath === group.path;
            const isActive = activeFilePath === group.path;
            const styles = SEVERITY_STYLES[group.summary.level];
            const fixableCount = group.issues.filter((i) => isFixable(i)).length;

            return (
              <div key={group.path} className="border-b border-slate-800/60 last:border-b-0">
                {/* 文件头 */}
                <div
                  className={`
                    flex items-center gap-1 px-3 py-1.5 cursor-pointer text-xs
                    hover:bg-slate-800/50
                    ${isActive ? "bg-cyan-500/10" : ""}
                  `}
                  onClick={() => toggleExpand(group.path)}
                >
                  <span className="text-slate-500 w-3 text-center flex-shrink-0">
                    {isExpanded ? "▾" : "▸"}
                  </span>
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${styles.dot}`} />
                  <span className="truncate flex-1 min-w-0 text-slate-300" title={group.path}>
                    {group.path.slice(1)}
                  </span>
                  {onAutoFixFile && fixableCount > 0 && (
                    <button
                      type="button"
                      disabled={isFixing}
                      title={`修复该文件 ${fixableCount} 个可自动修复的问题（预览确认）`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onAutoFixFile(group.path);
                      }}
                      className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      🔧 {fixableCount}
                    </button>
                  )}
                  <span className="text-slate-500 flex-shrink-0 ml-2">
                    {group.issues.length}
                  </span>
                </div>

                {/* 问题列表 */}
                {isExpanded && (
                  <div className="pb-1">
                    {group.issues.map((issue, idx) => (
                      <div
                        key={`${issue.id}-${idx}`}
                        className={`
                          flex items-start gap-2 px-3 py-1.5 text-xs cursor-pointer
                          hover:bg-slate-800/40 pl-8
                        `}
                        onClick={() => handleIssueClick(group.path, issue.startLine)}
                        title={`点击跳转到第 ${issue.startLine} 行`}
                      >
                        <span
                          className={`
                            w-2 h-2 rounded-full flex-shrink-0 mt-1
                            ${SEVERITY_STYLES[issue.severity].dot}
                          `}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className={`${SEVERITY_STYLES[issue.severity].text} font-medium`}>
                              {SEVERITY_LABEL[issue.severity]}
                            </span>
                            <span className="text-slate-600 text-[10px]">
                              L{issue.startLine}
                            </span>
                            <span className="text-slate-500 text-[10px] truncate">
                              {issue.name}
                            </span>
                            {isFixable(issue) && (
                              <span
                                className="text-[9px] px-1 rounded bg-emerald-500/15 text-emerald-300 flex-shrink-0"
                                title={`该问题可自动修复（风险：${issue.fix?.risk === "safe" ? "低" : issue.fix?.risk === "review" ? "需复核" : "较高"}）`}
                              >
                                可修复
                              </span>
                            )}
                          </div>
                          <div className="text-slate-400 mt-0.5 truncate" title={issue.message}>
                            {issue.message}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------- 过滤按钮 ----------

function FilterButton({
  active,
  onClick,
  label,
  count,
  color = "all",
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  color?: "all" | "error" | "warning" | "info";
}) {
  const colorClass =
    color === "error"
      ? "text-red-400"
      : color === "warning"
        ? "text-yellow-400"
        : color === "info"
          ? "text-blue-400"
          : "";

  return (
    <button
      onClick={onClick}
      className={`
        px-2 py-0.5 rounded text-xs transition-colors
        ${active ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"}
        ${colorClass}
      `}
    >
      {label} {count}
    </button>
  );
}
