export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  apiKeyEnv: string;
  endpoint: string;
  model: string;
  default: boolean;
}

export const modelConfigs: ModelConfig[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    provider: "deepseek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    default: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    provider: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    default: false,
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    provider: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-3-sonnet-20240229",
    default: false,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    provider: "gemini",
    apiKeyEnv: "GEMINI_API_KEY",
    endpoint: "https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent",
    model: "gemini-pro",
    default: false,
  },
];

export function getModelConfig(modelId: string): ModelConfig | undefined {
  return modelConfigs.find((config) => config.id === modelId);
}

export function getDefaultModelConfig(): ModelConfig {
  return modelConfigs.find((config) => config.default) || modelConfigs[0];
}

export function getAvailableModels(): ModelConfig[] {
  return modelConfigs.filter((config) => {
    const apiKey = process.env[config.apiKeyEnv as keyof typeof process.env];
    return apiKey && apiKey.trim() !== "";
  });
}
