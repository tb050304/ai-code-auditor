/**
 * Agent 系统提示词构建（Day 20）
 *
 * 单一来源：由工具目录（tool-definitions.ts）渲染出可用工具清单与调用格式，
 * 避免提示词与工具目录两处描述走样。服务端 /api/agent 注入本提示。
 */

import { TOOL_DEFINITIONS, TOOL_ORDER } from "./tool-definitions";

/** 工具调用 JSON 块的围栏标记（协议解析 loop.ts 与提示词必须一致） */
export const TOOL_BLOCK_TAG = "tool";

export function buildAgentSystemPrompt(): string {
  const toolLines = TOOL_ORDER.map((name) => {
    const def = TOOL_DEFINITIONS[name];
    const params = def.params
      .map((p) => `${p.name}${p.required ? "" : "（可选）"}(${p.type})：${p.description}`)
      .join("；");
    const risk = def.mutating ? "【会修改项目】" : "";
    return `- ${def.name}（${def.title}）${risk}：${def.description}\n  参数：${params || "无"}`;
  }).join("\n");

  return `你是运行在「AI 代码审计 IDE」浏览器端的编程 Agent，可以直接操作用户当前导入的项目（读取/写入文件、运行 AST 静态分析、应用自动修复、创建项目快照）。

## 可用工具

${toolLines}

## 工具调用格式

需要调用工具时，严格输出如下围栏代码块（json 内容必须可解析）：

\`\`\`${TOOL_BLOCK_TAG}
{"tool":"readFile","args":{"path":"src/index.ts"}}
\`\`\`

规则：
1. 一次回复可以包含说明文字 + 一个或多个工具调用块；块外的文字会展示给用户。
2. 工具执行结果会以用户消息形式回传给你，收到后继续思考下一步。
3. 只能调用上表列出的工具；参数必须符合 schema；写文件时 content 必须是完整文件内容。
4. 建议流程：先 listFiles 了解结构 → readFile 查看目标文件 → runAnalysis 获取问题清单 → 修复前 createSnapshot 打安全点 → 修复（applyAutoFix 或 writeFile）→ runAnalysis 验证。
5. 任务完成或无法继续时，不要再调用工具，直接输出面向用户的最终总结（做了什么、修了什么、还有什么遗留风险）。
6. 遇到工具执行失败时，阅读错误原因并调整策略（如换路径、先分析再修复），不要盲目重试同一调用。`;
}
