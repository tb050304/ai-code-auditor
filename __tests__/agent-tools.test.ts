/**
 * Day 19 Agent 工具调用协议测试
 * - validateToolArgs：6 个工具的参数校验（正例/反例）
 * - createToolExecutor：注入假宿主上下文，验证执行、错误收敛、结果包装
 * - formatToolResultForModel：模型可读回执（截断/摘要/失败文本）
 * - collectAnalysisTasks：分批读取、失败跳过
 * - collectFilePaths：文件树遍历收集（listFiles/runAnalysis 底层）
 */
import { describe, it, expect } from "vitest";
import {
  validateToolArgs,
  createToolExecutor,
  formatToolResultForModel,
  collectAnalysisTasks,
  type AgentToolContext,
} from "@/lib/agent/tool-executor";
import { TOOL_DEFINITIONS, TOOL_ORDER } from "@/lib/agent/tool-definitions";
import { buildTree, collectFilePaths } from "@/lib/storage/file-tree";
import type { ToolCall, ToolResult } from "@/lib/agent/tool-types";

function makeCall(name: ToolCall["name"], args: Record<string, unknown>): ToolCall {
  return { id: "call-1", name, args };
}

/** 可记录调用的假宿主 */
function makeContext(overrides: Partial<AgentToolContext> = {}): AgentToolContext & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    readFile: async (path) => {
      calls.push(`readFile:${path}`);
      if (path === "/missing.js") throw new Error("文件不存在");
      return "const a = 1;\nconst b = 2;";
    },
    writeFile: async (path, content) => {
      calls.push(`writeFile:${path}:${content}`);
    },
    listFiles: async () => {
      calls.push("listFiles");
      return ["/src/a.ts", "/src/lib/b.ts", "/docs/readme.md"];
    },
    runAnalysis: async (paths) => {
      calls.push(`runAnalysis:${JSON.stringify(paths)}`);
      return {
        totalFiles: 2,
        totalIssues: 3,
        highSeverity: 1,
        files: [{ path: "/src/a.ts", issueCount: 3, highSeverity: 1 }],
      };
    },
    getFixableFixes: async (path) => {
      calls.push(`getFixableFixes:${path}`);
      return [
        {
          ruleId: "no-var",
          description: "将 var 替换为 let",
          risk: "review",
          edits: [
            { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4, replacement: "let" },
          ],
        },
      ];
    },
    applyAutoFixes: async (path, fixes) => {
      calls.push(`applyAutoFixes:${path}:${fixes.length}`);
      return { changed: true, applied: fixes.length, skipped: 0 };
    },
    createSnapshot: async (name) => {
      calls.push(`createSnapshot:${name}`);
      return { id: "snap-1", name };
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

describe("validateToolArgs", () => {
  it("readFile：合法 path 通过", () => {
    const r = validateToolArgs("readFile", { path: "src/index.ts" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.path).toBe("src/index.ts");
  });

  it("readFile：缺失/空 path 报错", () => {
    expect(validateToolArgs("readFile", {}).ok).toBe(false);
    expect(validateToolArgs("readFile", { path: "   " }).ok).toBe(false);
    expect(validateToolArgs("readFile", { path: 123 }).ok).toBe(false);
  });

  it("writeFile：content 非字符串报错", () => {
    const bad = validateToolArgs("writeFile", { path: "a.ts", content: 42 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("content");

    const good = validateToolArgs("writeFile", { path: "a.ts", content: "" });
    expect(good.ok).toBe(true);
  });

  it("writeFile：缺失 path 报错", () => {
    expect(validateToolArgs("writeFile", { content: "x" }).ok).toBe(false);
  });

  it("listFiles：无参数合法，prefix 需为非空字符串", () => {
    expect(validateToolArgs("listFiles", {}).ok).toBe(true);
    expect(validateToolArgs("listFiles", { prefix: "src/" }).ok).toBe(true);
    expect(validateToolArgs("listFiles", { prefix: "" }).ok).toBe(false);
    expect(validateToolArgs("listFiles", { prefix: 1 }).ok).toBe(false);
  });

  it("runAnalysis：paths 可省略，须为非空字符串数组", () => {
    expect(validateToolArgs("runAnalysis", {}).ok).toBe(true);
    const r = validateToolArgs("runAnalysis", { paths: ["a.ts", "b.ts"] });
    expect(r.ok).toBe(true);
    expect(validateToolArgs("runAnalysis", { paths: [] }).ok).toBe(true);
    expect(validateToolArgs("runAnalysis", { paths: ["a", ""] }).ok).toBe(false);
    expect(validateToolArgs("runAnalysis", { paths: "a.ts" }).ok).toBe(false);
  });

  it("createSnapshot：name 必填，description 可选", () => {
    expect(validateToolArgs("createSnapshot", {}).ok).toBe(false);
    expect(validateToolArgs("createSnapshot", { name: "修复前" }).ok).toBe(true);
    expect(
      validateToolArgs("createSnapshot", { name: "修复前", description: "批量修改前" }).ok,
    ).toBe(true);
    expect(validateToolArgs("createSnapshot", { name: "x", description: 9 }).ok).toBe(false);
  });

  it("applyAutoFix：path 必填", () => {
    expect(validateToolArgs("applyAutoFix", { path: "/a.js" }).ok).toBe(true);
    expect(validateToolArgs("applyAutoFix", {}).ok).toBe(false);
  });

  it("非对象参数报错", () => {
    expect(validateToolArgs("readFile", null).ok).toBe(false);
    expect(validateToolArgs("readFile", "path").ok).toBe(false);
    expect(validateToolArgs("readFile", [1]).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 工具目录
// ---------------------------------------------------------------------------

describe("tool definitions", () => {
  it("6 个工具全部注册，目录顺序完整", () => {
    expect(Object.keys(TOOL_DEFINITIONS).sort()).toEqual(
      ["applyAutoFix", "createSnapshot", "listFiles", "readFile", "runAnalysis", "writeFile"].sort(),
    );
    expect(TOOL_ORDER).toHaveLength(6);
  });

  it("修改型工具都有 mutating 标记，只读工具为 false", () => {
    expect(TOOL_DEFINITIONS.writeFile.mutating).toBe(true);
    expect(TOOL_DEFINITIONS.applyAutoFix.mutating).toBe(true);
    expect(TOOL_DEFINITIONS.createSnapshot.mutating).toBe(true);
    expect(TOOL_DEFINITIONS.readFile.mutating).toBe(false);
    expect(TOOL_DEFINITIONS.listFiles.mutating).toBe(false);
    expect(TOOL_DEFINITIONS.runAnalysis.mutating).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

describe("createToolExecutor", () => {
  it("未知工具 → ok=false 且带原因", async () => {
    const ctx = makeContext();
    const r = await createToolExecutor(ctx)(makeCall("hack" as ToolCall["name"], {}));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未知工具");
    expect(r.duration).toBeGreaterThanOrEqual(0);
  });

  it("参数非法 → ok=false，不触碰宿主", async () => {
    const ctx = makeContext();
    const r = await createToolExecutor(ctx)(makeCall("readFile", {}));
    expect(r.ok).toBe(false);
    expect(ctx.calls).toHaveLength(0);
  });

  it("readFile 成功：返回内容与行数", async () => {
    const ctx = makeContext();
    const r = await createToolExecutor(ctx)(makeCall("readFile", { path: "/src/a.ts" }));
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ path: "/src/a.ts", lineCount: 2 });
    expect((r.data as { content: string }).content).toContain("const a = 1;");
  });

  it("readFile 文件不存在 → ok=false 带可读错误，不抛异常", async () => {
    const r = await createToolExecutor(makeContext())(makeCall("readFile", { path: "/missing.js" }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("文件不存在");
  });

  it("writeFile：path+content 传给宿主，返回统计", async () => {
    const ctx = makeContext();
    const r = await createToolExecutor(ctx)(
      makeCall("writeFile", { path: "/src/new.ts", content: "let a;\nlet b;" }),
    );
    expect(r.ok).toBe(true);
    expect(ctx.calls).toContain("writeFile:/src/new.ts:let a;\nlet b;");
    expect(r.data).toMatchObject({ charCount: 13, lineCount: 2 });
  });

  it("listFiles：prefix 过滤", async () => {
    const ctx = makeContext();
    const r = await createToolExecutor(ctx)(makeCall("listFiles", { prefix: "/src/" }));
    expect(r.ok).toBe(true);
    expect((r.data as { files: string[] }).files).toEqual(["/src/a.ts", "/src/lib/b.ts"]);
    expect((r.data as { total: number }).total).toBe(3);
  });

  it("listFiles：无 prefix 返回全部", async () => {
    const r = await createToolExecutor(makeContext())(makeCall("listFiles", {}));
    expect((r.data as { files: string[] }).files).toHaveLength(3);
  });

  it("runAnalysis：摘要透传", async () => {
    const ctx = makeContext();
    const r = await createToolExecutor(ctx)(makeCall("runAnalysis", { paths: ["/src/a.ts"] }));
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ totalFiles: 2, totalIssues: 3, highSeverity: 1 });
    expect(ctx.calls).toContain('runAnalysis:["/src/a.ts"]');
  });

  it("applyAutoFix：宿主提案 → 应用 → 计数回传", async () => {
    const ctx = makeContext();
    const r = await createToolExecutor(ctx)(makeCall("applyAutoFix", { path: "/src/a.ts" }));
    expect(r.ok).toBe(true);
    const data = r.data as { fixable: number; applied: number; skipped: number; message: string };
    expect(data).toMatchObject({ fixable: 1, applied: 1, skipped: 0 });
    expect(data.message).toContain("应用 1 处");
    expect(ctx.calls).toContain("getFixableFixes:/src/a.ts");
    expect(ctx.calls).toContain("applyAutoFixes:/src/a.ts:1");
  });

  it("applyAutoFix：无可修复问题时不报错，message 提示", async () => {
    const ctx = makeContext({ getFixableFixes: async () => [] });
    const r = await createToolExecutor(ctx)(makeCall("applyAutoFix", { path: "/src/a.ts" }));
    expect(r.ok).toBe(true);
    expect((r.data as { applied: number }).applied).toBe(0);
    expect((r.data as { message: string }).message).toContain("没有可自动修复的问题");
  });

  it("createSnapshot：返回 id+name", async () => {
    const ctx = makeContext();
    const r = await createToolExecutor(ctx)(
      makeCall("createSnapshot", { name: "修复前", description: "批量修改前" }),
    );
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ id: "snap-1", name: "修复前" });
  });

  it("宿主抛出非 Error 值也能收敛为字符串错误", async () => {
    const ctx = makeContext({
      createSnapshot: async () => {
        throw "boom";
      },
    });
    const r = await createToolExecutor(ctx)(makeCall("createSnapshot", { name: "x" }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// 模型回执序列化
// ---------------------------------------------------------------------------

describe("formatToolResultForModel", () => {
  it("失败结果包含错误原因", () => {
    const r: ToolResult = {
      callId: "c",
      name: "readFile",
      ok: false,
      error: "文件不存在",
      duration: 1,
    };
    const text = formatToolResultForModel(r);
    expect(text).toContain("失败");
    expect(text).toContain("文件不存在");
  });

  it("readFile：超长内容截断并标注", () => {
    const long = "x".repeat(5000);
    const text = formatToolResultForModel({
      callId: "c",
      name: "readFile",
      ok: true,
      data: { path: "/big.ts", content: long, lineCount: 1 },
      duration: 1,
    });
    expect(text).toContain("已截断");
    expect(text).not.toContain(long);
    expect(text).toContain("/big.ts");
  });

  it("readFile：正常内容不截断", () => {
    const text = formatToolResultForModel({
      callId: "c",
      name: "readFile",
      ok: true,
      data: { path: "/a.ts", content: "const a = 1;", lineCount: 1 },
      duration: 1,
    });
    expect(text).not.toContain("已截断");
    expect(text).toContain("const a = 1;");
  });

  it("writeFile：确认文本含路径与统计", () => {
    const text = formatToolResultForModel({
      callId: "c",
      name: "writeFile",
      ok: true,
      data: { path: "/a.ts", charCount: 12, lineCount: 2 },
      duration: 1,
    });
    expect(text).toContain("/a.ts");
    expect(text).toContain("快照");
  });

  it("listFiles：超 200 条省略", () => {
    const files = Array.from({ length: 250 }, (_, i) => `/f${i}.ts`);
    const text = formatToolResultForModel({
      callId: "c",
      name: "listFiles",
      ok: true,
      data: { files, total: 250 },
      duration: 1,
    });
    expect(text).toContain("250");
    expect(text).toContain("已省略");
  });

  it("runAnalysis：有问题文件逐行列出；无问题给明确提示", () => {
    const withIssues = formatToolResultForModel({
      callId: "c",
      name: "runAnalysis",
      ok: true,
      data: {
        totalFiles: 1,
        totalIssues: 2,
        highSeverity: 1,
        files: [{ path: "/a.ts", issueCount: 2, highSeverity: 1 }],
      },
      duration: 1,
    });
    expect(withIssues).toContain("2 个问题");
    expect(withIssues).toContain("高危 1");

    const clean = formatToolResultForModel({
      callId: "c",
      name: "runAnalysis",
      ok: true,
      data: { totalFiles: 3, totalIssues: 0, highSeverity: 0, files: [] },
      duration: 1,
    });
    expect(clean).toContain("没有发现任何问题");
  });

  it("applyAutoFix / createSnapshot：可读确认", () => {
    expect(
      formatToolResultForModel({
        callId: "c",
        name: "applyAutoFix",
        ok: true,
        data: { path: "/a.ts", fixable: 2, changed: true, applied: 2, skipped: 0, message: "应用 2 处，跳过 0 处" },
        duration: 1,
      }),
    ).toContain("应用 2 处");

    expect(
      formatToolResultForModel({
        callId: "c",
        name: "createSnapshot",
        ok: true,
        data: { id: "snap-1", name: "修复前" },
        duration: 1,
      }),
    ).toContain("修复前");
  });
});

// ---------------------------------------------------------------------------
// 分批收集分析任务
// ---------------------------------------------------------------------------

describe("collectAnalysisTasks", () => {
  it("全部读取且顺序保持", async () => {
    const paths = ["/a.ts", "/b.ts", "/c.ts"];
    const tasks = await collectAnalysisTasks(paths, async (p) => `code-${p}`);
    expect(tasks).toEqual([
      { path: "/a.ts", content: "code-/a.ts" },
      { path: "/b.ts", content: "code-/b.ts" },
      { path: "/c.ts", content: "code-/c.ts" },
    ]);
  });

  it("读取失败的文件静默跳过", async () => {
    const tasks = await collectAnalysisTasks(
      ["/ok.ts", "/bad.ts", "/ok2.ts"],
      async (p) => {
        if (p === "/bad.ts") throw new Error("gone");
        return "code";
      },
    );
    expect(tasks.map((t) => t.path)).toEqual(["/ok.ts", "/ok2.ts"]);
  });

  it("batchSize 生效：全部文件仍被读取", async () => {
    const read: string[] = [];
    const paths = ["/a", "/b", "/c", "/d", "/e"];
    const tasks = await collectAnalysisTasks(
      paths,
      async (p) => {
        read.push(p);
        return "x";
      },
      2,
    );
    expect(read.sort()).toEqual([...paths].sort());
    expect(tasks).toHaveLength(5);
  });

  it("空路径列表返回空任务", async () => {
    expect(await collectAnalysisTasks([], async () => "x")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 文件树收集
// ---------------------------------------------------------------------------

describe("collectFilePaths", () => {
  const tree = buildTree([
    makeNode("/src/a.ts", "file"),
    makeNode("/src/lib/b.ts", "file"),
    makeNode("/src/lib", "directory"),
    makeNode("/docs/readme.md", "file"),
    makeNode("/docs", "directory"),
  ]);

  it("收集全部文件（不含目录）", () => {
    expect(collectFilePaths(tree).sort()).toEqual([
      "/docs/readme.md",
      "/src/a.ts",
      "/src/lib/b.ts",
    ]);
  });

  it("predicate 过滤（模拟可分析文件筛选）", () => {
    const paths = collectFilePaths(tree, (p) => p.endsWith(".ts"));
    expect(paths.sort()).toEqual(["/src/a.ts", "/src/lib/b.ts"]);
  });
});

function makeNode(path: string, type: "file" | "directory") {
  return { path, type, size: 1, mtime: 0, ctime: 0 };
}
