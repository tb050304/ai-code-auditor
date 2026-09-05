/**
 * AST 分析 Web Worker
 * 在独立线程中执行单文件 AST 分析，避免阻塞主线程。
 *
 * 接收主线程发来的 { type: "analyze", task: { path, content } }
 * 返回 { type: "result", path, result: FileAnalysisResult }
 */

import { analyzeCode } from "../ast";
import type { FileAnalysisTask, FileAnalysisResult, WorkerMessage } from "./batch-types";

// 简单的字符串哈希（djb2），用于缓存键
function hashContent(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (msg.type !== "analyze") return;

  const task: FileAnalysisTask = msg.task;
  const contentHash = hashContent(task.content);

  try {
    const start = performance.now();
    const result = analyzeCode(task.content, task.path);
    const duration = performance.now() - start;

    const success = result.parseResult.success;
    const fileResult: FileAnalysisResult = {
      path: task.path,
      success,
      issues: result.issues,
      duration,
      contentHash,
    };

    if (!success && result.parseResult.error) {
      fileResult.error = result.parseResult.error;
    }

    self.postMessage({
      type: "result",
      path: task.path,
      result: fileResult,
    } as WorkerMessage);
  } catch (err: any) {
    self.postMessage({
      type: "error",
      path: task.path,
      error: err?.message ?? String(err),
    } as WorkerMessage);
  }
};

export {};
