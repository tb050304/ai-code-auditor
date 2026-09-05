/**
 * 批量 AST 分析 Hook
 *
 * 管理批量分析的状态：进度、结果、是否正在运行
 * 封装 Worker 池管理、缓存、取消等能力
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { getBatchAnalyzer } from "@/lib/ast/batch-analyzer";
import type {
  FileAnalysisTask,
  FileAnalysisResult,
  BatchProgress,
  BatchAnalysisResult,
} from "@/lib/ast/batch-types";

export interface UseBatchAnalysisReturn {
  /** 是否正在分析 */
  isAnalyzing: boolean;
  /** 当前进度 */
  progress: BatchProgress | null;
  /** 最终结果（完整的一次分析结束后才有） */
  result: BatchAnalysisResult | null;
  /** 按文件路径索引的结果 Map（分析过程中逐步填充） */
  fileResults: Map<string, FileAnalysisResult>;
  /** 错误信息 */
  error: string | null;
  /** 启动批量分析 */
  startAnalysis: (tasks: FileAnalysisTask[]) => Promise<BatchAnalysisResult | null>;
  /** 取消当前分析 */
  cancelAnalysis: () => void;
  /** 清空结果 */
  clearResult: () => void;
  /** 获取单个文件的问题（用于当前编辑器文件） */
  getFileIssues: (path: string) => FileAnalysisResult["issues"];
}

export function useBatchAnalysis(): UseBatchAnalysisReturn {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [result, setResult] = useState<BatchAnalysisResult | null>(null);
  const [fileResults, setFileResults] = useState<Map<string, FileAnalysisResult>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const runIdRef = useRef(0);

  const startAnalysis = useCallback(async (tasks: FileAnalysisTask[]) => {
    const runId = ++runIdRef.current;
    setIsAnalyzing(true);
    setError(null);
    setProgress(null);
    setResult(null);
    setFileResults(new Map());

    try {
      const analyzer = getBatchAnalyzer();

      const finalResult = await analyzer.analyze(tasks, (p) => {
        // 过期的运行，忽略进度
        if (runId !== runIdRef.current) return;
        setProgress(p);
      });

      if (runId !== runIdRef.current) return null;

      setResult(finalResult);
      setFileResults(finalResult.results);
      return finalResult;
    } catch (err: any) {
      if (runId !== runIdRef.current) return null;
      setError(err?.message ?? String(err));
      return null;
    } finally {
      if (runId === runIdRef.current) {
        setIsAnalyzing(false);
      }
    }
  }, []);

  const cancelAnalysis = useCallback(() => {
    runIdRef.current++;
    getBatchAnalyzer().cancel();
    setIsAnalyzing(false);
  }, []);

  const clearResult = useCallback(() => {
    setResult(null);
    setProgress(null);
    setError(null);
    setFileResults(new Map());
  }, []);

  const getFileIssues = useCallback(
    (path: string): FileAnalysisResult["issues"] => {
      const r = fileResults.get(path);
      return r?.issues ?? [];
    },
    [fileResults],
  );

  // 组件卸载时取消
  useEffect(() => {
    return () => {
      runIdRef.current++;
    };
  }, []);

  return {
    isAnalyzing,
    progress,
    result,
    fileResults,
    error,
    startAnalysis,
    cancelAnalysis,
    clearResult,
    getFileIssues,
  };
}
