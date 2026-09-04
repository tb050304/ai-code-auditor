"use client";
import React, { useState, useRef, useCallback } from "react";
import {
  collectFilesFromDataTransfer,
  collectFilesFromFileList,
  importFilesToProject,
  inferProjectName,
  formatSize,
} from "@/lib/storage/import";
import { getDefaultBackend } from "@/lib/storage";
import type { ImportResult } from "@/lib/storage/import";

interface FileDropzoneProps {
  /** 导入成功回调 */
  onImported: (result: ImportResult) => void;
  /** 展示模式：overlay（覆盖层）或 inline（内联区块） */
  mode?: "overlay" | "inline";
}

export default function FileDropzone({ onImported, mode = "inline" }: FileDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState({ processed: 0, total: 0, currentFile: "" });
  const [result, setResult] = useState<ImportResult | null>(null);
  const dragCounter = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setIsImporting(true);
      setProgress({ processed: 0, total: files.length, currentFile: "" });
      setResult(null);

      try {
        const projectName = inferProjectName(files);
        const backend = getDefaultBackend();
        const importResult = await importFilesToProject(backend, files, projectName, {
          onProgress: (processed, total, currentFile) =>
            setProgress({ processed, total, currentFile }),
        });
        setResult(importResult);
        onImported(importResult);
      } catch (e) {
        console.error("导入失败:", e);
        alert(`导入失败: ${e}`);
      } finally {
        setIsImporting(false);
      }
    },
    [onImported],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      setIsDragging(false);
      dragCounter.current = 0;
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounter.current = 0;

      const files = await collectFilesFromDataTransfer(e.dataTransfer);
      handleFiles(files);
    },
    [handleFiles],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      const fileList = collectFilesFromFileList(files);
      handleFiles(fileList);
      // 重置 input，允许重复选择同一文件
      e.target.value = "";
    },
    [handleFiles],
  );

  const percent =
    progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  const content = (
    <div
      className={`
        flex flex-col items-center justify-center gap-3 p-6 rounded-lg border-2 border-dashed
        transition-all cursor-pointer select-none
        ${isDragging ? "border-cyan-400 bg-cyan-500/10" : "border-slate-600 hover:border-slate-500 bg-slate-900/50"}
        ${mode === "overlay" ? "fixed inset-4 z-50 bg-slate-950/95 backdrop-blur" : ""}
      `}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        // @ts-ignore - webkitdirectory 是非标准属性
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={handleFileInput}
      />

      {isImporting ? (
        <>
          <div className="text-cyan-400 text-lg font-medium">正在导入...</div>
          <div className="w-full max-w-md">
            <div className="flex justify-between text-sm text-slate-400 mb-1">
              <span>
                {progress.processed} / {progress.total} 个文件
              </span>
              <span>{percent}%</span>
            </div>
            <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-150"
                style={{ width: `${percent}%` }}
              />
            </div>
            {progress.currentFile && (
              <div className="mt-2 text-xs text-slate-500 truncate text-center">
                {progress.currentFile}
              </div>
            )}
          </div>
        </>
      ) : result ? (
        <>
          <div className="text-emerald-400 text-lg font-medium">✓ 导入完成</div>
          <div className="text-sm text-slate-400 text-center space-y-1">
            <div>
              成功导入 <span className="text-emerald-400 font-medium">{result.importedFiles}</span> 个文件，
              跳过 <span className="text-slate-500">{result.skippedFiles}</span> 个
            </div>
            <div>总大小：{formatSize(result.totalSize)}</div>
          </div>
        </>
      ) : (
        <>
          <div className="text-4xl">📁</div>
          <div className="text-lg font-medium text-slate-200">拖拽文件夹到这里</div>
          <div className="text-sm text-slate-500">
            或 <span className="text-cyan-400 underline">点击选择文件夹</span>
          </div>
          <div className="text-xs text-slate-600 mt-1">
            自动过滤 node_modules / .git / 二进制文件等
          </div>
        </>
      )}
    </div>
  );

  return content;
}
