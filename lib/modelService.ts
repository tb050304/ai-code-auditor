import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import OpenAI from "openai";
import { ModelConfig, getModelConfig, getDefaultModelConfig } from "./models";

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

export async function* analyzeCodeStream(
  code: string,
  modelId?: string,
  userPrompt?: string
): AsyncGenerator<StreamChunk, void, unknown> {
  const config = modelId ? getModelConfig(modelId) : getDefaultModelConfig();

  if (!config) {
    throw new Error("未找到指定的模型配置");
  }

  const apiKey = process.env[config.apiKeyEnv as keyof typeof process.env];

  if (!apiKey) {
    throw new Error(`服务器未配置 ${config.apiKeyEnv}`);
  }

  // 构建用户提示词
  let userContent = `待审计代码如下：\n\n${code}`;
  if (userPrompt && userPrompt.trim()) {
    userContent += `\n\n---\n\n## 用户补充要求\n\n${userPrompt.trim()}`;
  }

  if (config.provider === "deepseek") {
    yield* analyzeWithDeepSeekStream(config, apiKey, userContent);
  } else {
    yield* analyzeWithAxiosStream(config, apiKey, userContent);
  }
}

async function* analyzeWithDeepSeekStream(
  config: ModelConfig,
  apiKey: string,
  userContent: string
): AsyncGenerator<StreamChunk, void, unknown> {
  const openai = new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: apiKey,
  });

  const stream = await openai.chat.completions.create({
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt.trim() },
      { role: "user", content: userContent },
    ],
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

async function* analyzeWithAxiosStream(
  config: ModelConfig,
  apiKey: string,
  userContent: string
): AsyncGenerator<StreamChunk, void, unknown> {
  const axiosConfig: any = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    timeout: 120000,
    responseType: "stream",
  };

  const proxyUrl = process.env.PROXY_URL;
  if (proxyUrl) {
    axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
  }

  const response = await axios.post(
    config.endpoint,
    {
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userContent },
      ],
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
          // 忽略解析错误
        }
      }
    }
  }

  yield { content: "", done: true };
}

export async function analyzeCode(
  code: string,
  modelId?: string,
  userPrompt?: string
): Promise<string> {
  let result = "";
  for await (const chunk of analyzeCodeStream(code, modelId, userPrompt)) {
    if (chunk.done) break;
    result += chunk.content;
  }
  return result;
}
