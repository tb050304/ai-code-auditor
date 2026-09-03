// ---------------------------------------------------------------------------
// useAuditor —— AI 审计执行 Hook
// ---------------------------------------------------------------------------
// 职责：负责与 /api/audit 的流式通信（SSE 文本流），以及中止控制。
// 会话层（useConversations）从它解耦：本 Hook 不直接写会话，
// 而是通过 onChunk / onStatus 回调把增量内容交还调用方去落会话。
//
// 设计要点：
//   1. history 参数支持多轮上下文（把此前的 user/assistant 消息传给后端）。
//   2. 每次 startAudit 都会中止上一次仍在进行的请求，避免串流。
//   3. 出现错误时，把可读错误信息追加到已累积文本末尾，UI 可见但不抛异常。
// ---------------------------------------------------------------------------

import { useState, useCallback, useRef, useEffect } from "react";
import type { AuditHistoryMessage } from "@/types";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

/** 流状态回调：running / done / error / aborted */
export type AuditStreamStatus = "running" | "done" | "error" | "aborted";

export interface StartAuditOptions {
  code: string;
  userPrompt?: string;
  modelId?: string;
  /** 多轮历史（可选），由调用方从当前会话构造 */
  history?: AuditHistoryMessage[];
  /** 每次读取到增量时回调；参数为全量累积文本 */
  onChunk: (content: string) => void;
  /** 状态变化回调 */
  onStatus: (status: AuditStreamStatus) => void;
}

/** 判断是否为“用户主动取消请求”的错误，避免把 AbortError 当真实错误处理 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function useAuditor() {
  const [isAuditing, setIsAuditing] = useState<boolean>(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  // 当前进行中的请求句柄，用于“停止输出”时中止
  const abortRef = useRef<AbortController | null>(null);
  const isModelsFetched = useRef(false);

  // ---------------- 模型列表（一次拉取） ----------------
  const fetchModels = useCallback(async () => {
    if (isModelsFetched.current) return;
    isModelsFetched.current = true;
    try {
      const response = await fetch("/api/audit");
      const availableModels = await response.json();
      setModels(availableModels);
      setSelectedModel((prev) => prev || availableModels[0]?.id || "");
    } catch (error) {
      console.error("Failed to fetch models:", error);
      isModelsFetched.current = false;
    }
  }, []);

  // 挂载后异步拉取可用模型；放入微任务以满足 react-hooks/set-state-in-effect 校验
  useEffect(() => {
    queueMicrotask(() => {
      void fetchModels();
    });
  }, [fetchModels]);

  // ---------------- 停止当前审计 ----------------
  const stopAudit = useCallback(() => {
    const controller = abortRef.current;
    if (controller) controller.abort();
  }, []);

  // ---------------- 启动审计（流式） ----------------
  const startAudit = useCallback(
    async ({ code, userPrompt, modelId, history, onChunk, onStatus }: StartAuditOptions) => {
      if (!code.trim()) return;

      // 取消上一次请求，确保同一时刻只有一个流在跑
      if (abortRef.current) abortRef.current.abort();

      const controller = new AbortController();
      abortRef.current = controller;
      setIsAuditing(true);
      onStatus("running");

      let accumulated = "";
      try {
        const response = await fetch("/api/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            model: modelId || selectedModel,
            userPrompt,
            history,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`审计服务返回错误：HTTP ${response.status}`);
        }
        if (!response.body) {
          throw new Error("浏览器不支持流式读取");
        }

        // 逐块读取 SSE 文本流
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          onChunk(accumulated);
        }
        onStatus("done");
      } catch (error: unknown) {
        // 用户主动中止：静默标记为 aborted，不污染内容
        if (isAbortError(error)) {
          onStatus("aborted");
          return;
        }
        const message = error instanceof Error ? error.message : "未知错误，请检查控制台。";
        console.error("Audit stream error:", error);
        const errorText = `\n\n**审计中断：${message}**`;
        onChunk(accumulated + errorText);
        onStatus("error");
      } finally {
        setIsAuditing(false);
        // 仅在仍指向本次请求时清理，避免误清最新请求
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [selectedModel]
  );

  return {
    isAuditing,
    models,
    selectedModel,
    setSelectedModel,
    startAudit,
    stopAudit,
  };
}