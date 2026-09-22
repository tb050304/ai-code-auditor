import { analyzeCode } from "../ast";
import type { Issue } from "../ast";

/** 单文件分析任务 */
export interface FileAnalysisTask {
  path: string;
  content: string;
}

/** 单文件分析结果 */
export interface FileAnalysisResult {
  path: string;
  success: boolean;
  issues: Issue[];
  duration: number;
  error?: string;
  /** 内容哈希，用于缓存命中判断 */
  contentHash: string;
}

/** 批量分析进度事件 */
export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  currentPath: string;
  /** 0 ~ 1 */
  percent: number;
}

/** 批量分析最终结果 */
export interface BatchAnalysisResult {
  totalFiles: number;
  analyzedFiles: number;
  failedFiles: number;
  totalIssues: number;
  highSeverity: number;
  duration: number;
  results: Map<string, FileAnalysisResult>;
}

/** Worker 消息类型 */
export type WorkerMessage =
  | { type: "analyze"; task: FileAnalysisTask }
  | { type: "result"; path: string; result: FileAnalysisResult }
  | { type: "error"; path: string; error: string };

/** 可分析的文件扩展名 */
export const ANALYZABLE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

/** 判断文件是否可分析（基于扩展名） */
export function isAnalyzableFile(path: string): boolean {
  const lower = path.toLowerCase();
  return ANALYZABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 简单字符串哈希（djb2），用于缓存键与内容版本标识 */
export function hashContent(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 在当前线程对单文件内容执行一次完整分析（Worker 内与修复落地后的原地刷新共用）。
 * 不抛异常：分析器内部错误收敛为 success=false 的结果。
 */
export function analyzeFileContent(path: string, content: string): FileAnalysisResult {
  const contentHash = hashContent(content);
  try {
    const start = performance.now();
    const result = analyzeCode(content, path);
    const duration = performance.now() - start;
    const fileResult: FileAnalysisResult = {
      path,
      success: result.parseResult.success,
      issues: result.issues,
      duration,
      contentHash,
    };
    if (!result.parseResult.success && result.parseResult.error) {
      fileResult.error = result.parseResult.error;
    }
    return fileResult;
  } catch (err) {
    return {
      path,
      success: false,
      issues: [],
      duration: 0,
      contentHash,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
