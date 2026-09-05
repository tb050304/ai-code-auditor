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
