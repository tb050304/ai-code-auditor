/**
 * Agent 思考-执行循环测试（Day 20）
 *
 * 覆盖：工具调用块解析协议（parse/strip）、循环器核心行为
 * （final / max-steps / error / aborted / 工具失败继续）、回执序列化、
 * UI 裁剪、Agent 系统提示。
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseToolCalls,
  stripToolBlocks,
  runAgentLoop,
  type AgentLoopEvent,
  type AgentLoopMessage,
  DEFAULT_MAX_AGENT_STEPS,
} from "@/lib/agent/loop";
import { formatToolReceipts, compactToolResultForUI } from "@/lib/agent/tool-executor";
import { buildAgentSystemPrompt } from "@/lib/agent/prompt";
import type { ToolCall, ToolResult } from "@/lib/agent/tool-types";

/** 构造一个成功的工具结果 */
function okResult(call: ToolCall, data: Record<string, unknown> = {}): ToolResult {
  return { callId: call.id, name: call.name, ok: true, data, duration: 5 };
}

/** 构造一个按剧本回应的模型调用（每轮返回一段预设文本） */
function scriptedCallModel(responses: string[]) {
  const receivedMessages: AgentLoopMessage[][] = [];
  let round = 0;
  return {
    receivedMessages,
    callModel: vi.fn(async (messages: AgentLoopMessage[]): Promise<string> => {
      receivedMessages.push(messages.map((m) => ({ ...m })));
      const text = responses[round] ?? "";
      round++;
      return text;
    }),
  };
}

describe("parseToolCalls", () => {
  it("解析单个工具调用块", () => {
    const text = '思考一下。\n```tool\n{"tool":"readFile","args":{"path":"src/a.ts"}}\n```';
    const calls = parseToolCalls(text);
    expect(calls).toEqual([{ tool: "readFile", args: { path: "src/a.ts" } }]);
  });

  it("解析多个工具调用块并保留顺序", () => {
    const text = [
      "先列文件",
      "```tool",
      '{"tool":"listFiles","args":{"prefix":"src/"}}',
      "```",
      "再读文件",
      "```tool",
      '{"tool":"readFile","args":{"path":"src/a.ts"}}',
      "```",
    ].join("\n");
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[0].tool).toBe("listFiles");
    expect(calls[1].tool).toBe("readFile");
  });

  it("缺省 args 时回退为空对象，非法 JSON 的块被跳过", () => {
    const text = [
      "```tool",
      '{"tool":"runAnalysis"}',
      "```",
      "```tool",
      '{"tool": broken',
      "```",
      "```tool",
      '{"args":{"path":"x"}}',
      "```",
    ].join("\n");
    const calls = parseToolCalls(text);
    expect(calls).toEqual([{ tool: "runAnalysis", args: {} }]);
  });

  it("未闭合的尾部块也会尽力解析（流式场景）", () => {
    const text = '```tool\n{"tool":"listFiles","args":{}}\n';
    expect(parseToolCalls(text)).toEqual([{ tool: "listFiles", args: {} }]);
  });

  it("普通代码块（非 tool 围栏）不解析", () => {
    const text = '```json\n{"tool":"readFile"}\n```';
    expect(parseToolCalls(text)).toEqual([]);
  });
});

describe("stripToolBlocks", () => {
  it("剥离 tool 块但保留其他文本与普通代码块", () => {
    const text = [
      "结论如下：",
      "```tool",
      '{"tool":"readFile","args":{}}',
      "```",
      "```js",
      "console.log(1);",
      "```",
      "完毕。",
    ].join("\n");
    const stripped = stripToolBlocks(text);
    expect(stripped).toContain("结论如下：");
    expect(stripped).toContain("console.log(1);");
    expect(stripped).toContain("完毕。");
    expect(stripped).not.toContain("readFile");
    expect(stripped).not.toContain("```tool");
  });
});

describe("runAgentLoop", () => {
  it("无工具调用 = 一步最终答复", async () => {
    const { callModel, receivedMessages } = scriptedCallModel(["最终总结"]);
    const events: AgentLoopEvent[] = [];
    const outcome = await runAgentLoop([{ role: "user", content: "任务" }], {
      callModel,
      executeTool: vi.fn(),
      onEvent: (e) => events.push(e),
    });

    expect(outcome.reason).toBe("final");
    expect(outcome.finalText).toBe("最终总结");
    expect(outcome.steps).toBe(1);
    expect(callModel).toHaveBeenCalledTimes(1);
    // 事件序列：step-start → step-text → done
    expect(events.map((e) => e.type)).toEqual(["step-start", "step-text", "done"]);
    expect(receivedMessages[0]).toEqual([{ role: "user", content: "任务" }]);
  });

  it("工具轮次：执行 → 回执 → 继续思考 → final", async () => {
    const { callModel, receivedMessages } = scriptedCallModel([
      '我先看看有什么文件。\n```tool\n{"tool":"listFiles","args":{}}\n```',
      "发现问题，修复完成。",
    ]);
    const executed: ToolCall[] = [];
    const events: AgentLoopEvent[] = [];
    const outcome = await runAgentLoop([{ role: "user", content: "审计项目" }], {
      callModel,
      executeTool: vi.fn(async (call: ToolCall) => {
        executed.push(call);
        return okResult(call, { files: ["src/a.ts"], total: 1 });
      }),
      onEvent: (e) => events.push(e),
    });

    // 第二轮收到的消息：原始指令 + assistant 原文 + 工具回执
    expect(callModel).toHaveBeenCalledTimes(2);
    const secondRound = receivedMessages[1];
    expect(secondRound[0]).toEqual({ role: "user", content: "审计项目" });
    expect(secondRound[1].role).toBe("assistant");
    expect(secondRound[1].content).toContain("```tool");
    expect(secondRound[2].role).toBe("user");
    expect(secondRound[2].content).toContain("listFiles → 成功");
    expect(secondRound[2].content).toContain("最终总结");

    // 工具调用带稳定 id；事件含 call/result
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ id: "c1-1", name: "listFiles" });
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "step-start",
      "step-text",
      "tool-call",
      "tool-result",
      "step-start",
      "step-text",
      "done",
    ]);
    const callEvent = events.find((e) => e.type === "tool-call") as Extract<
      AgentLoopEvent,
      { type: "tool-call" }
    >;
    expect(callEvent.step).toBe(1);
    expect(outcome).toMatchObject({ reason: "final", finalText: "发现问题，修复完成。", steps: 2 });
  });

  it("连续步数时回执消息逐轮累积", async () => {
    const { callModel, receivedMessages } = scriptedCallModel([
      'step1\n```tool\n{"tool":"listFiles","args":{}}\n```',
      'step2\n```tool\n{"tool":"readFile","args":{"path":"a"}}\n```',
      "done",
    ]);
    await runAgentLoop([{ role: "user", content: "任务" }], {
      callModel,
      executeTool: vi.fn(async (call) => okResult(call)),
      onEvent: () => {},
    });

    // 第三轮：user(指令) + assistant×2 + user(回执1) + assistant? 顺序检查长度
    const third = receivedMessages[2];
    expect(third).toHaveLength(5);
    expect(third.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(third[2].content).toContain("listFiles → 成功");
    expect(third[4].content).toContain("readFile → 成功");
  });

  it("达到 maxSteps 上限时停止并报告", async () => {
    // 每轮都返回工具调用块 → 永不 final，触发步数上限
    const alwaysTool = '```tool\n{"tool":"listFiles","args":{}}\n```';
    const { callModel } = scriptedCallModel([alwaysTool, alwaysTool]);
    const events: AgentLoopEvent[] = [];
    const outcome = await runAgentLoop([{ role: "user", content: "死循环任务" }], {
      callModel: callModel as unknown as (
        m: AgentLoopMessage[],
        d: (raw: string) => void,
        s?: AbortSignal,
      ) => Promise<string>,
      executeTool: vi.fn(async (call) => okResult(call)),
      onEvent: (e) => events.push(e),
      maxSteps: 2,
    });

    expect(callModel).toHaveBeenCalledTimes(2);
    expect(outcome.reason).toBe("max-steps");
    expect(outcome.steps).toBe(2);
    expect(events[events.length - 1]).toMatchObject({ type: "done", reason: "max-steps" });
  });

  it("callModel 抛错 → error 事件 + done(error)，循环不抛异常", async () => {
    const events: AgentLoopEvent[] = [];
    const outcome = await runAgentLoop([{ role: "user", content: "任务" }], {
      callModel: vi.fn(async () => {
        throw new Error("模型服务不可用");
      }),
      executeTool: vi.fn(),
      onEvent: (e) => events.push(e),
    });

    expect(outcome.reason).toBe("error");
    expect(outcome.finalText).toBe("");
    expect(events.some((e) => e.type === "error" && e.message.includes("模型服务不可用"))).toBe(
      true,
    );
    expect(events[events.length - 1]).toMatchObject({ type: "done", reason: "error" });
  });

  it("已中止的 signal：不发请求直接结束", async () => {
    const controller = new AbortController();
    controller.abort();
    const callModel = vi.fn();
    const events: AgentLoopEvent[] = [];
    const outcome = await runAgentLoop([{ role: "user", content: "任务" }], {
      callModel: callModel as unknown as (
        m: AgentLoopMessage[],
        d: (raw: string) => void,
        s?: AbortSignal,
      ) => Promise<string>,
      executeTool: vi.fn(),
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    expect(callModel).not.toHaveBeenCalled();
    expect(outcome.reason).toBe("aborted");
  });

  it("工具执行器抛异常时收敛为失败回执，循环继续", async () => {
    const { callModel, receivedMessages } = scriptedCallModel([
      '```tool\n{"tool":"writeFile","args":{"path":"a","content":"x"}}\n```',
      "结束",
    ]);
    const events: AgentLoopEvent[] = [];
    const outcome = await runAgentLoop([{ role: "user", content: "任务" }], {
      callModel,
      executeTool: vi.fn(async () => {
        throw new Error("宿主崩溃");
      }),
      onEvent: (e) => events.push(e),
    });

    expect(outcome.reason).toBe("final");
    const receipt = receivedMessages[1][2].content;
    expect(receipt).toContain("writeFile → 失败");
    expect(receipt).toContain("宿主崩溃");
    const resultEvent = events.find((e) => e.type === "tool-result") as Extract<
      AgentLoopEvent,
      { type: "tool-result" }
    >;
    expect(resultEvent.result.ok).toBe(false);
  });

  it("默认最大步数为 8", () => {
    expect(DEFAULT_MAX_AGENT_STEPS).toBe(8);
  });
});

describe("formatToolReceipts", () => {
  it("拼接成功与失败回执并带引导语", () => {
    const ok: ToolResult = {
      callId: "c1",
      name: "listFiles",
      ok: true,
      data: { files: ["a.ts"], total: 1 },
      duration: 3,
    };
    const bad: ToolResult = {
      callId: "c2",
      name: "readFile",
      ok: false,
      error: "文件不存在",
      duration: 1,
    };
    const text = formatToolReceipts([ok, bad]);
    expect(text).toContain("以下是本轮工具调用的执行结果");
    expect(text).toContain("[回执 1/2] listFiles → 成功");
    expect(text).toContain("[回执 2/2] readFile → 失败");
    expect(text).toContain("文件不存在");
    expect(text).toContain("直接输出面向用户的最终总结");
  });
});

describe("compactToolResultForUI", () => {
  it("readFile 超长内容被裁剪并标记 truncated", () => {
    const result: ToolResult = {
      callId: "c1",
      name: "readFile",
      ok: true,
      data: { path: "a.ts", content: "x".repeat(2000), lineCount: 100 },
      duration: 3,
    };
    const compact = compactToolResultForUI(result);
    const data = compact.data as { content: string; truncated?: boolean };
    expect(data.content.length).toBeLessThan(900);
    expect(data.truncated).toBe(true);
    // 原结果不被修改
    expect((result.data as { content: string }).content).toHaveLength(2000);
  });

  it("listFiles 与 runAnalysis 的明细列表被裁剪", () => {
    const list: ToolResult = {
      callId: "c1",
      name: "listFiles",
      ok: true,
      data: { files: Array.from({ length: 80 }, (_, i) => `f${i}.ts`), total: 80 },
      duration: 3,
    };
    const listCompact = compactToolResultForUI(list);
    expect((listCompact.data as { files: string[] }).files).toHaveLength(50);

    const analysis: ToolResult = {
      callId: "c2",
      name: "runAnalysis",
      ok: true,
      data: {
        totalFiles: 80,
        totalIssues: 80,
        highSeverity: 0,
        files: Array.from({ length: 30 }, (_, i) => ({
          path: `f${i}.ts`,
          issueCount: 2,
          highSeverity: 0,
        })),
      },
      duration: 3,
    };
    const analysisCompact = compactToolResultForUI(analysis);
    expect(
      (analysisCompact.data as { files: unknown[] }).files,
    ).toHaveLength(20);
  });

  it("失败结果与小数据原样返回", () => {
    const bad: ToolResult = {
      callId: "c1",
      name: "readFile",
      ok: false,
      error: "文件不存在",
      duration: 1,
    };
    expect(compactToolResultForUI(bad)).toBe(bad);
  });
});

describe("buildAgentSystemPrompt", () => {
  it("包含全部工具、调用格式与工作流程要求", () => {
    const prompt = buildAgentSystemPrompt();
    for (const name of [
      "readFile",
      "writeFile",
      "listFiles",
      "runAnalysis",
      "applyAutoFix",
      "createSnapshot",
    ]) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain("```tool");
    expect(prompt).toContain('{"tool":"readFile"');
    expect(prompt).toContain("最终总结");
  });
});
