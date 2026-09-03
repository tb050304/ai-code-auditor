// ---------------------------------------------------------------------------
// 审计消息构造与会话工具（前后端共享）
// ---------------------------------------------------------------------------
// 单一职责原则：不要把“提示词拼接 / 历史构造 / 标题生成”散落在
// route、modelService、useAuditor 等多个文件里，否则极易走样。
// 这里作为唯一实现，前后端共同 import，保证模型输入格式一致。
// ---------------------------------------------------------------------------

import type { AuditHistoryMessage, Conversation, ConversationMessage } from "@/types";

/** 生成唯一 id：优先使用原生 crypto.randomUUID，失败时降级时间戳方案 */
export function createId(prefix = "msg"): string {
  try {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
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
      // 用户消息只纳入完整提交（有 code 且已结束）
      if (!message.code) continue;
      if (message.status === "running" || message.status === "error") continue;
      history.push({ role: "user", content: buildUserContent(message.code, message.userPrompt) });
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