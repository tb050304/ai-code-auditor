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
