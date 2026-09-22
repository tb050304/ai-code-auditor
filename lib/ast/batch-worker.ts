/**
 * AST 分析 Web Worker
 * 在独立线程中执行单文件 AST 分析，避免阻塞主线程。
 *
 * 接收主线程发来的 { type: "analyze", task: { path, content } }
 * 返回 { type: "result", path, result: FileAnalysisResult }
 */

import {
  analyzeFileContent,
  type FileAnalysisTask,
  type FileAnalysisResult,
  type WorkerMessage,
} from "./batch-types";

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (msg.type !== "analyze") return;

  const task: FileAnalysisTask = msg.task;

  try {
    const fileResult: FileAnalysisResult = analyzeFileContent(task.path, task.content);

    self.postMessage({
      type: "result",
      path: task.path,
      result: fileResult,
    } as WorkerMessage);
  } catch (err) {
    self.postMessage({
      type: "error",
      path: task.path,
      error: err instanceof Error ? err.message : String(err),
    } as WorkerMessage);
  }
};

export {};
