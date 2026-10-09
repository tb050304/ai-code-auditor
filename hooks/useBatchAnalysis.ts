/**
 * 批量 AST 分析 Hook
 *
 * 管理批量分析的状态：进度、结果、是否正在运行
 * 封装 Worker 池管理、缓存、取消等能力
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { getBatchAnalyzer } from "@/lib/ast/batch-analyzer";
import { analyzeFileContent } from "@/lib/ast/batch-types";
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
  /**
   * 用最新内容在主线程重新分析单个文件并替换结果 Map 中对应条目
   * （自动修复落地后原地刷新，不必重跑整批 Worker 分析）。
   */
  reanalyzeFile: (path: string, content: string) => FileAnalysisResult;
}

export function useBatchAnalysis(): UseBatchAnalysisReturn {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [result, setResult] = useState<BatchAnalysisResult | null>(null);
  const [fileResults, setFileResults] = useState<Map<string, FileAnalysisResult>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const runIdRef = useRef(0);
  // Day 27：进度回调 debounce — Worker 每个文件都会回调，1000 文件 = 1000 次 setProgress，
  // 合并为 100ms 一次，减少 90%+ 的无效渲染
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestProgressRef = useRef<BatchProgress | null>(null);
  const flushProgress = useCallback(() => {
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    if (latestProgressRef.current) {
      setProgress(latestProgressRef.current);
    }
  }, []);

  const startAnalysis = useCallback(async (tasks: FileAnalysisTask[]) => {
    const runId = ++runIdRef.current;
    setIsAnalyzing(true);
    setError(null);
    setProgress(null);
    setResult(null);
    setFileResults(new Map());
    // Day 27：重置 debounce 状态
    latestProgressRef.current = null;
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }

    try {
      const analyzer = getBatchAnalyzer();

      const finalResult = await analyzer.analyze(tasks, (p) => {
        // 过期的运行，忽略进度
        if (runId !== runIdRef.current) return;
        // Day 27：debounce 进度更新，100ms 内多次回调合并为一次 setState
        latestProgressRef.current = p;
        if (progressTimerRef.current) return; // 已有定时器在等待
        progressTimerRef.current = setTimeout(() => {
          progressTimerRef.current = null;
          setProgress(latestProgressRef.current);
        }, 100);
      });

      if (runId !== runIdRef.current) return null;

      setResult(finalResult);
      setFileResults(finalResult.results);
      return finalResult;
    } catch (err) {
      if (runId !== runIdRef.current) return null;
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (runId === runIdRef.current) {
        flushProgress(); // 确保最终进度立即渲染
        setIsAnalyzing(false);
      }
    }
  }, [flushProgress]);

  const cancelAnalysis = useCallback(() => {
    runIdRef.current++;
    getBatchAnalyzer().cancel();
    flushProgress();
    setIsAnalyzing(false);
  }, [flushProgress]);

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

  const reanalyzeFile = useCallback((path: string, content: string) => {
    const fileResult = analyzeFileContent(path, content);
    setFileResults((prev) => {
      const next = new Map(prev);
      next.set(path, fileResult);
      return next;
    });
    return fileResult;
  }, []);

  // 组件卸载时取消
  useEffect(() => {
    // 复制到 effect 局部变量，cleanup 中不直接读取可能已变化的 ref.current
    const runIdAtMount = runIdRef.current;
    return () => {
      runIdRef.current = runIdAtMount + 1;
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
    reanalyzeFile,
  };
}
