export interface AuditResponse {
  result?: string;
  error?: string;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  apiKeyEnv: string;
  endpoint: string;
  model: string;
  default: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

// ---------------------------------------------------------------------------
// 会话（Conversation）数据模型
// ---------------------------------------------------------------------------
// 采用类 Claude Code 的“消息流”模型：一个会话由一组按时间排序的消息组成。
// 切换会话 = 切换一整套独立的上下文；新建会话 = 从零开始。
// ---------------------------------------------------------------------------

/** 消息的发送方 */
export type MessageRole = "user" | "assistant";

/**
 * 消息的生命周期状态。
 * - running：正在流式生成（assistant）
 * - done：正常结束
 * - error：请求失败
 * - aborted：用户主动停止
 */
export type MessageStatus = "idle" | "running" | "done" | "error" | "aborted";

/** 会话中的单条消息 */
export interface ConversationMessage {
  id: string;
  role: MessageRole;
  /** 展示用内容：assistant 为 Markdown 报告；user 为一句说明（如 userPrompt 或“审计以下代码”） */
  content: string;
  status: MessageStatus;
  createdAt: number;
  /** 用户提交的代码快照（仅 user 消息，用于切换会话时恢复编辑器 / 重建多轮历史） */
  code?: string;
  /** 用户补充要求（仅 user 消息） */
  userPrompt?: string;
  /** 本次审计使用的模型 id（仅 user 消息） */
  modelId?: string;
}

/** 一个完整的审计会话 */
export interface Conversation {
  id: string;
  /** 自动生成的标题（取自 userPrompt 或代码首行） */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
}

/** 向后端多轮审计接口传递的单条历史消息 */
export interface AuditHistoryMessage {
  role: "user" | "assistant";
  /** 已格式化为模型输入的文本（user 含代码，assistant 为报告） */
  content: string;
}