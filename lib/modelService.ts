import axios, { type AxiosRequestConfig } from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import OpenAI from "openai";
import { ModelConfig, getModelConfig, getDefaultModelConfig } from "./models";
import {
  buildChatUserContent,
  buildUserContent,
  getSystemPrompt,
} from "./messages";
import { withRetry, classifyError, fetchWithTimeout } from "./errors";
import type { AuditHistoryMessage, ChatMode } from "@/types";

/**
 * 连接阶段（直到响应头返回）的超时上限。
 * 注意：fetchWithTimeout 在 fetch resolve（即收到响应头）后即清掉定时器，
 * 因此这个值只约束「建连 + 首字节」，不会掐断后续的流式生成。
 */
const MODEL_CONNECT_TIMEOUT_MS = 30_000;

export interface StreamChunk {
  content: string;
  done: boolean;
}

/** 统一的模型对话消息结构（system / user / assistant 均可） */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 生成完整的 messages 数组：
 *   [system] + [可选历史多轮消息] + [当前一次用户请求]
 * 历史由调用方（route）用 buildHistoryMessages 预先构造，
 * 保证 user 消息里的代码与当前请求的拼接逻辑一致。
 */
function buildMessages(
  history: AuditHistoryMessage[] | undefined,
  userContent: string,
  mode: ChatMode = "audit",
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: getSystemPrompt(mode) }];
  if (history && history.length > 0) {
    for (const item of history) {
      messages.push({ role: item.role, content: item.content });
    }
  }
  messages.push({ role: "user", content: userContent });
  return messages;
}

export async function* analyzeCodeStream(
  code: string,
  modelId?: string,
  userPrompt?: string,
  history?: AuditHistoryMessage[],
  mode: ChatMode = "audit",
): AsyncGenerator<StreamChunk, void, unknown> {
  const config = modelId ? getModelConfig(modelId) : getDefaultModelConfig();

  if (!config) {
    throw new Error("未找到指定的模型配置");
  }

  const apiKey = process.env[config.apiKeyEnv as keyof typeof process.env];

  if (!apiKey) {
    throw new Error(`服务器未配置 ${config.apiKeyEnv}`);
  }

  // 单一来源构造“用户消息”文本：chat 模式提问为主体、代码可选；audit 模式代码必填
  const userContent =
    mode === "chat" ? buildChatUserContent(code, userPrompt) : buildUserContent(code, userPrompt);
  const messages = buildMessages(history, userContent, mode);

  yield* chatStream(messages, modelId);
}

/**
 * 通用多轮对话流式接口（Day 20）：messages 由调用方完整构造（含 system），
 * 本函数只负责按 provider 分发流式请求。/api/audit 的单轮审计与
 * /api/agent 的思考-执行循环共用此底层。
 */
export async function* chatStream(
  messages: ChatMessage[],
  modelId?: string
): AsyncGenerator<StreamChunk, void, unknown> {
  const config = modelId ? getModelConfig(modelId) : getDefaultModelConfig();

  if (!config) {
    throw new Error("未找到指定的模型配置");
  }

  const apiKey = process.env[config.apiKeyEnv as keyof typeof process.env];

  if (!apiKey) {
    throw new Error(`服务器未配置 ${config.apiKeyEnv}`);
  }

  if (config.provider === "deepseek") {
    yield* analyzeWithOpenAICompatibleStream(config, apiKey, messages);
  } else {
    yield* analyzeWithAxiosStream(config, apiKey, messages);
  }
}

/**
 * DeepSeek 分支：走 OpenAI 兼容 SDK，天然支持多轮 messages。
 */
async function* analyzeWithOpenAICompatibleStream(
  config: ModelConfig,
  apiKey: string,
  messages: ChatMessage[]
): AsyncGenerator<StreamChunk, void, unknown> {
  const openai = new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: apiKey,
    // 注入带超时的 fetch：SDK 默认无显式连接超时，断网时会一直挂着。
    // 超时抛 Error("timeout")，由外层 classifyError 归为 timeout（可重试）。
    fetch: (input, init) =>
      fetchWithTimeout(input, { ...init, timeoutMs: MODEL_CONNECT_TIMEOUT_MS }),
  });

  const stream = await withRetry(
    () =>
      openai.chat.completions.create({
        model: config.model,
        messages: messages as never,
        temperature: 0.3,
        stream: true,
      }),
    {
      maxRetries: 2,
      onRetry: (err, attempt, delay) =>
        console.warn(`[modelService] OpenAI 连接重试 ${attempt + 1}/2，${delay}ms 后重试：${classifyError(err).message}`),
    },
  );

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || "";
    if (content) {
      yield { content, done: false };
    }
  }

  yield { content: "", done: true };
}

/**
 * 通用 axios 流式分支：按 OpenAI 兼容的 SSE 报文格式解析。
 * 注意：Anthropic / Gemini 的报文结构与此不同，如需完整多轮支持需单独适配；
 * 当前实现对其采用与 OpenAI 相同形状的 body，单轮可用、多轮以 OpenAI 系为可靠基线。
 */
async function* analyzeWithAxiosStream(
  config: ModelConfig,
  apiKey: string,
  messages: ChatMessage[]
): AsyncGenerator<StreamChunk, void, unknown> {
  const proxyUrl = process.env.PROXY_URL;
  const axiosConfig: AxiosRequestConfig = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    timeout: 120000,
    responseType: "stream",
    // 可选：走代理（用于受限网络环境）；做一次窄化以便适配 axios 的 Agent 类型
    ...(proxyUrl
      ? { httpsAgent: new HttpsProxyAgent(proxyUrl) as unknown as AxiosRequestConfig["httpsAgent"] }
      : {}),
  };

  const response = await withRetry(
    () =>
      axios.post(
        config.endpoint,
        {
          model: config.model,
          messages,
          temperature: 0.3,
          stream: true,
        },
        axiosConfig,
      ),
    {
      maxRetries: 2,
      onRetry: (err, attempt, delay) =>
        console.warn(`[modelService] Axios 连接重试 ${attempt + 1}/2，${delay}ms 后重试：${classifyError(err).message}`),
    },
  );

  const stream = response.data;
  let buffer = "";

  for await (const chunk of stream) {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim().startsWith("data: ")) {
        const data = line.trim().slice(6);
        if (data === "[DONE]") {
          yield { content: "", done: true };
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || "";
          if (content) {
            yield { content, done: false };
          }
        } catch {
          // 忽略无法解析的行，保持流的健壮性
        }
      }
    }
  }

  yield { content: "", done: true };
}

export async function analyzeCode(
  code: string,
  modelId?: string,
  userPrompt?: string,
  history?: AuditHistoryMessage[],
  mode: ChatMode = "audit",
): Promise<string> {
  let result = "";
  for await (const chunk of analyzeCodeStream(code, modelId, userPrompt, history, mode)) {
    if (chunk.done) break;
    result += chunk.content;
  }
  return result;
}