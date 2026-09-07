"use client";
import React, { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  collectFilesFromDataTransfer,
  collectFilesFromFileList,
  importFilesToProject,
  inferProjectName,
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
  /** 扫描文件阶段（从 DataTransfer 递归遍历文件夹树期间） */
  const [isScanning, setIsScanning] = useState(false);
  /** 导入阶段：filter（过滤文件）/ read（读取写入） */
  const [importStage, setImportStage] = useState<"filter" | "read">("filter");
  const dragCounter = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      // 让 React 先渲染 overlay 再开始繁重的导入逻辑
      // 否则 setIsImporting(true) 刚发出，importFilesToProject 就开始同步吃主线程
      await new Promise((r) => setTimeout(r, 0));

      try {
        const projectName = inferProjectName(files);
        const backend = getDefaultBackend();
        const importResult = await importFilesToProject(backend, files, projectName, {
          onFilterProgress: (processed, total) => {
            setImportStage("filter");
            setProgress({ processed, total, currentFile: "过滤中..." });
          },
          onProgress: (processed, total, currentFile) => {
            setImportStage("read");
            setProgress({ processed, total, currentFile });
          },
        });

        // 导入完成立即关闭 overlay 并通知父组件，拖拽和点击选择行为一致
        setIsImporting(false);
        setIsScanning(false);
        onImported(importResult);
      } catch (e) {
        console.error("导入失败:", e);
        alert(`导入失败: ${e}`);
        setIsImporting(false);
        setIsScanning(false);
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

      // 同步设好状态，overlay 立刻显示
      setIsScanning(true);
      setProgress({ processed: 0, total: 0, currentFile: "" });

      try {
        const files = await collectFilesFromDataTransfer(e.dataTransfer);
        // 扫描完切到导入态
        setIsScanning(false);
        setIsImporting(true);
        setProgress({ processed: 0, total: files.length, currentFile: "" });
        handleFiles(files);
      } catch (err) {
        console.error("扫描失败:", err);
        setIsScanning(false);
      }
    },
    [handleFiles],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      const fileList = collectFilesFromFileList(files);
      // 重置 input，允许重复选择同一文件
      e.target.value = "";

      // 同步设好状态，overlay 立刻显示
      const total = fileList.length;
      setIsImporting(true);
      setIsScanning(false);
      setProgress({ processed: 0, total, currentFile: "" });

      handleFiles(fileList);
    },
    [handleFiles],
  );

  const percent =
    progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  const showOverlay = isImporting || isScanning;

  // Overlay 用 Portal 挂到 document.body，完全脱离 dropzone 的 DOM 树
  // 这样 overlay 上的任何点击事件都不会冒泡到 dropzone
  const overlay = showOverlay && typeof document !== "undefined" ? createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div className="w-96 max-w-[90vw] bg-slate-900 border border-slate-700 rounded-xl p-6 shadow-2xl">
        {/* 标题：扫描中 / 过滤文件 / 写入文件 */}
        <div className="text-lg font-medium mb-4 flex items-center gap-2">
          {isScanning ? (
            <>
              <span className="inline-block w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-cyan-400">正在扫描文件夹...</span>
            </>
          ) : (
            <>
              <span className="inline-block w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-cyan-400">
                {importStage === "filter" ? "正在过滤文件..." : "正在写入项目..."}
              </span>
            </>
          )}
        </div>

        {isImporting ? (
          <div className="w-full">
            <div className="flex justify-between text-sm text-slate-400 mb-1">
              <span>
                {progress.processed} / {progress.total} 个文件
              </span>
              <span className="text-cyan-400 font-medium">{percent}%</span>
            </div>
            <div className="h-2.5 bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-150"
                style={{ width: `${percent}%` }}
              />
            </div>
            {progress.currentFile && (
              <div className="mt-2 text-xs text-slate-500 truncate" title={progress.currentFile}>
                📄 {progress.currentFile}
              </div>
            )}
          </div>
        ) : (
          isScanning && (
            <div className="text-sm text-slate-500">
              正在递归遍历文件夹结构，大项目可能需要几秒...
            </div>
          )
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      {/* 拖拽区：overlay 可见时物理屏蔽所有交互 */}
      <div
        className={`
          flex flex-col items-center justify-center gap-3 p-6 rounded-lg border-2 border-dashed
          transition-all select-none w-full h-full
          ${isDragging ? "border-cyan-400 bg-cyan-500/10" : "border-slate-600 hover:border-slate-500 bg-slate-900/50"}
          ${mode === "overlay" ? "fixed inset-4 z-50 bg-slate-950/95 backdrop-blur" : ""}
          ${showOverlay ? "pointer-events-none" : "cursor-pointer"}
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
      </div>

      {/* Portal 到 body 的 overlay，完全独立 DOM 树，事件不可能穿透到 dropzone */}
      {overlay}
    </>
  );
}
