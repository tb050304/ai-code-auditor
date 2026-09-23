/**
 * Agent 工具调用协议（Day 19）
 *
 * 设计要点：
 * 1. 工具 = 模型可调用的一个原子能力，入参/出参均为可结构化克隆的纯数据。
 * 2. 协议分三层：
 *    - ToolCall   ：模型发起的一次调用（name + args）
 *    - ToolResult ：执行器返回的结果（结构化 data 或可读 error）
 *    - ToolDefinition ：工具的静态元数据（描述/参数 schema），供模型提示词与 Tool 面板共用
 * 3. 执行器（tool-executor.ts）只依赖注入的 AgentToolContext，不直接依赖
 *    React Hook / IndexedDB —— 由 useAgentTools 桥接层提供宿主能力，
 *    核心逻辑可独立测试。
 *
 * 本模块不依赖 Babel/React。
 */

/** Agent 可调用的全部工具名 */
export type ToolName =
  | "readFile"
  | "writeFile"
  | "listFiles"
  | "runAnalysis"
  | "applyAutoFix"
  | "createSnapshot";

/** 工具参数的静态描述（用于校验、提示词渲染与 Tool 面板展示） */
export interface ToolParamSpec {
  name: string;
  type: "string" | "string[]";
  /** 给模型看的参数说明 */
  description: string;
  required: boolean;
}

/** 工具的静态元数据 */
export interface ToolDefinition {
  name: ToolName;
  /** 中文标题，Tool 面板展示 */
  title: string;
  /** 给模型看的能力描述（什么时候该用这个工具） */
  description: string;
  params: ToolParamSpec[];
  /** 是否修改项目状态（写入/修复/快照），UI 可据此提示风险 */
  mutating: boolean;
}

/** 模型发起的一次工具调用 */
export interface ToolCall {
  /** 调用 id（由调用方生成，结果回执时对应） */
  id: string;
  name: ToolName;
  /** 原始参数（未经校验） */
  args: Record<string, unknown>;
}

/** 一次工具调用的执行结果 */
export interface ToolResult {
  callId: string;
  name: ToolName;
  /** 执行是否成功（业务上的"没找到文件"也算 ok=false；"没有可修复问题"算 ok=true） */
  ok: boolean;
  /** 成功时的结构化数据（各工具形状见 tool-executor.ts） */
  data?: unknown;
  /** 失败时的可读原因 */
  error?: string;
  /** 执行耗时（ms） */
  duration: number;
}

// ---------------------------------------------------------------------------
// 各工具的入参（校验后的形状）
// ---------------------------------------------------------------------------

export interface ReadFileArgs {
  path: string;
}

export interface WriteFileArgs {
  path: string;
  content: string;
}

export interface ListFilesArgs {
  /** 可选目录前缀过滤，如 "src/"；缺省列出全部文件 */
  prefix?: string;
}

export interface RunAnalysisArgs {
  /** 要分析的文件路径；缺省分析项目内全部可分析文件 */
  paths?: string[];
}

export interface ApplyAutoFixArgs {
  path: string;
}

export interface CreateSnapshotArgs {
  name: string;
  description?: string;
}

/** 工具名 → 校验后的入参类型映射 */
export interface ToolArgsByName {
  readFile: ReadFileArgs;
  writeFile: WriteFileArgs;
  listFiles: ListFilesArgs;
  runAnalysis: RunAnalysisArgs;
  applyAutoFix: ApplyAutoFixArgs;
  createSnapshot: CreateSnapshotArgs;
}

/** runAnalysis 返回的分析摘要（执行器与模型之间的契约） */
export interface ToolAnalysisSummary {
  totalFiles: number;
  totalIssues: number;
  highSeverity: number;
  /** 有问题的文件明细（按问题数降序） */
  files: Array<{ path: string; issueCount: number; highSeverity: number }>;
}
