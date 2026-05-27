/**
 * AST 静态分析 Hook
 */

import { useState, useCallback } from "react";

export interface Issue {
  id: string;
  type: "security" | "best-practice" | "performance" | "maintainability" | "typescript";
  severity: "error" | "warning" | "info";
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  suggestion?: string;
}

export interface ASTAnalysisResult {
  success: boolean;
  totalIssues: number;
  highSeverity: number;
  duration: number;
  issues: Issue[];
  report: string;
}

export function useASTAnalysis() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<ASTAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const analyzeCode = useCallback(async (code: string) => {
    if (!code.trim()) return;

    setIsAnalyzing(true);
    setError(null);

    try {
      const response = await fetch("/api/ast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.success) {
        setAnalysisResult({
          success: true,
          totalIssues: data.result.totalIssues,
          highSeverity: data.result.highSeverity,
          duration: data.result.duration,
          issues: data.issues,
          report: data.report,
        });
      } else {
        throw new Error(data.error || "分析失败");
      }
    } catch (err: any) {
      console.error("AST analysis error:", err);
      setError(err.message || "分析失败");
      setAnalysisResult(null);
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  const clearResult = useCallback(() => {
    setAnalysisResult(null);
    setError(null);
  }, []);

  return {
    isAnalyzing,
    analysisResult,
    error,
    analyzeCode,
    clearResult,
  };
}
