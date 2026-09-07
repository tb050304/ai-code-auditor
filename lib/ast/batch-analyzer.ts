/**
 * 批量 AST 分析器（主线程侧）
 *
 * 功能：
 * 1. 管理 Web Worker 池，控制并发数
 * 2. 按文件内容哈希缓存结果，重复文件不重复分析
 * 3. 进度回调（已完成/总数/当前文件/百分比）
 * 4. 支持取消
 *
 * 使用方式：
 *   const analyzer = new BatchAnalyzer({ concurrency: 4 });
 *   analyzer.analyze(files, onProgress).then(result => ...);
 *   analyzer.cancel();
 */

import type {
  FileAnalysisTask,
  FileAnalysisResult,
  BatchProgress,
  BatchAnalysisResult,
  WorkerMessage,
} from "./batch-types";
import { isAnalyzableFile } from "./batch-types";

export interface BatchAnalyzerOptions {
  /** 并发 Worker 数量，默认取 navigator.hardwareConcurrency || 4 */
  concurrency?: number;
  /** 单个文件最大分析时间（ms），超时跳过。默认 30s */
  timeoutMs?: number;
}

/** 缓存：contentHash -> FileAnalysisResult（去掉 path，因为不同文件可能内容相同） */
interface CachedResult {
  issues: FileAnalysisResult["issues"];
  success: boolean;
  duration: number;
  error?: string;
}

export class BatchAnalyzer {
  private concurrency: number;
  private timeoutMs: number;
  private workers: Worker[] = [];
  private busyWorkers = new Set<Worker>();
  private cache = new Map<string, CachedResult>();
  private cancelled = false;
  private workerUrl: string | null = null;
  private cancelCbs: Array<() => void> = [];

  constructor(options: BatchAnalyzerOptions = {}) {
    // Worker 池大小：充分利用多核，AST 分析是 CPU 密集型任务，多 Worker 并行才能快
    // 上限 8 防止极端多核机器创建过多 Worker
    this.concurrency = options.concurrency ?? Math.min(navigator.hardwareConcurrency || 4, 8);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** 确保 Worker 池已初始化 */
  private ensureWorkers() {
    if (this.workers.length > 0) return;

    // 用 import.meta.url 创建 Worker（Webpack 5 原生支持）
    const workerUrl = new URL("./batch-worker.ts", import.meta.url);
    for (let i = 0; i < this.concurrency; i++) {
      const worker = new Worker(workerUrl, { type: "module" });
      this.workers.push(worker);
    }
  }

  /**
   * 批量分析文件
   * @param tasks 文件列表（路径 + 内容）
   * @param onProgress 进度回调
   */
  async analyze(
    tasks: FileAnalysisTask[],
    onProgress?: (progress: BatchProgress) => void,
  ): Promise<BatchAnalysisResult> {
    this.cancelled = false;

    // 过滤：只分析支持的文件类型，跳过空内容
    const analyzable = tasks.filter((t) => isAnalyzableFile(t.path) && t.content.trim().length > 0);
    const total = analyzable.length;

    const resultMap = new Map<string, FileAnalysisResult>();
    let completed = 0;
    let failed = 0;
    const startTime = performance.now();

    if (total === 0) {
      return {
        totalFiles: 0,
        analyzedFiles: 0,
        failedFiles: 0,
        totalIssues: 0,
        highSeverity: 0,
        duration: 0,
        results: resultMap,
      };
    }

    this.ensureWorkers();

    // 任务队列（迭代器）
    const taskIterator = analyzable[Symbol.iterator]();

    // 给每个 Worker 分配一个任务，直到耗尽
    const scheduleNext = (worker: Worker): Promise<void> => {
      if (this.cancelled) return Promise.resolve();

      const next = taskIterator.next();
      if (next.done) return Promise.resolve();

      return this.runTask(worker, next.value).then((result) => {
        resultMap.set(result.path, result);
        completed++;
        if (!result.success) failed++;

        onProgress?.({
          total,
          completed,
          failed,
          currentPath: result.path,
          percent: completed / total,
        });

        return scheduleNext(worker);
      });
    };

    // 启动所有 Worker
    const promises = this.workers.map((w) => scheduleNext(w));
    await Promise.all(promises);

    const duration = performance.now() - startTime;

    // 统计问题数
    let totalIssues = 0;
    let highSeverity = 0;
    for (const r of resultMap.values()) {
      totalIssues += r.issues.length;
      highSeverity += r.issues.filter((i) => i.severity === "error").length;
    }

    return {
      totalFiles: total,
      analyzedFiles: completed,
      failedFiles: failed,
      totalIssues,
      highSeverity,
      duration,
      results: resultMap,
    };
  }

  /** 给单个 Worker 分配单个任务，返回结果 Promise */
  private runTask(worker: Worker, task: FileAnalysisTask): Promise<FileAnalysisResult> {
    return new Promise((resolve) => {
      // 先查缓存
      const contentHash = this.hashContent(task.content);
      const cached = this.cache.get(contentHash);
      if (cached) {
        resolve({
          path: task.path,
          success: cached.success,
          issues: cached.issues,
          duration: cached.duration,
          error: cached.error,
          contentHash,
        });
        return;
      }

      this.busyWorkers.add(worker);

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const handleMessage = (e: MessageEvent<WorkerMessage>) => {
        const msg = e.data;
        if (msg.type === "result" && msg.path === task.path) {
          if (settled) return;
          settled = true;
          cleanup();

          // 写入缓存
          this.cache.set(contentHash, {
            issues: msg.result.issues,
            success: msg.result.success,
            duration: msg.result.duration,
            error: msg.result.error,
          });

          resolve(msg.result);
        } else if (msg.type === "error" && msg.path === task.path) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            path: task.path,
            success: false,
            issues: [],
            duration: 0,
            error: msg.error,
            contentHash,
          });
        }
      };

      const cleanup = () => {
        worker.removeEventListener("message", handleMessage);
        if (timeoutId) clearTimeout(timeoutId);
        this.busyWorkers.delete(worker);
        // 移除取消回调
        const idx = this.cancelCbs.indexOf(onCancel);
        if (idx >= 0) this.cancelCbs.splice(idx, 1);
      };

      const onCancel = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          path: task.path,
          success: false,
          issues: [],
          duration: 0,
          error: "已取消",
          contentHash,
        });
      };
      this.cancelCbs.push(onCancel);

      worker.addEventListener("message", handleMessage);

      // 超时保护
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          path: task.path,
          success: false,
          issues: [],
          duration: this.timeoutMs,
          error: `分析超时（${this.timeoutMs}ms）`,
          contentHash,
        });
      }, this.timeoutMs);

      // 发送任务
      worker.postMessage({ type: "analyze", task } as WorkerMessage);
    });
  }

  /** 取消当前批量分析：立即终止所有 Worker 并重建池 */
  cancel() {
    this.cancelled = true;
    // 先触发所有挂起任务的取消回调，让 Promise 立即 resolve
    for (const cb of this.cancelCbs) {
      try { cb(); } catch {}
    }
    this.cancelCbs = [];
    // 终止正在运行的 Worker（Worker 无法单独中止单个任务，只能整体 terminate）
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
    this.busyWorkers.clear();
  }

  /** 清空缓存 */
  clearCache() {
    this.cache.clear();
  }

  /** 销毁所有 Worker */
  dispose() {
    this.cancelled = true;
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
    this.busyWorkers.clear();
  }

  /** 简单字符串哈希（djb2） */
  private hashContent(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
  }
}

/** 单例：全局共享一个分析器（共享缓存 + Worker 池） */
let globalAnalyzer: BatchAnalyzer | null = null;

export function getBatchAnalyzer(): BatchAnalyzer {
  if (!globalAnalyzer) {
    globalAnalyzer = new BatchAnalyzer();
  }
  return globalAnalyzer;
}
