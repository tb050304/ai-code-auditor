"use client";
import React from "react";
import Editor from "@monaco-editor/react";

interface CodeEditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
}

export default function CodeEditor({ value, onChange }: CodeEditorProps) {
  return (
    <section className="flex-1 flex flex-col border-r border-slate-800">
      <header className="px-4 py-3 bg-slate-900 border-b border-slate-800 flex justify-between items-center">
        <h1 className="text-sm font-bold text-cyan-400">AI Code Auditor</h1>
        <span className="text-xs text-slate-500 bg-slate-800 px-2 py-1 rounded">
          Language: JavaScript
        </span>
      </header>

      <div className="flex-1">
        <Editor
          height="100%"
          defaultLanguage="javascript"
          theme="vs-dark"
          value={value}
          onChange={onChange}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            wordWrap: "on",
          }}
        />
      </div>
    </section>
  );
}
