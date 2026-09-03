import axios, { type AxiosRequestConfig } from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import OpenAI from "openai";
import { ModelConfig, getModelConfig, getDefaultModelConfig } from "./models";
import { buildUserContent } from "./messages";
import type { AuditHistoryMessage } from "@/types";

const systemPrompt = `
你是一个资深的硅谷前端架构师与安全专家，拥有极高的代码品味。
现在你需要对用户提交的代码进行严格的审查。

请按照以下结构输出你的审计报告：
### 🐞 1. 潜在 Bug & 安全隐患 (如果没有，请夸奖一下)
### ⚡ 2. 性能与优雅度优化建议
### 🛠️ 3. 重构代码演示 (仅针对核心问题部分)

语气要求：专业、犀利、一针见血，可以用 Markdown 格式高亮重点。
`;

export interface StreamChunk {
  content: string;
  done: boolean;
}

/** 统一的模型对话消息结构（system / user / assistant 均可） */
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 生成完整的 messages 数组：
 *   [system] + [可选历史多轮消息] + [当前一次用户审计请求]
 * 历史由调用方（route）用 buildHistoryMessages 预先构造，
 * 保证 user 消息里的代码与当前审计的拼接逻辑一致。
 */
function buildMessages(
  history: AuditHistoryMessage[] | undefined,
  userContent: string
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt.trim() }];
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
  history?: AuditHistoryMessage[]
): AsyncGenerator<StreamChunk, void, unknown> {
  const config = modelId ? getModelConfig(modelId) : getDefaultModelConfig();

  if (!config) {
    throw new Error("未找到指定的模型配置");
  }

  const apiKey = process.env[config.apiKeyEnv as keyof typeof process.env];

  if (!apiKey) {
    throw new Error(`服务器未配置 ${config.apiKeyEnv}`);
  }

  // 单一来源构造“用户消息”文本
  const userContent = buildUserContent(code, userPrompt);
  const messages = buildMessages(history, userContent);

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
  });

  const stream = await openai.chat.completions.create({
    model: config.model,
    messages: messages as never,
    temperature: 0.3,
    stream: true,
  });

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

  const response = await axios.post(
    config.endpoint,
    {
      model: config.model,
      messages,
      temperature: 0.3,
      stream: true,
    },
    axiosConfig
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
  history?: AuditHistoryMessage[]
): Promise<string> {
  let result = "";
  for await (const chunk of analyzeCodeStream(code, modelId, userPrompt, history)) {
    if (chunk.done) break;
    result += chunk.content;
  }
  return result;
}