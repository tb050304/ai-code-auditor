import { useState } from "react";

export function useAuditor() {
  const [auditResult, setAuditResult] = useState<string>("等待审计指令...");
  const [isAuditing, setIsAuditing] = useState<boolean>(false);

  const runAudit = async (code: string) => {
    if (!code.trim()) return;

    setIsAuditing(true);
    setAuditResult(""); // 清空之前的结果

    try {
      const response = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // 关键步骤：获取流式 Reader
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let accumulatedResult = "";

      if (reader) {
        // 只要没读取完，就一直循环读取
        while (!done) {
          const { value, done: readerDone } = await reader.read();
          done = readerDone;
          if (value) {
            // 将读取到的二进制片段解码为文本
            const chunk = decoder.decode(value, { stream: true });
            accumulatedResult += chunk;
            // 实时更新状态，触发 React 重新渲染
            setAuditResult(accumulatedResult);
          }
        }
      }
    } catch (error) {
      console.error("Fetch error:", error);
      setAuditResult(
        (prev) => prev + "\n\n**请求失败，请检查网络或控制台报错。**",
      );
    } finally {
      setIsAuditing(false);
    }
  };

  return { auditResult, isAuditing, runAudit };
}
