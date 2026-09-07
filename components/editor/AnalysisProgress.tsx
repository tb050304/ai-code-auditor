"use client";
import React from "react";
import type { BatchProgress, BatchAnalysisResult } from "@/lib/ast/batch-types";

interface AnalysisProgressProps {
  isAnalyzing: boolean;
  progress: BatchProgress | null;
  result: BatchAnalysisResult | null;
  error: string | null;
  onCancel?: () => void;
  onReanalyze?: () => void;
}

export default function AnalysisProgress({
  isAnalyzing,
  progress,
  result,
  error,
  onCancel,
  onReanalyze,
}: AnalysisProgressProps) {
  if (!isAnalyzing && !result && !error) return null;

  const percent = progress ? Math.round(progress.percent * 100) : 0;

  return (
    <div className="bg-slate-900 border-t border-slate-800 px-4 py-2 text-xs text-slate-400 flex items-center gap-3 shrink-0">
      {isAnalyzing ? (
        <>
          <span className="text-cyan-400 flex-shrink-0">⚡ 批量分析中</span>
          <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden max-w-md">
            <div
              className="h-full bg-cyan-500 transition-all duration-200"
              style={{ width: `${percent}%` }}
            />
          </div>
          {progress ? (
            <span className="flex-shrink-0 text-slate-500 tabular-nums">
              {progress.completed}/{progress.total} ({percent}%)
            </span>
          ) : (
            <span className="flex-shrink-0 text-slate-500">准备中…</span>
          )}
          {progress && (
            <span className="flex-shrink-0 truncate max-w-[200px] text-slate-500" title={progress.currentPath}>
              {progress.currentPath}
            </span>
          )}
          {onCancel && (
            <button
              onClick={onCancel}
              className="flex-shrink-0 ml-2 px-2 py-0.5 rounded bg-red-600/20 text-red-400 hover:bg-red-600/40 hover:text-red-300 border border-red-600/30 transition-colors"
              title="取消分析"
            >
              取消
            </button>
          )}
        </>
      ) : result ? (
        <>
          <span className="text-emerald-400 flex-shrink-0">✓ 批量分析完成</span>
          <span className="flex-shrink-0 tabular-nums">
            {result.analyzedFiles} 个文件
          </span>
          <span className="flex-shrink-0 text-amber-400 tabular-nums">
            {result.totalIssues} 个问题
            {result.highSeverity > 0 && (
              <span className="text-red-400"> ({result.highSeverity} 高危)</span>
            )}
          </span>
          <span className="flex-shrink-0 text-slate-600">
            {(result.duration / 1000).toFixed(1)}s
          </span>
          {result.failedFiles > 0 && (
            <span className="flex-shrink-0 text-red-400">
              {result.failedFiles} 个失败
            </span>
          )}
          {onReanalyze && (
            <button
              onClick={onReanalyze}
              className="ml-auto text-cyan-400 hover:text-cyan-300 flex-shrink-0"
              title="重新分析"
            >
              重新分析
            </button>
          )}
        </>
      ) : error ? (
        <>
          <span className="text-red-400 flex-shrink-0">✕ 分析失败</span>
          <span className="truncate">{error}</span>
          {onReanalyze && (
            <button
              onClick={onReanalyze}
              className="ml-auto text-cyan-400 hover:text-cyan-300 flex-shrink-0"
            >
              重试
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}
