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
  // ---- Day 24：项目级 Agent ----
  searchCode: (args) => {
    if (!isNonEmptyString(args.pattern)) return { ok: false, error: "参数 pattern 必须是非空字符串" };
    if (args.regex !== undefined && typeof args.regex !== "boolean")
      return { ok: false, error: '参数 regex 必须是布尔值（true/false）' };
    return { ok: true, value: { pattern: args.pattern, regex: args.regex } };
  },
  searchFiles: (args) => {
    if (!isNonEmptyString(args.pattern)) return { ok: false, error: "参数 pattern 必须是非空字符串" };
    return { ok: true, value: { pattern: args.pattern } };
  },
  readFiles: (args) => {
    if (!isStringArray(args.paths)) return { ok: false, error: "参数 paths 必须是非空字符串数组" };
    if (args.paths.length > 20) return { ok: false, error: "一次最多读取 20 个文件，请分批调用" };
    return { ok: true, value: { paths: args.paths } };
  },
  moveFile: (args) => {
    if (!isNonEmptyString(args.from)) return { ok: false, error: "参数 from 必须是非空字符串" };
    if (!isNonEmptyString(args.to)) return { ok: false, error: "参数 to 必须是非空字符串" };
    if (args.from === args.to) return { ok: false, error: "from 与 to 相同，无需移动" };
    return { ok: true, value: { from: args.from, to: args.to } };
  },
  deleteFile: (args) => {
    if (!isNonEmptyString(args.path)) return { ok: false, error: "参数 path 必须是非空字符串" };
    return { ok: true, value: { path: args.path } };
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
  // ---- Day 24：项目级 Agent ----
  /** 移动文件并重写项目内所有对它的 import；返回被改写的引用方文件清单 */
  moveFile(from: string, to: string): Promise<{ moved: string; updatedImporters: string[] }>;
  /** 删除文件（桥接层负责先打项目快照） */
  deleteFile(path: string): Promise<void>;
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
        // ---- Day 24：项目级 Agent ----
        case "searchCode": {
          const { pattern, regex } = validated.value as ToolArgsByName["searchCode"];
          const all = await ctx.listFiles();
          const results = await performSearchCode(all, ctx.readFile, pattern, regex ?? false);
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: results,
            duration: duration(),
          };
        }
        case "searchFiles": {
          const { pattern } = validated.value as ToolArgsByName["searchFiles"];
          const all = await ctx.listFiles();
          const re = globToRegex(pattern);
          const files = all.filter((p) => re.test(p));
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: { pattern, files, total: all.length },
            duration: duration(),
          };
        }
        case "readFiles": {
          const { paths } = validated.value as ToolArgsByName["readFiles"];
          const items = await Promise.all(
            paths.map(async (path) => {
              try {
                const content = await ctx.readFile(path);
                return { path, content, lineCount: content.split("\n").length, ok: true };
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                return { path, content: "", lineCount: 0, ok: false, error: msg };
              }
            }),
          );
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: { items },
            duration: duration(),
          };
        }
        case "moveFile": {
          const { from, to } = validated.value as ToolArgsByName["moveFile"];
          const result = await ctx.moveFile(from, to);
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: result,
            duration: duration(),
          };
        }
        case "deleteFile": {
          const { path } = validated.value as ToolArgsByName["deleteFile"];
          await ctx.deleteFile(path);
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            data: { path },
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
    // ---- Day 24：项目级 Agent ----
    case "searchCode": {
      const results = (data.results as Array<{ path: string; line: number; snippet: string }>) ?? [];
      if (results.length === 0) return `未找到匹配内容：${data.pattern}`;
      const lines = results.slice(0, 10).map((r) => `${r.path}:${r.line}  ${r.snippet}`);
      const suffix = results.length > 10 ? `\n…（共 ${results.length} 条，已省略 ${results.length - 10} 条）` : "";
      return `找到 ${results.length} 处匹配：\n${lines.join("\n")}${suffix}`;
    }
    case "searchFiles": {
      const files = (data.files as string[]) ?? [];
      if (files.length === 0) return `未找到匹配文件：${data.pattern}`;
      const shown = files.slice(0, 50);
      const suffix = files.length > shown.length ? `\n…（其余 ${files.length - shown.length} 个已省略）` : "";
      return `共 ${files.length} 个文件匹配：\n${shown.join("\n")}${suffix}`;
    }
    case "readFiles": {
      const items = (data.items as Array<{ path: string; content: string; lineCount: number; ok: boolean; error?: string }>) ?? [];
      const lines = items.map((it) => {
        if (!it.ok) return `--- ${it.path} 读取失败：${it.error} ---`;
        const { text, truncated } = truncateText(it.content, 800);
        return `--- ${it.path}（${it.lineCount} 行${truncated ? "，已截断" : ""}）---\n${text}`;
      });
      return lines.join("\n\n");
    }
    case "moveFile": {
      const updated = (data.updatedImporters as string[]) ?? [];
      return `已移动 ${data.moved}，自动更新了 ${updated.length} 个引用文件${updated.length ? `：\n${updated.map((p) => `  - ${p}`).join("\n")}` : ""}。`;
    }
    case "deleteFile":
      return `已删除 ${data.path}（删除前已自动生成项目快照，可回退）。`;
    default:
      return `工具 ${result.name} 执行完成。`;
  }
}

// ---------------------------------------------------------------------------
// 思考-执行循环的辅助序列化（Day 20）
// ---------------------------------------------------------------------------

/**
 * 把一轮全部工具回执拼成继续对话的用户消息。
 * 引导语放在末尾，驱动模型"未完成继续调用工具，已完成输出最终总结"。
 */
export function formatToolReceipts(results: ToolResult[]): string {
  const parts = results.map(
    (r, i) =>
      `[回执 ${i + 1}/${results.length}] ${r.name} → ${r.ok ? "成功" : "失败"}\n${formatToolResultForModel(r)}`,
  );
  return [
    "以下是本轮工具调用的执行结果：",
    "",
    ...parts.flatMap((p) => [p, ""]),
    "请继续：任务未完成则继续调用工具；已完成则不要再调用工具，直接输出面向用户的最终总结。",
  ].join("\n");
}

/** UI / 持久化用的回执内容上限（ToolResult.data 中的大字段会被裁剪） */
const UI_DATA_LIMITS = {
  contentChars: 800,
  listEntries: 50,
  issueFiles: 20,
};

/**
 * 裁剪 ToolResult 中的大字段，供 UI 展示与会话持久化
 * （readFile 的 data.content 是全量文件内容，直接存会话会撑爆 localStorage）。
 * 模型回执走 formatToolResultForModel，不受本函数影响。
 */
export function compactToolResultForUI(result: ToolResult): ToolResult {
  if (!result.ok || !result.data || typeof result.data !== "object") return result;
  const data = { ...(result.data as Record<string, unknown>) };

  if (result.name === "readFile" && typeof data.content === "string") {
    if (data.content.length > UI_DATA_LIMITS.contentChars) {
      data.content = `${data.content.slice(0, UI_DATA_LIMITS.contentChars)}…`;
      data.truncated = true;
    }
  }
  if (result.name === "listFiles" && Array.isArray(data.files) && data.files.length > UI_DATA_LIMITS.listEntries) {
    data.files = (data.files as string[]).slice(0, UI_DATA_LIMITS.listEntries);
    data.truncated = true;
  }
  if (result.name === "runAnalysis" && Array.isArray(data.files) && data.files.length > UI_DATA_LIMITS.issueFiles) {
    data.files = data.files.slice(0, UI_DATA_LIMITS.issueFiles);
  }
  // Day 24：readFiles 的 content 是全量文本，逐个裁剪；searchCode 的 results 裁剪到 20 条
  if (result.name === "readFiles" && Array.isArray(data.items)) {
    data.items = (data.items as Array<Record<string, unknown>>).map((it) => {
      if (typeof it.content === "string" && it.content.length > UI_DATA_LIMITS.contentChars) {
        return { ...it, content: `${it.content.slice(0, UI_DATA_LIMITS.contentChars)}…`, truncated: true };
      }
      return it;
    });
  }
  if (result.name === "searchCode" && Array.isArray(data.results) && data.results.length > 20) {
    data.results = (data.results as unknown[]).slice(0, 20);
    data.truncated = true;
  }
  return { ...result, data };
}

// ---------------------------------------------------------------------------
// 项目级搜索辅助（Day 24）
// ---------------------------------------------------------------------------

/** glob 风格通配符转正则：* 匹配任意长度，? 匹配单字符 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(escaped, "i");
}

/** 单个文件的最大搜索字符数（超大文件跳过） */
const MAX_SEARCH_FILE_CHARS = 200_000;
/** searchCode 返回的最大匹配条数 */
const MAX_SEARCH_MATCHES = 50;

/**
 * 在指定文件列表中搜索内容。
 * - 纯文本：逐行 includes 匹配（大小写不敏感）
 * - 正则：逐行 RegExp 匹配（大小写不敏感）
 * 分批读取，批间让出主线程。
 */
export async function performSearchCode(
  files: string[],
  read: (path: string) => Promise<string>,
  pattern: string,
  useRegex: boolean,
  batchSize = 20,
): Promise<{ pattern: string; regex: boolean; results: Array<{ path: string; line: number; snippet: string }> }> {
  const needle = useRegex ? null : pattern.toLowerCase();
  const re = useRegex ? new RegExp(pattern, "i") : null;
  const results: Array<{ path: string; line: number; snippet: string }> = [];

  for (let i = 0; i < files.length; i += batchSize) {
    if (results.length >= MAX_SEARCH_MATCHES) break;
    const batch = files.slice(i, i + batchSize);
    const contents = await Promise.all(
      batch.map(async (path) => {
        try {
          return { path, content: await read(path) };
        } catch {
          return null;
        }
      }),
    );
    for (const item of contents) {
      if (!item || results.length >= MAX_SEARCH_MATCHES) continue;
      if (item.content.length > MAX_SEARCH_FILE_CHARS) continue;
      const lines = item.content.split("\n");
      for (let ln = 0; ln < lines.length && results.length < MAX_SEARCH_MATCHES; ln++) {
        const text = lines[ln];
        const hit = re ? re.test(text) : text.toLowerCase().includes(needle!);
        if (hit) {
          const snippet = text.trim().slice(0, 120);
          results.push({ path: item.path, line: ln + 1, snippet });
        }
      }
    }
    if (i + batchSize < files.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return { pattern, regex: useRegex, results };
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
