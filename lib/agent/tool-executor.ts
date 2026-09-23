/**
 * Agent 工具执行器（Day 19）
 *
 * 职责：
 * 1. validateToolArgs —— 按工具目录的参数 schema 校验入参（纯函数，可独立测试）。
 * 2. createToolExecutor —— 校验 → 调用注入的 AgentToolContext → 统一包装为
 *    ToolResult；任何宿主异常收敛为 ok=false 的可读错误，绝不向上抛。
 * 3. formatToolResultForModel —— 把 ToolResult 序列化为模型可读文本
 *    （长内容截断），Day 20 思考-执行循环把它作为 tool 回执拼进对话。
 * 4. collectAnalysisTasks —— 分批读取文件内容构建分析任务（大项目不让
 *    IndexedDB 一次性全量请求卡住主线程）。
 */

import type { FileAnalysisTask } from "@/lib/ast/batch-types";
import type { IssueFix } from "@/lib/ast/fixer";
import type {
  ToolAnalysisSummary,
  ToolArgsByName,
  ToolCall,
  ToolName,
  ToolResult,
} from "./tool-types";
import { TOOL_DEFINITIONS } from "./tool-definitions";

// ---------------------------------------------------------------------------
// 参数校验（纯函数）
// ---------------------------------------------------------------------------

export type ValidateArgsResult<S> = { ok: true; value: S } | { ok: false; error: string };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => isNonEmptyString(x));
}

const VALIDATORS: Record<ToolName, (args: Record<string, unknown>) => ValidateArgsResult<unknown>> = {
  readFile: (args) => {
    if (!isNonEmptyString(args.path)) return { ok: false, error: "参数 path 必须是非空字符串" };
    return { ok: true, value: { path: args.path } };
  },
  writeFile: (args) => {
    if (!isNonEmptyString(args.path)) return { ok: false, error: "参数 path 必须是非空字符串" };
    if (typeof args.content !== "string")
      return { ok: false, error: "参数 content 必须是字符串（完整文件内容）" };
    return { ok: true, value: { path: args.path, content: args.content } };
  },
  listFiles: (args) => {
    if (args.prefix !== undefined && !isNonEmptyString(args.prefix))
      return { ok: false, error: "参数 prefix 必须是非空字符串" };
    return { ok: true, value: { prefix: args.prefix } };
  },
  runAnalysis: (args) => {
    if (args.paths !== undefined && !isStringArray(args.paths))
      return { ok: false, error: "参数 paths 必须是非空字符串数组" };
    return { ok: true, value: { paths: args.paths } };
  },
  applyAutoFix: (args) => {
    if (!isNonEmptyString(args.path)) return { ok: false, error: "参数 path 必须是非空字符串" };
    return { ok: true, value: { path: args.path } };
  },
  createSnapshot: (args) => {
    if (!isNonEmptyString(args.name)) return { ok: false, error: "参数 name 必须是非空字符串" };
    if (args.description !== undefined && typeof args.description !== "string")
      return { ok: false, error: "参数 description 必须是字符串" };
    return { ok: true, value: { name: args.name, description: args.description } };
  },
};

/** 按工具目录校验调用参数；通过后返回该工具的强类型入参 */
export function validateToolArgs<S extends ToolName>(
  name: S,
  args: unknown,
): ValidateArgsResult<ToolArgsByName[S]> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "参数必须是对象" };
  }
  const validator = VALIDATORS[name];
  if (!validator) return { ok: false, error: `未知工具：${name}` };
  const result = validator(args as Record<string, unknown>);
  return result as ValidateArgsResult<ToolArgsByName[S]>;
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

/**
 * 宿主能力接口。由桥接层（hooks/useAgentTools）基于 useProject /
 * useBatchAnalysis 实现；执行器只面向此接口，保持可测试。
 */
export interface AgentToolContext {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<unknown>;
  /** 列出项目全部文件路径（不含目录） */
  listFiles(): Promise<string[]>;
  /** 运行 AST 分析；paths 为空 = 全部可分析文件 */
  runAnalysis(paths?: string[]): Promise<ToolAnalysisSummary>;
  /** 取某文件的修复提案（来自最近一次分析结果；无缓存时宿主可现场分析兜底） */
  getFixableFixes(path: string): Promise<IssueFix[]>;
  /** 应用修复提案并落地（写盘 + 快照 + 刷新分析）；返回应用/跳过计数 */
  applyAutoFixes(
    path: string,
    fixes: IssueFix[],
  ): Promise<{ changed: boolean; applied: number; skipped: number }>;
  createSnapshot(name: string, description?: string): Promise<{ id: string; name: string }>;
}

export type ToolExecutor = (call: ToolCall) => Promise<ToolResult>;

function fail(call: ToolCall, error: string, duration: number): ToolResult {
  return { callId: call.id, name: call.name, ok: false, error, duration };
}

/**
 * 创建工具执行器。
 * 执行器对调用方承诺：永远 resolve，不 reject；所有失败都以 ok=false 表达。
 */
export function createToolExecutor(ctx: AgentToolContext): ToolExecutor {
  return async (call: ToolCall): Promise<ToolResult> => {
    const start = performance.now();
    const duration = () => performance.now() - start;

    if (!TOOL_DEFINITIONS[call.name]) {
      return fail(call, `未知工具：${call.name}`, duration());
    }

    const validated = validateToolArgs(call.name, call.args);
    if (!validated.ok) {
      return fail(call, validated.error, duration());
    }

    try {
      switch (call.name) {
        case "readFile": {
          const { path } = validated.value as ToolArgsByName["readFile"];
          const content = await ctx.readFile(path);
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: { path, content, lineCount: content.split("\n").length },
            duration: duration(),
          };
        }
        case "writeFile": {
          const { path, content } = validated.value as ToolArgsByName["writeFile"];
          await ctx.writeFile(path, content);
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: { path, charCount: content.length, lineCount: content.split("\n").length },
            duration: duration(),
          };
        }
        case "listFiles": {
          const { prefix } = validated.value as ToolArgsByName["listFiles"];
          const all = await ctx.listFiles();
          const files = prefix ? all.filter((p) => p.startsWith(prefix)) : all;
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: { files, total: all.length },
            duration: duration(),
          };
        }
        case "runAnalysis": {
          const { paths } = validated.value as ToolArgsByName["runAnalysis"];
          const summary = await ctx.runAnalysis(paths);
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: summary,
            duration: duration(),
          };
        }
        case "applyAutoFix": {
          const { path } = validated.value as ToolArgsByName["applyAutoFix"];
          const fixes = await ctx.getFixableFixes(path);
          const result = await ctx.applyAutoFixes(path, fixes);
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: {
              path,
              fixable: fixes.length,
              ...result,
              message:
                fixes.length === 0
                  ? "没有可自动修复的问题（可能尚未分析，或问题均无修复提案）"
                  : `应用 ${result.applied} 处，跳过 ${result.skipped} 处`,
            },
            duration: duration(),
          };
        }
        case "createSnapshot": {
          const { name, description } = validated.value as ToolArgsByName["createSnapshot"];
          const snapshot = await ctx.createSnapshot(name, description);
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: snapshot,
            duration: duration(),
          };
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(call, message, duration());
    }
  };
}

// ---------------------------------------------------------------------------
// 结果序列化（给模型看的文本回执）
// ---------------------------------------------------------------------------

/** readFile 回执中文件内容的最大字符数（超出截断，避免撑爆上下文） */
const MAX_CONTENT_CHARS = 4000;
/** listFiles 回执中文件路径的最大条数 */
const MAX_LIST_ENTRIES = 200;
/** runAnalysis 回执中问题文件明细的最大条数 */
const MAX_ISSUE_FILES = 20;

function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}

/** 把 ToolResult 序列化为可读文本（Day 20 循环中作为工具回执传给模型） */
export function formatToolResultForModel(result: ToolResult): string {
  if (!result.ok) return `工具 ${result.name} 执行失败：${result.error ?? "未知错误"}`;

  const data = result.data as Record<string, unknown> | undefined;
  if (!data) return `工具 ${result.name} 执行完成。`;

  switch (result.name) {
    case "readFile": {
      const { text, truncated } = truncateText(String(data.content ?? ""), MAX_CONTENT_CHARS);
      const head = `文件 ${data.path}（${data.lineCount} 行）内容如下${truncated ? "（已截断）" : ""}：`;
      return `${head}\n\`\`\`\n${text}\n\`\`\``;
    }
    case "writeFile":
      return `已写入 ${data.path}（${data.charCount} 字符 / ${data.lineCount} 行），写前已自动生成快照。`;
    case "listFiles": {
      const files = (data.files as string[]) ?? [];
      const shown = files.slice(0, MAX_LIST_ENTRIES);
      const suffix =
        files.length > shown.length ? `\n…（其余 ${files.length - shown.length} 个文件已省略）` : "";
      return `项目共 ${data.total} 个文件，命中 ${files.length} 个：\n${shown.join("\n")}${suffix}`;
    }
    case "runAnalysis": {
      const s = data as unknown as ToolAnalysisSummary;
      const head = `分析完成：${s.totalFiles} 个文件，共 ${s.totalIssues} 个问题（高危 ${s.highSeverity} 个）。`;
      if (s.files.length === 0) return `${head}\n没有发现任何问题。`;
      const shown = s.files.slice(0, MAX_ISSUE_FILES);
      const lines = shown.map(
        (f) => `- ${f.path}：${f.issueCount} 个问题${f.highSeverity > 0 ? `（高危 ${f.highSeverity}）` : ""}`,
      );
      const suffix =
        s.files.length > shown.length ? `\n…（其余 ${s.files.length - shown.length} 个文件已省略）` : "";
      return `${head}\n${lines.join("\n")}${suffix}`;
    }
    case "applyAutoFix":
      return String(data.message ?? "修复完成。");
    case "createSnapshot":
      return `已创建项目快照「${data.name}」（id: ${data.id}）。`;
    default:
      return `工具 ${result.name} 执行完成。`;
  }
}

// ---------------------------------------------------------------------------
// 分析任务收集（分批读取）
// ---------------------------------------------------------------------------

/**
 * 按批读取文件内容构建分析任务：每批并发读取 batchSize 个，批间让出主线程。
 * 读取失败的文件静默跳过（如文件被并发删除）。
 */
export async function collectAnalysisTasks(
  paths: string[],
  read: (path: string) => Promise<string>,
  batchSize = 30,
): Promise<FileAnalysisTask[]> {
  const tasks: FileAnalysisTask[] = [];
  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (path) => {
        try {
          return { path, content: await read(path) };
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) tasks.push(r);
    }
    if (i + batchSize < paths.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return tasks;
}
