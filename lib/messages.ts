// ---------------------------------------------------------------------------
// 审计消息构造与会话工具（前后端共享）
// ---------------------------------------------------------------------------
// 单一职责原则：不要把“提示词拼接 / 历史构造 / 标题生成”散落在
// route、modelService、useAuditor 等多个文件里，否则极易走样。
// 这里作为唯一实现，前后端共同 import，保证模型输入格式一致。
// ---------------------------------------------------------------------------

import type { AuditHistoryMessage, ChatMode, Conversation, ConversationMessage } from "@/types";

/** 生成唯一 id：优先使用原生 crypto.randomUUID，失败则降级时间戳方案 */
export function createId(prefix = "msg"): string {
  try {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ---------------------------------------------------------------------------
// 系统提示（前后端共享的单一来源）
// ---------------------------------------------------------------------------

/** 审计模式系统提示：严格的代码审查报告 */
export const AUDIT_SYSTEM_PROMPT = `
你是一个资深的硅谷前端架构师与安全专家，拥有极高的代码品味。
现在你需要对用户提交的代码进行严格的审查。

请按照以下结构输出你的审计报告：
### 🐞 1. 潜在 Bug & 安全隐患 (如果没有，请夸奖一下)
### ⚡ 2. 性能与优雅度优化建议
### 🛠️ 3. 重构代码演示 (仅针对核心问题部分)

语气要求：专业、犀利、一针见血，可以用 Markdown 格式高亮重点。
`.trim();

/** 通用编程模式系统提示：写代码 / 解释代码 / 重构建议的多轮助手 */
export const CHAT_SYSTEM_PROMPT = `
你是一个资深的前端工程师与编程助手，运行在「AI 代码审计 IDE」中。
用户可能让你：编写新代码、解释一段代码的作用、给出重构方案、排查 Bug、解答编程问题。

回答要求：
1. 优先给出可直接使用的代码，代码块标注语言类型；修改类需求给出完整可用片段，不要只给零散差异。
2. 解释代码时先说结论（做什么、为什么），再展开关键细节，避免大段复述源码。
3. 用户附带的代码是当前编辑器中的上下文，可能并不完整；不要臆测未给出的项目结构，必要时说明你的假设。
4. 发现附带代码中有明显 Bug 或安全隐患时主动指出，但不要强行输出审计报告格式。
5. 使用与用户相同的语言（默认中文），Markdown 排版。
`.trim();

/** 按对话模式取系统提示（agent 模式的提示由 lib/agent/prompt 单独提供） */
export function getSystemPrompt(mode: ChatMode): string {
  return mode === "chat" ? CHAT_SYSTEM_PROMPT : AUDIT_SYSTEM_PROMPT;
}

/**
 * 构建发送给模型的“用户消息”文本。
 * 每次审计都会把当前完整代码 + 用户补充要求拼成一段用户输入，
 * 因此服务端（route）与客户端（重建历史）必须使用同一份实现。
 */
export function buildUserContent(code: string, userPrompt?: string): string {
  let content = `待审计代码如下：\n\n${code}`;
  if (userPrompt && userPrompt.trim()) {
    content += `\n\n---\n\n## 用户补充要求\n\n${userPrompt.trim()}`;
  }
  return content;
}

/**
 * 通用编程模式的用户消息文本（Day 22）。
 * 与审计模式的区别：提问本身是主体，代码只是可选上下文；
 * 没有代码时（如“帮我写一个防抖函数”）只发送用户问题。
 */
export function buildChatUserContent(code: string | undefined, userPrompt?: string): string {
  const question = userPrompt?.trim() ?? "";
  const hasCode = code && code.trim();
  if (!hasCode) return question;
  let content = `当前编辑器中的代码如下，供参考（不一定要逐行分析）：\n\n${code}`;
  if (question) content += `\n\n---\n\n## 我的问题 / 需求\n\n${question}`;
  return content;
}

/** 按消息的对话模式选择重建模型输入用的用户消息文本 */
function rebuildUserContent(message: ConversationMessage): string {
  return message.mode === "chat"
    ? buildChatUserContent(message.code, message.userPrompt)
    : buildUserContent(message.code ?? "", message.userPrompt);
}

/**
 * 构造多轮上下文所需的历史消息数组。
 * 提取目标消息之前所有“已完成”的 user/assistant 消息：
 *   - user 消息用其存储的 code + userPrompt 重建模型输入；
 *   - assistant 消息直接使用报告文本。
 * 只取 status === "done" 或 "idle" 的消息，避免把双方正在生成的半成品混入上下文。
 */
export function buildHistoryMessages(
  conversation: Conversation | undefined,
  untilMessageId?: string
): AuditHistoryMessage[] {
  if (!conversation) return [];

  const history: AuditHistoryMessage[] = [];
  for (const message of conversation.messages) {
    // 到达目标消息即停止（不把当前请求自身算进历史）
    if (untilMessageId && message.id === untilMessageId) break;

    if (message.role === "user") {
      // 用户消息只纳入完整提交且已结束的
      if (message.status === "running" || message.status === "error") continue;
      // chat 模式允许无代码：直接用提问重建；audit 模式仍必须有代码快照
      if (message.mode === "chat") {
        const content = rebuildUserContent(message);
        if (!content) continue;
        history.push({ role: "user", content });
        continue;
      }
      if (!message.code) continue;
      history.push({ role: "user", content: rebuildUserContent(message) });
    } else if (message.role === "assistant") {
      // 助手消息只纳入正常完成的内容，避免把中断/报错文本传给模型
      if (message.status !== "done" && message.status !== "idle") continue;
      if (!message.content) continue;
      history.push({ role: "assistant", content: message.content });
    }
  }
  return history;
}

/**
 * 根据用户输入自动生成会话标题：
 * 优先取 userPrompt 首个非空行，其次取代码首行，超长截断。
 * 纯本地规则，不自费调用模型。
 */
export function generateConversationTitle(code?: string, userPrompt?: string): string {
  const candidate =
    userPrompt?.trim().split("\n")[0]?.trim() || code?.trim().split("\n")[0]?.trim() || "";
  if (!candidate) return "未命名会话";
  const cleaned = candidate.replace(/^[\/#\s*`"]+/, "").trim();
  const MAX = 24;
  return cleaned.length > MAX ? `${cleaned.slice(0, MAX)}…` : cleaned;
}

/**
 * 新建一条消息对象。工厂函数保证字段默认值一致。
 */
export function createMessage(
  role: ConversationMessage["role"],
  fields: Partial<ConversationMessage> = {}
): ConversationMessage {
  return {
    id: createId(role === "assistant" ? "assistant" : "user"),
    role,
    content: "",
    status: "idle",
    createdAt: Date.now(),
    ...fields,
  };
}