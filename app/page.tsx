"use client";
import React, { useState } from "react";
import CodeEditor from "@/components/editor/CodeEditor";
import AgentConsole from "@/components/console/AgentConsole";
import { useAuditor } from "@/hooks/useAuditor";

export default function IDEPage() {
  const [code, setCode] = useState<string>(
    "// 请输入需要审计的 JavaScript/TypeScript 代码...\n\nfunction calculate(a, b) {\n  var result = a + b;\n  return result\n}",
  );

  // 引入我们刚刚封装的 Hook
  const { auditResult, isAuditing, runAudit } = useAuditor();

  return (
    <main className="flex h-screen w-full bg-slate-950 text-slate-300">
      <CodeEditor
        value={code}
        onChange={(val) => val !== undefined && setCode(val)}
      />

      <AgentConsole
        auditResult={auditResult}
        isAuditing={isAuditing}
        // 将编辑器当前的代码直接传给 runAudit
        onRunAudit={() => runAudit(code)}
      />
    </main>
  );
}
