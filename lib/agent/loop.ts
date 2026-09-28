/**
 * Agent 思考-执行循环（Day 20）
 *
 * 职责：把"模型输出 → 解析工具调用 → 执行 → 回执 → 继续思考"的多轮循环
 * 收敛为一个纯函数 runAgentLoop，模型调用与工具执行全部依赖注入：
 *   - callModel  ：发一轮对话（流式，onDelta 上报累积原文），返回全文
 *   - executeTool：执行一次工具调用（tool-executor 创建的执行器，永不 reject）
 *   - onEvent    ：每一步的事件流（UI 流式展示每步思考与工具卡片）
 *
 * 协议：模型用 ```tool 围栏 JSON 块发起调用（格式见 prompt.ts），
 * parseToolCalls / stripToolBlocks 负责解析与剥离。
 *
 * 防失控：maxSteps 硬上限 + AbortSignal 中止；工具执行异常收敛为
 * ok=false 回执，循环永不抛异常。
 *
 * 本模块不依赖 React / 浏览器 API（AgentStep 类型供会话持久化复用）。
 */

import type { ToolCall, ToolName, ToolResult } from "./tool-types";
import { formatToolReceipts } from "./tool-executor";

// ---------------------------------------------------------------------------
// 步骤数据结构（UI 展示与会话持久化共用）
// ---------------------------------------------------------------------------

/** 一次工具调用与其结果（执行完成前 result 为 null） */
export interface AgentStepCall {
  call: ToolCall;
  result: ToolResult | null;
}

/** 循环中的一步：模型的一段思考文本 + 本步发起的全部工具调用 */
export interface AgentStep {
  id: string;
  /** 步骤序号（从 1 开始） */
  index: number;
  /** 本步模型可见文本（已剥离工具调用块） */
  text: string;
  calls: AgentStepCall[];
  status: "running" | "done" | "error";
}

// ---------------------------------------------------------------------------
// 工具调用块解析协议
// ---------------------------------------------------------------------------

/** 从模型输出解析出的原始工具调用（tool 名未校验，执行器负责兜底） */
export interface ParsedToolCall {
  tool: string;
  args: Record<string, unknown>;
}

const TOOL_FENCE_OPEN = /^\s*```tool\s*$/i;
const FENCE_CLOSE = /^\s*```\s*$/;

function parseToolJson(raw: string): ParsedToolCall | null {
  try {
    const obj: unknown = JSON.parse(raw.trim());
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const tool = (obj as { tool?: unknown }).tool;
      if (typeof tool === "string" && tool.trim()) {
        const args = (obj as { args?: unknown }).args;
        return {
          tool: tool.trim(),
          args:
            args && typeof args === "object" && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
        };
      }
    }
  } catch {
    // 非法 JSON：跳过该块（模型下一轮可自我纠正）
  }
  return null;
}

/** 解析模型输出中全部 ```tool 围栏块（未闭合的尾部块也会尽力解析） */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  let inBlock = false;
  let buffer: string[] = [];

  const flush = () => {
    const call = parseToolJson(buffer.join("\n"));
    if (call) calls.push(call);
    buffer = [];
  };

  for (const line of text.split("\n")) {
    if (!inBlock) {
      if (TOOL_FENCE_OPEN.test(line)) {
        inBlock = true;
        buffer = [];
      }
    } else if (FENCE_CLOSE.test(line)) {
      inBlock = false;
      flush();
    } else {
      buffer.push(line);
    }
  }
  // 流式场景下尾部块可能未闭合，尽力解析
  if (inBlock && buffer.length > 0) flush();
  return calls;
}

/** 剥离全部 ```tool 围栏块，得到展示给用户的文本（普通 ```js 等代码块不受影响） */
export function stripToolBlocks(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (!inBlock) {
      if (TOOL_FENCE_OPEN.test(line)) {
        inBlock = true;
      } else {
        out.push(line);
      }
    } else if (FENCE_CLOSE.test(line)) {
      inBlock = false;
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 循环器
// ---------------------------------------------------------------------------

/** 循环消息（不含 system：服务端 /api/agent 统一注入 Agent 系统提示） */
export interface AgentLoopMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 循环结束原因 */
export type AgentLoopDoneReason = "final" | "max-steps" | "aborted" | "error";

export type AgentLoopEvent =
  | { type: "step-start"; step: number }
  /** 本轮流式增量（raw 为本轮累积原文，含工具块） */
  | { type: "delta"; step: number; raw: string }
  /** 本轮流结束后的可见文本（已剥离工具块，与 delta 重算结果一致） */
  | { type: "step-text"; step: number; text: string }
  | { type: "tool-call"; step: number; call: ToolCall }
  | { type: "tool-result"; step: number; result: ToolResult }
  | { type: "error"; message: string }
  | { type: "done"; reason: AgentLoopDoneReason; steps: number };

export interface AgentLoopDeps {
  /** 发一轮对话：onDelta 上报本轮累积原文；失败时 throw（由循环收敛） */
  callModel(
    messages: AgentLoopMessage[],
    onDelta: (raw: string) => void,
    signal?: AbortSignal,
  ): Promise<string>;
  /** 执行一次工具调用（承诺永不 reject，仍兜底 try/catch） */
  executeTool(call: ToolCall): Promise<ToolResult>;
  /** 事件回调（UI 流式展示） */
  onEvent(event: AgentLoopEvent): void;
  /** 最大步数（每步 = 一次模型调用），防止无限循环 */
  maxSteps?: number;
  signal?: AbortSignal;
}

export interface AgentLoopOutcome {
  reason: AgentLoopDoneReason;
  /** 最终答复文本（final = 最后一轮可见文本；error/max-steps = 已收到的可见文本） */
  finalText: string;
  steps: number;
}

/** 默认最大步数：一轮模型调用 + 工具执行 + 回执为一步 */
export const DEFAULT_MAX_AGENT_STEPS = 8;

export async function runAgentLoop(
  initialMessages: AgentLoopMessage[],
  deps: AgentLoopDeps,
): Promise<AgentLoopOutcome> {
  const messages: AgentLoopMessage[] = [...initialMessages];
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
  let step = 0;
  let finalText = "";

  const finish = (reason: AgentLoopDoneReason): AgentLoopOutcome => {
    deps.onEvent({ type: "done", reason, steps: step });
    return { reason, finalText, steps: step };
  };

  for (;;) {
    if (deps.signal?.aborted) return finish("aborted");
    if (step >= maxSteps) return finish("max-steps");
    step++;
    deps.onEvent({ type: "step-start", step });

    // 1) 调模型（流式），异常收敛
    let raw = "";
    try {
      raw = await deps.callModel(
        messages,
        (full) => deps.onEvent({ type: "delta", step, raw: full }),
        deps.signal,
      );
    } catch (err: unknown) {
      if (deps.signal?.aborted) return finish("aborted");
      const message = err instanceof Error && err.message ? err.message : String(err);
      // 保留已收到的部分文本作为 finalText（可能为空）
      finalText = stripToolBlocks(raw).trim();
      deps.onEvent({ type: "error", message });
      return finish("error");
    }

    // 2) 解析工具调用；没有调用 = 最终答复，循环结束
    const calls = parseToolCalls(raw);
    const visible = stripToolBlocks(raw);
    deps.onEvent({ type: "step-text", step, text: visible });
    messages.push({ role: "assistant", content: raw });

    if (calls.length === 0) {
      finalText = visible.trim();
      return finish("final");
    }

    // 3) 顺序执行工具，收集回执
    const results: ToolResult[] = [];
    for (let i = 0; i < calls.length; i++) {
      if (deps.signal?.aborted) return finish("aborted");
      const parsed = calls[i];
      const call: ToolCall = {
        id: `c${step}-${i + 1}`,
        name: parsed.tool as ToolName,
        args: parsed.args,
      };
      deps.onEvent({ type: "tool-call", step, call });
      let result: ToolResult;
      try {
        result = await deps.executeTool(call);
      } catch (err: unknown) {
        // 执行器承诺永不 reject；这里兜底防御注入的非法执行器
        result = {
          callId: call.id,
          name: call.name,
          ok: false,
          error: err instanceof Error && err.message ? err.message : String(err),
          duration: 0,
        };
      }
      results.push(result);
      deps.onEvent({ type: "tool-result", step, result });
    }

    // 4) 回执以用户消息形式继续对话
    messages.push({ role: "user", content: formatToolReceipts(results) });
  }
}
