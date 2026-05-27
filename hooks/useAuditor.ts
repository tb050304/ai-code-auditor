import { useState, useCallback, useRef, useEffect } from "react";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export function useAuditor() {
  const [auditResult, setAuditResult] = useState<string>("等待审计指令...");
  const [isAuditing, setIsAuditing] = useState<boolean>(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [isStopped, setIsStopped] = useState<boolean>(false);
  const isModelsFetched = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchModels = useCallback(async () => {
    if (isModelsFetched.current) return;
    
    isModelsFetched.current = true;
    
    try {
      const response = await fetch("/api/audit");
      const availableModels = await response.json();
      setModels(availableModels);
      if (availableModels.length > 0 && !selectedModel) {
        setSelectedModel(availableModels[0].id);
      }
    } catch (error) {
      console.error("Failed to fetch models:", error);
      isModelsFetched.current = false;
    }
  }, [selectedModel]);

  useEffect(() => {
    fetchModels();
  }, []);

  const stopAudit = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsStopped(true);
      setIsAuditing(false);
      setAuditResult((prev) => prev + "\n\n---\n\n**⏹️ 用户已停止输出**");
    }
  }, []);

  const runAudit = async (code: string, userPrompt?: string, modelId?: string) => {
    if (!code.trim()) return;

    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    setIsAuditing(true);
    setIsStopped(false);
    setAuditResult("");

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          code, 
          model: modelId || selectedModel,
          userPrompt 
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulatedResult = "";

      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          accumulatedResult += chunk;
          setAuditResult(accumulatedResult);
        }
      }
    } catch (error: any) {
      if (error.name === "AbortError") {
        console.log("请求被取消");
        return;
      }
      console.error("Fetch error:", error);
      setAuditResult(
        (prev) => prev + "\n\n**请求失败，请检查网络或控制台报错。**"
      );
    } finally {
      setIsAuditing(false);
      abortControllerRef.current = null;
    }
  };

  return {
    auditResult,
    isAuditing,
    isStopped,
    runAudit,
    stopAudit,
    models,
    selectedModel,
    setSelectedModel,
  };
}
