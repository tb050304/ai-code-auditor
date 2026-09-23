/**
 * Agent 工具目录（Day 19）
 *
 * 6 个工具的静态元数据：名称 / 中文标题 / 给模型看的能力描述 / 参数 schema。
 * 单一来源：模型提示词（Day 20 拼系统提示时渲染）与 Tool 面板（展示每步调用了
 * 什么工具、什么参数）都从这里取，避免两处描述走样。
 */

import type { ToolDefinition, ToolName } from "./tool-types";

export const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  readFile: {
    name: "readFile",
    title: "读取文件",
    description:
      "读取项目内指定路径文件的完整文本内容。用于查看代码上下文、确认修改前的现状。文件不存在时返回错误。",
    params: [
      { name: "path", type: "string", description: "文件路径，如 src/index.ts", required: true },
    ],
    mutating: false,
  },
  writeFile: {
    name: "writeFile",
    title: "写入文件",
    description:
      "把完整文本内容写入指定路径（覆盖式写入，不存在则新建）。写盘前系统会自动生成快照，可回退。content 必须是完整文件内容，不要只给差异片段。",
    params: [
      { name: "path", type: "string", description: "文件路径", required: true },
      { name: "content", type: "string", description: "写入的完整文件内容", required: true },
    ],
    mutating: true,
  },
  listFiles: {
    name: "listFiles",
    title: "列出文件",
    description:
      "列出项目内全部文件的路径。用于了解项目结构、寻找目标文件。可用 prefix 按目录前缀过滤。",
    params: [
      { name: "prefix", type: "string", description: "可选的路径前缀过滤，如 src/", required: false },
    ],
    mutating: false,
  },
  runAnalysis: {
    name: "runAnalysis",
    title: "运行 AST 分析",
    description:
      "对指定文件（或整个项目）运行 AST 静态分析，返回问题数量摘要与问题文件清单。调用 applyAutoFix 前建议先运行分析获取最新问题。",
    params: [
      {
        name: "paths",
        type: "string[]",
        description: "要分析的文件路径数组；缺省分析项目内全部可分析文件（.js/.jsx/.ts/.tsx/.mjs/.cjs）",
        required: false,
      },
    ],
    mutating: false,
  },
  applyAutoFix: {
    name: "applyAutoFix",
    title: "应用自动修复",
    description:
      "对指定文件应用 AST 自动修复（基于最近一次分析结果中带修复提案的问题）。返回应用/跳过的数量；无任何可修复问题时不会写盘。",
    params: [
      { name: "path", type: "string", description: "要修复的文件路径", required: true },
    ],
    mutating: true,
  },
  createSnapshot: {
    name: "createSnapshot",
    title: "创建项目快照",
    description:
      "给整个项目当前状态打一个版本快照（标签），用于批量修改前的安全点。建议在执行大规模修改前调用。",
    params: [
      { name: "name", type: "string", description: "快照名称，如 修复前-原始版本", required: true },
      { name: "description", type: "string", description: "可选的快照说明", required: false },
    ],
    mutating: true,
  },
};

/** 工具目录的稳定顺序（供提示词渲染与面板列表） */
export const TOOL_ORDER: ToolName[] = [
  "listFiles",
  "readFile",
  "runAnalysis",
  "applyAutoFix",
  "writeFile",
  "createSnapshot",
];
