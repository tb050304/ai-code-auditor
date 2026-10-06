/**
 * 第三阶段联调测试（Day 21）：Agent 思考-执行循环 × 真实工具执行器 × 真实 AST 分析/修复。
 *
 * 与 agent-loop.test.ts / agent-tools.test.ts 的分工：
 * - agent-loop.test.ts   ：循环器用 mock 工具执行，验证协议与事件流；
 * - agent-tools.test.ts  ：执行器用假宿主，验证校验/包装/序列化；
 * - 本文件              ：端到端剧本 —— 内存 VFS 宿主 + createToolExecutor
 *   （真实校验与包装）+ analyzeFileContent/applyFixes（真实 AST 分析与修复），
 *   驱动 runAgentLoop 走「分析 → 修复 → 验证 → 总结」完整链路，
 *   验证阶段产物组合在一起能完成真实任务。
 */

import { describe, it, expect } from "vitest";
import { runAgentLoop, type AgentLoopMessage, type AgentStep } from "@/lib/agent/loop";
import { createToolExecutor, type AgentToolContext } from "@/lib/agent/tool-executor";
import { analyzeFileContent, isAnalyzableFile } from "@/lib/ast/batch-types";
import { applyFixes, isFixable, type IssueFix } from "@/lib/ast/fixer";
import { rewriteImportsForMove } from "@/lib/refactor";
import { normalizePath } from "@/lib/storage/path";
import type { ToolAnalysisSummary } from "@/lib/agent/tool-types";

// ---------------------------------------------------------------------------
// 内存项目宿主：模拟 useAgentTools 桥接层背后的 useProject + useBatchAnalysis
// ---------------------------------------------------------------------------

interface MemoryProject {
  files: Map<string, string>;
  snapshots: Array<{ id: string; name: string; content: Map<string, string> }>;
}

/** 基于内存文件表构建 AgentToolContext（runAnalysis/applyAutoFix 走真实 AST 管线） */
function makeMemoryContext(project: MemoryProject): AgentToolContext {
  // 最近一次分析结果缓存（模拟 useBatchAnalysis 的 fileResults）
  const analysisCache = new Map<string, ReturnType<typeof analyzeFileContent>>();

  const runOne = (path: string) => {
    const content = project.files.get(path);
    if (content === undefined) throw new Error(`文件不存在：${path}`);
    return analyzeFileContent(path, content);
  };

  return {
    readFile: async (path) => {
      const content = project.files.get(path);
      if (content === undefined) throw new Error(`文件不存在：${path}`);
      return content;
    },
    writeFile: async (path, content) => {
      project.files.set(path, content);
    },
    listFiles: async () => [...project.files.keys()].sort(),
    runAnalysis: async (paths) => {
      const targets = (paths ?? [...project.files.keys()]).filter(isAnalyzableFile);
      const files: ToolAnalysisSummary["files"] = [];
      let totalIssues = 0;
      let highSeverity = 0;
      for (const path of targets) {
        const result = runOne(path);
        analysisCache.set(path, result);
        totalIssues += result.issues.length;
        const high = result.issues.filter((i) => i.severity === "error").length;
        highSeverity += high;
        if (result.issues.length > 0) {
          files.push({ path, issueCount: result.issues.length, highSeverity: high });
        }
      }
      files.sort((a, b) => b.issueCount - a.issueCount);
      return { totalFiles: targets.length, totalIssues, highSeverity, files };
    },
    getFixableFixes: async (path) => {
      const cached = analysisCache.get(path) ?? runOne(path);
      return cached.issues.filter(isFixable).map((i) => i.fix as IssueFix);
    },
    applyAutoFixes: async (path, fixes) => {
      const content = project.files.get(path);
      if (content === undefined) throw new Error(`文件不存在：${path}`);
      const result = applyFixes(content, fixes);
      const changed = result.applied.length > 0 && result.code !== content;
      if (changed) {
        project.files.set(path, result.code);
        // 修复后原地刷新分析缓存（对应 reanalyzeFile）
        analysisCache.set(path, analyzeFileContent(path, result.code));
      }
      return {
        changed,
        applied: result.applied.length,
        skipped: result.skipped.length,
      };
    },
    createSnapshot: async (name) => {
      const id = `snap-${project.snapshots.length + 1}`;
      project.snapshots.push({ id, name, content: new Map(project.files) });
      return { id, name };
    },
    // Day 24：moveFile 走真实 rewriteImportsForMove（跨文件 import 重写）
    moveFile: async (from, to) => {
      const fromAbs = normalizePath(from);
      const toAbs = normalizePath(to);
      const keys = new Map([...project.files.keys()].map((k) => [normalizePath(k), k]));
      const fromKey = keys.get(fromAbs);
      if (!fromKey) throw new Error(`源文件不存在：${fromAbs}`);
      if (keys.has(toAbs)) throw new Error(`目标路径已存在：${toAbs}`);
      // 先打项目快照（对应桥接层 createProjectSnapshot）
      project.snapshots.push({
        id: `snap-${project.snapshots.length + 1}`,
        name: "moveFile 前自动快照",
        content: new Map(project.files),
      });
      const contents = new Map([...project.files.entries()].map(([k, v]) => [normalizePath(k), v]));
      const { changes, movedContent } = rewriteImportsForMove(contents, fromAbs, toAbs);
      project.files.set(toAbs, movedContent);
      for (const [p, c] of changes) project.files.set(p, c);
      project.files.delete(fromKey);
      return { moved: toAbs, updatedImporters: [...changes.keys()] };
    },
    deleteFile: async (path) => {
      const abs = normalizePath(path);
      const key = [...project.files.keys()].find((k) => normalizePath(k) === abs);
      if (!key) throw new Error(`文件不存在：${abs}`);
      project.snapshots.push({
        id: `snap-${project.snapshots.length + 1}`,
        name: "deleteFile 前自动快照",
        content: new Map(project.files),
      });
      project.files.delete(key);
    },
  };
}

/** 剧本模型：按轮次返回预设文本，同时记录每轮收到的消息 */
function scriptedModel(responses: string[]) {
  const receivedMessages: AgentLoopMessage[][] = [];
  let round = 0;
  return {
    receivedMessages,
    async callModel(messages: AgentLoopMessage[]): Promise<string> {
      receivedMessages.push(messages.map((m) => ({ ...m })));
      return responses[round++] ?? "（剧本耗尽）";
    },
  };
}

/** 事件 → AgentStep 归约（与 useAgentLoop 的 handleEvent 同一映射逻辑） */
function reduceSteps(events: import("@/lib/agent/loop").AgentLoopEvent[]): AgentStep[] {
  const steps: AgentStep[] = [];
  for (const e of events) {
    if (e.type === "step-start") {
      steps.push({ id: `s${e.step}`, index: e.step, text: "", calls: [], status: "running" });
    } else if (e.type === "step-text") {
      const s = steps.find((x) => x.index === e.step);
      if (s) s.text = e.text;
    } else if (e.type === "tool-call") {
      steps.find((x) => x.index === e.step)?.calls.push({ call: e.call, result: null });
    } else if (e.type === "tool-result") {
      const s = steps.find((x) => x.index === e.step);
      const c = s?.calls.find((x) => x.call.id === e.result.callId);
      if (c) c.result = e.result;
    } else if (e.type === "done") {
      for (const s of steps) if (s.status === "running") s.status = "done";
    }
  }
  return steps;
}

const DIRTY_CODE = [
  "var count = 1",
  "debugger;",
  "console.log(count);",
  'if (count == "1") { count = count + 1; }',
  "export default count;",
].join("\n");

describe("Agent 端到端联调（阶段三）", () => {
  it("完整剧本：分析 → 快照 → 修复 → 验证 → 最终总结", async () => {
    const project: MemoryProject = {
      files: new Map([["src/index.ts", DIRTY_CODE]]),
      snapshots: [],
    };
    const executor = createToolExecutor(makeMemoryContext(project));
    const model = scriptedModel([
      // 第 1 轮：先分析
      '先运行分析看看项目状况。\n```tool\n{"tool":"runAnalysis","args":{}}\n```',
      // 第 2 轮：打快照 + 修复
      [
        "发现问题，先打快照再修复。",
        "```tool",
        '{"tool":"createSnapshot","args":{"name":"修复前"}}',
        "```",
        "```tool",
        '{"tool":"applyAutoFix","args":{"path":"src/index.ts"}}',
        "```",
      ].join("\n"),
      // 第 3 轮：验证
      '修复完成，重新分析验证。\n```tool\n{"tool":"runAnalysis","args":{"paths":["src/index.ts"]}}\n```',
      // 第 4 轮：最终总结（无工具调用 → final）
      "修复完成：移除了 debugger 与 console.log，var 已改为 let，剩余问题需人工确认。",
    ]);

    const events: import("@/lib/agent/loop").AgentLoopEvent[] = [];
    const outcome = await runAgentLoop(
      [{ role: "user", content: "审计并修复 src/index.ts 的可自动修复问题" }],
      { callModel: model.callModel, executeTool: executor, onEvent: (e) => events.push(e) },
    );

    // 循环结果
    expect(outcome.reason).toBe("final");
    expect(outcome.steps).toBe(4);
    expect(outcome.finalText).toContain("修复完成");

    // 真实副作用：文件被修复、快照已建立
    const after = project.files.get("src/index.ts") ?? "";
    expect(after).toContain("let count");
    expect(after).not.toContain("var count");
    expect(after).not.toContain("debugger");
    expect(after).not.toContain("console.log(count)");
    expect(project.snapshots).toHaveLength(1);
    expect(project.snapshots[0].name).toBe("修复前");
    // 快照内容是修复前的原文（安全点）
    expect(project.snapshots[0].content.get("src/index.ts")).toBe(DIRTY_CODE);

    // 对话历史：4 轮模型调用，回执逐轮累积且携带真实执行摘要
    expect(model.receivedMessages).toHaveLength(4);
    const round2 = model.receivedMessages[1];
    expect(round2[2].content).toContain("runAnalysis → 成功");
    expect(round2[2].content).toContain("个问题");
    const round3 = model.receivedMessages[2];
    expect(round3[4].content).toContain("createSnapshot → 成功");
    expect(round3[4].content).toContain("applyAutoFix → 成功");
    const round4 = model.receivedMessages[3];
    expect(round4[6].content).toContain("runAnalysis → 成功");

    // 步骤面板数据：4 步，工具调用与结果一一对应
    const steps = reduceSteps(events);
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.status === "done")).toBe(true);
    expect(steps[0].calls.map((c) => c.call.name)).toEqual(["runAnalysis"]);
    expect(steps[1].calls.map((c) => c.call.name)).toEqual(["createSnapshot", "applyAutoFix"]);
    expect(steps[2].calls.map((c) => c.call.name)).toEqual(["runAnalysis"]);
    expect(steps[3].calls).toHaveLength(0);
    for (const s of steps) {
      for (const c of s.calls) {
        expect(c.result).not.toBeNull();
        expect(c.result?.ok).toBe(true);
      }
    }
    // 验证轮：修复后问题数应下降（回执中体现）
    const verifyReceipt = model.receivedMessages[3][6].content;
    expect(verifyReceipt).toContain("分析完成");
  });

  it("真实管线：applyFixes 后代码语法仍合法（可被 Babel 再次解析）", async () => {
    const project: MemoryProject = {
      files: new Map([["src/a.ts", DIRTY_CODE]]),
      snapshots: [],
    };
    const ctx = makeMemoryContext(project);
    const executor = createToolExecutor(ctx);

    const analysis = await executor({ id: "c1", name: "runAnalysis", args: {} });
    expect(analysis.ok).toBe(true);
    expect((analysis.data as ToolAnalysisSummary).totalIssues).toBeGreaterThan(0);

    const fix = await executor({ id: "c2", name: "applyAutoFix", args: { path: "src/a.ts" } });
    expect(fix.ok).toBe(true);
    const fixData = fix.data as { applied: number; skipped: number; changed: boolean };
    expect(fixData.changed).toBe(true);
    expect(fixData.applied).toBeGreaterThan(0);

    // 修复后的代码能被 analyzeFileContent 再次解析（语法合法 = 不留坏代码）
    const after = project.files.get("src/a.ts") ?? "";
    const reanalyzed = analyzeFileContent("src/a.ts", after);
    // no-debugger 规则的 issue id 为 "no-debugger"
    expect(reanalyzed.issues.filter((i) => i.id === "no-debugger")).toHaveLength(0);
  });

  it("模型读到不存在的文件：回执 ok=false，模型可改用真实路径继续", async () => {
    const project: MemoryProject = {
      files: new Map([["src/real.ts", "export const a = 1;\n"]]),
      snapshots: [],
    };
    const executor = createToolExecutor(makeMemoryContext(project));
    const model = scriptedModel([
      // 第 1 轮：读了一个不存在的路径
      '读取目标文件。\n```tool\n{"tool":"readFile","args":{"path":"src/ghost.ts"}}\n```',
      // 第 2 轮：根据失败回执改读真实文件
      '路径不对，改读真实文件。\n```tool\n{"tool":"readFile","args":{"path":"src/real.ts"}}\n```',
      "已读取文件内容，任务完成。",
    ]);

    const outcome = await runAgentLoop([{ role: "user", content: "读取入口文件" }], {
      callModel: model.callModel,
      executeTool: executor,
      onEvent: () => {},
    });

    expect(outcome.reason).toBe("final");
    expect(outcome.steps).toBe(3);
    // 第 2 轮收到的回执：readFile 失败 + 错误原因（模型据此纠正）
    const failReceipt = model.receivedMessages[1][2].content;
    expect(failReceipt).toContain("readFile → 失败");
    expect(failReceipt).toContain("文件不存在");
    // 第 3 轮消息序列：[user指令, assistant(读ghost), user(回执1), assistant(读real), user(回执2)]
    // → 成功回执在索引 4
    const okReceipt = model.receivedMessages[2][4].content;
    expect(okReceipt).toContain("readFile → 成功");
    expect(okReceipt).toContain("export const a = 1;");
  });

  it("空项目：listFiles 返回空、runAnalysis 零问题，循环正常收尾", async () => {
    const project: MemoryProject = { files: new Map(), snapshots: [] };
    const executor = createToolExecutor(makeMemoryContext(project));
    const model = scriptedModel([
      '```tool\n{"tool":"listFiles","args":{}}\n```',
      '```tool\n{"tool":"runAnalysis","args":{}}\n```',
      "项目为空，请先导入项目文件。",
    ]);

    const outcome = await runAgentLoop([{ role: "user", content: "审计项目" }], {
      callModel: model.callModel,
      executeTool: executor,
      onEvent: () => {},
    });

    expect(outcome.reason).toBe("final");
    expect(outcome.finalText).toContain("项目为空");
    const analysisReceipt = model.receivedMessages[2][4].content;
    expect(analysisReceipt).toContain("没有发现任何问题");
  });

  it("非法工具调用（缺参数/未知工具）不会中断循环", async () => {
    const project: MemoryProject = {
      files: new Map([["a.ts", "let x = 1;\n"]]),
      snapshots: [],
    };
    const executor = createToolExecutor(makeMemoryContext(project));
    const model = scriptedModel([
      // 第 1 轮：一个缺参数 + 一个未知工具
      [
        "```tool",
        '{"tool":"readFile","args":{}}',
        "```",
        "```tool",
        '{"tool":"deleteEverything","args":{}}',
        "```",
      ].join("\n"),
      "参数有误，改用正确调用。",
    ]);

    const outcome = await runAgentLoop([{ role: "user", content: "任务" }], {
      callModel: model.callModel,
      executeTool: executor,
      onEvent: () => {},
    });

    expect(outcome.reason).toBe("final");
    const receipt = model.receivedMessages[1][2].content;
    expect(receipt).toContain("readFile → 失败");
    expect(receipt).toContain("path");
    expect(receipt).toContain("未知工具");
    // 文件未被破坏
    expect(project.files.get("a.ts")).toBe("let x = 1;\n");
  });
});

// ---------------------------------------------------------------------------
// Day 24：项目级 Agent（跨文件搜索与重构）
// ---------------------------------------------------------------------------

describe("Agent 项目级能力（Day 24）", () => {
  const PROJECT_FILES: Array<[string, string]> = [
    ["/src/utils.ts", "export const u = 1;\n"],
    ["/src/a.ts", 'import { u } from "./utils";\nexport const a = u + 1;\n'],
    ["/src/lib/b.ts", 'import { u } from "../utils";\nexport const b = u + 2;\n'],
  ];

  it("searchCode 定位引用 → moveFile 移动并自动重写 import → 验证无残留", async () => {
    const project: MemoryProject = { files: new Map(PROJECT_FILES), snapshots: [] };
    const executor = createToolExecutor(makeMemoryContext(project));
    const model = scriptedModel([
      // 第 1 轮：搜索谁引用了 utils
      '先找谁在用 utils。\n```tool\n{"tool":"searchCode","args":{"pattern":"utils"}}\n```',
      // 第 2 轮：移动到 lib 下
      '把 utils 移到 lib 目录。\n```tool\n{"tool":"moveFile","args":{"from":"/src/utils.ts","to":"/src/lib/utils.ts"}}\n```',
      // 第 3 轮：搜索旧路径残留
      '确认没有残留旧引用。\n```tool\n{"tool":"searchCode","args":{"pattern":"\\"./utils\\"|\\"../utils\\"","regex":true}}\n```',
      "已把 utils.ts 移入 lib 目录，a.ts 与 b.ts 的 import 已自动更新，无旧路径残留。",
    ]);

    const outcome = await runAgentLoop([{ role: "user", content: "把 src/utils.ts 移到 src/lib/ 下" }], {
      callModel: model.callModel,
      executeTool: executor,
      onEvent: () => {},
    });

    expect(outcome.reason).toBe("final");
    // 真实副作用：旧文件消失、新文件存在、两个引用方被改写
    expect(project.files.has("/src/utils.ts")).toBe(false);
    expect(project.files.get("/src/lib/utils.ts")).toBe("export const u = 1;\n");
    expect(project.files.get("/src/a.ts")).toContain('from "./lib/utils"');
    expect(project.files.get("/src/lib/b.ts")).toContain('from "./utils"');
    // moveFile 前自动打了项目快照（安全点）
    expect(project.snapshots.some((s) => s.name.includes("moveFile"))).toBe(true);
    // 快照里保存的是移动前的完整状态
    const snap = project.snapshots.find((s) => s.name.includes("moveFile"));
    expect(snap?.content.get("/src/utils.ts")).toBe("export const u = 1;\n");
    // 第 2 轮回执：报告了被更新的引用方
    const moveReceipt = model.receivedMessages[2][4].content;
    expect(moveReceipt).toContain("moveFile → 成功");
    expect(moveReceipt).toContain("自动更新了 2 个引用文件");
  });

  it("readFiles 批量读取 + searchFiles 通配符定位", async () => {
    const project: MemoryProject = { files: new Map(PROJECT_FILES), snapshots: [] };
    const executor = createToolExecutor(makeMemoryContext(project));
    const model = scriptedModel([
      '```tool\n{"tool":"searchFiles","args":{"pattern":"*.ts"}}\n```',
      '```tool\n{"tool":"readFiles","args":{"paths":["/src/a.ts","/src/lib/b.ts"]}}\n```',
      "两个文件都依赖 utils，结构清晰。",
    ]);

    const outcome = await runAgentLoop([{ role: "user", content: "看看项目结构" }], {
      callModel: model.callModel,
      executeTool: executor,
      onEvent: () => {},
    });

    expect(outcome.reason).toBe("final");
    const searchReceipt = model.receivedMessages[1][2].content;
    expect(searchReceipt).toContain("3 个文件匹配");
    const readReceipt = model.receivedMessages[2][4].content;
    expect(readReceipt).toContain("/src/a.ts");
    expect(readReceipt).toContain("/src/lib/b.ts");
    expect(readReceipt).toContain('from "./utils"');
  });

  it("deleteFile 删除后文件消失且留快照；删不存在的文件返回失败", async () => {
    const project: MemoryProject = {
      files: new Map([["/src/dead.ts", "// 废弃\n"], ["/src/alive.ts", "export const x = 1;\n"]]),
      snapshots: [],
    };
    const executor = createToolExecutor(makeMemoryContext(project));
    const model = scriptedModel([
      '```tool\n{"tool":"deleteFile","args":{"path":"/src/dead.ts"}}\n```',
      '```tool\n{"tool":"deleteFile","args":{"path":"/src/ghost.ts"}}\n```',
      "已删除废弃文件；另一个路径不存在，未做任何修改。",
    ]);

    const outcome = await runAgentLoop([{ role: "user", content: "删掉废弃文件" }], {
      callModel: model.callModel,
      executeTool: executor,
      onEvent: () => {},
    });

    expect(outcome.reason).toBe("final");
    expect(project.files.has("/src/dead.ts")).toBe(false);
    expect(project.files.has("/src/alive.ts")).toBe(true);
    expect(project.snapshots.some((s) => s.name.includes("deleteFile"))).toBe(true);
    const failReceipt = model.receivedMessages[2][4].content;
    expect(failReceipt).toContain("deleteFile → 失败");
    expect(failReceipt).toContain("文件不存在");
  });
});
