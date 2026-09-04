"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { getDefaultBackend } from "@/lib/storage";
import type { Project, FileNode } from "@/lib/storage";
import { buildTree, type TreeNode } from "@/lib/storage/file-tree";
import { dirname, joinPath } from "@/lib/storage/path";

export interface UseProjectReturn {
  projects: Project[];
  activeProjectId: string | null;
  activeProject: Project | null;
  isLoading: boolean;
  isHydrated: boolean;
  createProject: (name: string) => Promise<Project>;
  selectProject: (id: string) => void;
  deleteProject: (id: string) => Promise<void>;
  refreshProjects: () => Promise<void>;

  // ---- 文件树 ----
  /** 当前项目的完整文件树（根节点） */
  fileTree: TreeNode | null;
  /** 刷新当前项目的整个文件树 */
  refreshFileTree: () => Promise<void>;

  // ---- 文件操作 ----
  writeFile: (path: string, content: string) => Promise<FileNode>;
  mkdir: (path: string) => Promise<FileNode>;
  deleteNode: (path: string) => Promise<void>;
  renameNode: (oldPath: string, newName: string) => Promise<FileNode>;
  readFile: (path: string) => Promise<string>;
}

const STORAGE_KEY = "ai-code-auditor:active-project";

export function useProject(): UseProjectReturn {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [fileTree, setFileTree] = useState<TreeNode | null>(null);
  const backendRef = useRef(getDefaultBackend());

  // 刷新单个项目的文件树
  const loadFileTree = useCallback(async (projectId: string) => {
    try {
      const allFiles = await backendRef.current.listAllFiles(projectId);
      const tree = buildTree(allFiles);
      setFileTree(tree);
    } catch (e) {
      console.error("加载文件树失败:", e);
      setFileTree(null);
    }
  }, []);

  // 初始加载：列出所有项目 + 恢复上次选中的
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const backend = backendRef.current;
      const list = await backend.listProjects();
      if (cancelled) return;
      setProjects(list);

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

  // 当 activeProject 变化时，加载完整文件树
  useEffect(() => {
    if (!activeProjectId) {
      setFileTree(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const allFiles = await backendRef.current.listAllFiles(activeProjectId);
      if (cancelled) return;
      const tree = buildTree(allFiles);
      setFileTree(tree);
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
    if (activeProjectId && !list.some((p) => p.id === activeProjectId)) {
      setActiveProjectId(list.length > 0 ? list[0].id : null);
    }
  }, [activeProjectId]);

  const refreshFileTree = useCallback(async () => {
    if (!activeProjectId) return;
    await loadFileTree(activeProjectId);
  }, [activeProjectId, loadFileTree]);

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

  const writeFile = useCallback(
    async (path: string, content: string) => {
      if (!activeProjectId) throw new Error("无活动项目");
      const normalized = joinPath(path);
      const node = await backendRef.current.writeFile(activeProjectId, normalized, content);
      await refreshFileTree();
      return node;
    },
    [activeProjectId, refreshFileTree],
  );

  const mkdir = useCallback(
    async (path: string) => {
      if (!activeProjectId) throw new Error("无活动项目");
      const normalized = joinPath(path);
      const node = await backendRef.current.mkdir(activeProjectId, normalized);
      await refreshFileTree();
      return node;
    },
    [activeProjectId, refreshFileTree],
  );

  const deleteNode = useCallback(
    async (path: string) => {
      if (!activeProjectId) throw new Error("无活动项目");
      const normalized = joinPath(path);
      await backendRef.current.delete(activeProjectId, normalized);
      await refreshFileTree();
    },
    [activeProjectId, refreshFileTree],
  );

  const renameNode = useCallback(
    async (oldPath: string, newName: string) => {
      if (!activeProjectId) throw new Error("无活动项目");
      const parent = dirname(oldPath);
      const newPath = joinPath(parent, newName);
      const node = await backendRef.current.rename(activeProjectId, oldPath, newPath);
      await refreshFileTree();
      return node;
    },
    [activeProjectId, refreshFileTree],
  );

  const readFile = useCallback(
    async (path: string) => {
      if (!activeProjectId) throw new Error("无活动项目");
      return backendRef.current.readFile(activeProjectId, joinPath(path));
    },
    [activeProjectId],
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
    fileTree,
    refreshFileTree,
    writeFile,
    mkdir,
    deleteNode,
    renameNode,
    readFile,
  };
}
