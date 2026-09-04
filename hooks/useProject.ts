"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { getDefaultBackend } from "@/lib/storage";
import type { Project, FileNode } from "@/lib/storage";

export interface UseProjectReturn {
  projects: Project[];
  activeProjectId: string | null;
  activeProject: Project | null;
  isLoading: boolean;
  isHydrated: boolean;
  /** 创建并激活一个新项目 */
  createProject: (name: string) => Promise<Project>;
  /** 切换到某个项目 */
  selectProject: (id: string) => void;
  /** 删除项目 */
  deleteProject: (id: string) => Promise<void>;
  /** 刷新项目列表 */
  refreshProjects: () => Promise<void>;
  /** 读取当前项目根目录文件列表 */
  rootFiles: FileNode[];
}

const STORAGE_KEY = "ai-code-auditor:active-project";

export function useProject(): UseProjectReturn {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [rootFiles, setRootFiles] = useState<FileNode[]>([]);
  const backendRef = useRef(getDefaultBackend());

  // 初始加载：列出所有项目 + 恢复上次选中的
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const backend = backendRef.current;
      const list = await backend.listProjects();
      if (cancelled) return;
      setProjects(list);

      // 从 localStorage 恢复上次选中的项目
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(STORAGE_KEY);
      } catch {}
      if (saved && list.some((p) => p.id === saved)) {
        setActiveProjectId(saved);
      } else if (list.length > 0) {
        setActiveProjectId(list[0].id);
      }
      setIsHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 当 activeProject 变化时，读取根目录
  useEffect(() => {
    if (!activeProjectId) {
      setRootFiles([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const files = await backendRef.current.readDir(activeProjectId, "/");
        if (!cancelled) setRootFiles(files);
      } catch {
        if (!cancelled) setRootFiles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  // 持久化选中项
  useEffect(() => {
    if (!isHydrated) return;
    try {
      if (activeProjectId) {
        localStorage.setItem(STORAGE_KEY, activeProjectId);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {}
  }, [activeProjectId, isHydrated]);

  const refreshProjects = useCallback(async () => {
    const list = await backendRef.current.listProjects();
    setProjects(list);
    // 如果当前选中的项目没了，清空
    if (activeProjectId && !list.some((p) => p.id === activeProjectId)) {
      setActiveProjectId(list.length > 0 ? list[0].id : null);
    }
  }, [activeProjectId]);

  const createProject = useCallback(async (name: string) => {
    setIsLoading(true);
    try {
      const project = await backendRef.current.createProject(name);
      setProjects((prev) => [...prev, project]);
      setActiveProjectId(project.id);
      return project;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const selectProject = useCallback((id: string) => {
    setActiveProjectId(id);
  }, []);

  const deleteProject = useCallback(
    async (id: string) => {
      await backendRef.current.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      if (activeProjectId === id) {
        const remaining = projects.filter((p) => p.id !== id);
        setActiveProjectId(remaining.length > 0 ? remaining[0].id : null);
      }
    },
    [activeProjectId, projects],
  );

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  return {
    projects,
    activeProjectId,
    activeProject,
    isLoading,
    isHydrated,
    createProject,
    selectProject,
    deleteProject,
    refreshProjects,
    rootFiles,
  };
}
