import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

export async function analyzeCode(code: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const proxyUrl = process.env.PROXY_URL;

  if (!apiKey) {
    throw new Error("服务器未配置 DEEPSEEK_API_KEY");
  }

  // 1. 配置网络与代理
  const axiosConfig: any = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    // 增加超时时间，以防大模型思考太久
    timeout: 30000,
  };

  if (proxyUrl) {
    axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
  }

  // 2. 设定 System Prompt (审计员人设)
  const systemPrompt = `
你是一个资深的硅谷前端架构师与安全专家，拥有极高的代码品味。
现在你需要对用户提交的代码进行严格的审查。

请按照以下结构输出你的审计报告：
### 🐞 1. 潜在 Bug & 安全隐患 (如果没有，请夸奖一下)
### ⚡ 2. 性能与优雅度优化建议
### 🛠️ 3. 重构代码演示 (仅针对核心问题部分)

语气要求：专业、犀利、一针见血，可以用 Markdown 格式高亮重点。
  `;

  // 3. 发送请求给 DeepSeek V3
  const response = await axios.post(
    "https://api.deepseek.com/chat/completions",
    {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `待审计代码如下：\n\n${code}` },
      ],
      // 审计代码需要严谨，调低 temperature 可以减少 AI 的幻觉
      temperature: 0.3,
    },
    axiosConfig,
  );

  // 返回生成的 Markdown 内容
  return response.data.choices[0].message.content;
}
