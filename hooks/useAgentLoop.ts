"use client";
/**
 * useAgentLoop —— Agent 思考-执行循环编排 Hook（Day 20）
 *
 * 职责：
 *   1. 维护循环的运行状态（steps / isAgentRunning / error）与中止控制。
 *   2. callModel：POST /api/agent 读流式文本（服务端无状态，每轮循环调一次）。
 *   3. 把 runAgentLoop 的事件流映射为 AgentStep[]（含工具卡片与结果），
 *      通过 onUpdate 回调交由页面写入会话消息，实现"流式展示每一步"。
 *
 * 设计要点：
 *   - 步骤数据在 ref 中高频更新，每步再浅拷贝数组通知 React，避免闭包过期。
 *   - 中止后忽略后续事件（工具在浏览器执行无法硬中断，结果不再写入 UI）。
 *   - 工具执行由注入的 executeToolCall（useAgentTools 桥接）完成，本 Hook
 *     不含任何工具语义。
 */

import { useState, useCallback, useRef } from "react";
import {
  runAgentLoop,
  stripToolBlocks,
  type AgentLoopMessage,
  type AgentLoopOutcome,
  type AgentStep,
} from "@/lib/agent/loop";
import { compactToolResultForUI, type ToolExecutor } from "@/lib/agent/tool-executor";
import type { AgentLoopEvent } from "@/lib/agent/loop";
import { createId } from "@/lib/messages";

/** 判断是否为"用户主动取消请求"的错误 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export interface AgentTaskOptions {
  modelId?: string;
  /** 每次状态变化回调：页面用它把 steps/content/status 写入会话消息 */
  onUpdate: (patch: { steps: AgentStep[]; content: string; status?: "done" | "error" | "aborted" }) => void;
}

export function useAgentLoop({ executeToolCall }: { executeToolCall: ToolExecutor }) {
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // 循环内高频更新走 ref，避免 setState 闭包过期问题
  const stepsRef = useRef<AgentStep[]>([]);
  const runningRef = useRef(false);

  const stopAgent = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const runAgentTask = useCallback(
    async (instruction: string, options: AgentTaskOptions): Promise<AgentLoopOutcome | null> => {
      if (runningRef.current) return null;
      if (!instruction.trim()) return null;

      const { onUpdate } = options;

      const commitSteps = () => {
        setSteps([...stepsRef.current]);
        const last = stepsRef.current[stepsRef.current.length - 1];
        onUpdate({ steps: [...stepsRef.current], content: last ? last.text : "" });
      };

      const handleEvent = (event: AgentLoopEvent) => {
        switch (event.type) {
          case "step-start": {
            stepsRef.current = [
              ...stepsRef.current,
              { id: createId("step"), index: event.step, text: "", calls: [], status: "running" },
            ];
            break;
          }
          case "delta": {
            // 增量原文 → 重算剥离工具块后的可见文本
            stepsRef.current = stepsRef.current.map((s) =>
              s.index === event.step ? { ...s, text: stripToolBlocks(event.raw) } : s,
            );
            break;
          }
          case "step-text": {
            stepsRef.current = stepsRef.current.map((s) =>
              s.index === event.step ? { ...s, text: event.text } : s,
            );
            break;
          }
          case "tool-call": {
            stepsRef.current = stepsRef.current.map((s) =>
              s.index === event.step
                ? { ...s, calls: [...s.calls, { call: event.call, result: null }] }
                : s,
            );
            break;
          }
          case "tool-result": {
            stepsRef.current = stepsRef.current.map((s) =>
              s.index === event.step
                ? {
                    ...s,
                    calls: s.calls.map((c) =>
                      c.call.id === event.result.callId
                        ? { ...c, result: compactToolResultForUI(event.result) }
                        : c,
                    ),
                  }
                : s,
            );
            break;
          }
          case "error": {
            setAgentError(event.message);
            break;
          }
          case "done": {
            stepsRef.current = stepsRef.current.map((s) =>
              s.status === "running" ? { ...s, status: "done" } : s,
            );
            break;
          }
        }
        commitSteps();
      };

      // 中止上一次仍在进行的任务
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      runningRef.current = true;

      stepsRef.current = [];
      setSteps([]);
      setAgentError(null);
      setIsAgentRunning(true);

      // 单轮模型调用：POST /api/agent 读流式文本，onDelta 上报累积原文
      const callModel = async (
        messages: AgentLoopMessage[],
        onDelta: (raw: string) => void,
        signal?: AbortSignal,
      ): Promise<string> => {
        const response = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages, model: options.modelId }),
          signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`Agent 服务返回错误：HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
        }
        if (!response.body) {
          throw new Error("浏览器不支持流式读取");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          onDelta(accumulated);
        }
        return accumulated;
      };

      try {
        const outcome = await runAgentLoop([{ role: "user", content: instruction }], {
          callModel,
          executeTool: executeToolCall,
          signal: controller.signal,
          onEvent: (event) => {
            // 中止后忽略迟到事件（工具调用可能还在收尾）
            if (controller.signal.aborted) return;
            handleEvent(event);
          },
        });

        // 终态：content 用最终答复；出错/中止时标注消息状态
        const status: "done" | "error" | "aborted" =
          outcome.reason === "error" ? "error" : outcome.reason === "aborted" ? "aborted" : "done";
        const lastText =
          stepsRef.current[stepsRef.current.length - 1]?.text ?? "";
        onUpdate({
          steps: [...stepsRef.current],
          content: outcome.finalText || lastText,
          status,
        });
        setSteps([...stepsRef.current]);
        return outcome;
      } catch (error: unknown) {
        // 循环本身承诺不抛异常；防御性兜底（如 handleEvent 内部异常）
        if (!isAbortError(error)) {
          const message = error instanceof Error && error.message ? error.message : String(error);
          setAgentError(message);
          onUpdate({
            steps: [...stepsRef.current],
            content: `**Agent 执行异常：${message}**`,
            status: "error",
          });
        }
        return null;
      } finally {
        runningRef.current = false;
        setIsAgentRunning(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [executeToolCall],
  );

  return {
    /** 已完成的步骤（响应式快照，供非会话场景使用） */
    steps,
    isAgentRunning,
    agentError,
    runAgentTask,
    stopAgent,
  };
}
