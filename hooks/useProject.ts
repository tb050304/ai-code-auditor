"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { getDefaultBackend } from "@/lib/storage";
import type { Project, FileNode } from "@/lib/storage";
import { buildTree, type TreeNode } from "@/lib/storage/file-tree";
import { dirname, joinPath } from "@/lib/storage/path";
import {
  getSnapshotManager,
  getProjectSnapshotManager,
  type ProjectSnapshot,
  type ProjectIo,
  type SnapshotMeta,
  type FileSnapshot,
} from "@/lib/snapshots";
import {
  applyFixes,
  type AppliedFix,
  type IssueFix,
  type SkippedFix,
} from "@/lib/ast/fixer";

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
  /**
   * 写入文件。默认写前自动快照（source: manual-save）；
   * 传入 snapshotMeta 可自定义来源/描述（如 Diff 合并应用、全部回退）。
   */
  writeFile: (path: string, content: string, snapshotMeta?: SnapshotMeta) => Promise<FileNode>;
  /**
   * 对单文件应用一组自动修复提案：读当前内容 → applyFixes →
   * 有实际改动时以 auto-fix 来源写回（写前自动快照），并返回 before/after 供预览。
   * 无改动时不写盘、不快照。
   */
  applyFileAutoFixes: (
    path: string,
    fixes: IssueFix[],
  ) => Promise<{
    before: string;
    after: string;
    changed: boolean;
    applied: AppliedFix[];
    skipped: SkippedFix[];
  }>;
  mkdir: (path: string) => Promise<FileNode>;
  deleteNode: (path: string) => Promise<void>;
  renameNode: (oldPath: string, newName: string) => Promise<FileNode>;
  readFile: (path: string) => Promise<string>;

  // ---- 文件级快照 ----
  /** 列出某文件的历史快照（新 → 旧；不含 VFS 当前内容） */
  listFileHistory: (path: string) => Promise<FileSnapshot[]>;
  /**
   * 回滚某文件到指定快照。
   * 回滚前自动把当前内容存为 rollback 快照（内容相同则不动作）；
   * 文件已被删除时直接恢复该文件（无当前状态可存）。
   */
  restoreFileSnapshot: (snapshotId: string) => Promise<FileSnapshot>;

  // ---- 项目级快照 ----
  /** 给当前项目打版本标签 */
  createProjectSnapshot: (name: string, description?: string) => Promise<ProjectSnapshot>;
  /** 恢复项目到指定快照（恢复前自动备份当前状态） */
  restoreProjectSnapshot: (id: string) => Promise<ProjectSnapshot>;
  /** 列出当前项目的全部快照（新 → 旧） */
  listProjectSnapshots: () => Promise<ProjectSnapshot[]>;
  /** 删除单条项目快照 */
  deleteProjectSnapshot: (id: string) => Promise<void>;
}

const STORAGE_KEY = "ai-code-auditor:active-project";

export function useProject(): UseProjectReturn {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  // 文件树按项目打标存储：切换项目后，旧项目的树不会被误渲染
  const [treeState, setTreeState] = useState<{ projectId: string; tree: TreeNode | null } | null>(null);
  const backendRef = useRef(getDefaultBackend());
  // 仅暴露当前项目的树；项目为空或树属于其他项目时派生为 null（无需 effect 同步清空）
  const fileTree = activeProjectId && treeState?.projectId === activeProjectId ? treeState.tree : null;

  // 刷新单个项目的文件树
  const loadFileTree = useCallback(async (projectId: string) => {
    try {
      const allFiles = await backendRef.current.listAllFiles(projectId);
      setTreeState({ projectId, tree: buildTree(allFiles) });
    } catch (e) {
      console.error("加载文件树失败:", e);
      setTreeState({ projectId, tree: null });
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

  // 当 activeProject 变化时，加载完整文件树（无项目时 fileTree 派生为 null）
  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    (async () => {
      const allFiles = await backendRef.current.listAllFiles(activeProjectId);
      if (cancelled) return;
      setTreeState({ projectId: activeProjectId, tree: buildTree(allFiles) });
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

      // 项目删除后清理其全部快照（文件级 + 项目级，尽力而为，避免孤儿数据永久占用空间）
      try {
        await getSnapshotManager().purgeProject(id);
      } catch (e) {
        console.error("清理文件快照失败:", e);
      }
      try {
        await getProjectSnapshotManager().purgeProject(id);
      } catch (e) {
        console.error("清理项目快照失败:", e);
      }

      setProjects((prev) => prev.filter((p) => p.id !== id));
      if (activeProjectId === id) {
        const remaining = projects.filter((p) => p.id !== id);
        setActiveProjectId(remaining.length > 0 ? remaining[0].id : null);
      }
    },
    [activeProjectId, projects],
  );

  const writeFile = useCallback(
    async (path: string, content: string, snapshotMeta?: SnapshotMeta) => {
      if (!activeProjectId) throw new Error("无活动项目");
      const normalized = joinPath(path);

      // 自动快照：覆盖写入前保存旧内容（尽力而为，失败不阻塞保存）
      try {
        const oldContent = await backendRef.current.readFile(activeProjectId, normalized);
        if (oldContent !== content) {
          await getSnapshotManager().captureBeforeWrite(
            activeProjectId,
            normalized,
            oldContent,
            snapshotMeta ?? { source: "manual-save", description: "保存前自动快照" },
          );
        }
      } catch {
        // 文件不存在（新建）或快照存储异常：跳过快照，正常写入
      }

      const node = await backendRef.current.writeFile(activeProjectId, normalized, content);
      await refreshFileTree();
      return node;
    },
    [activeProjectId, refreshFileTree],
  );

  const applyFileAutoFixes = useCallback(
    async (path: string, fixes: IssueFix[]) => {
      if (!activeProjectId) throw new Error("无活动项目");
      const normalized = joinPath(path);
      const before = await backendRef.current.readFile(activeProjectId, normalized);
      const result = applyFixes(before, fixes);
      const changed = result.code !== before;
      if (changed) {
        // writeFile 写前自动快照；显式标记 auto-fix 来源与命中条数
        await writeFile(
          normalized,
          result.code,
          { source: "auto-fix", description: `自动修复应用 ${result.applied.length} 处` },
        );
      }
      return {
        before,
        after: result.code,
        changed,
        applied: result.applied,
        skipped: result.skipped,
      };
    },
    [activeProjectId, writeFile],
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

      // 快照历史跟随文件迁移（尽力而为，失败不影响重命名）
      try {
        await getSnapshotManager().migratePath(activeProjectId, oldPath, newPath);
      } catch (e) {
        console.error("迁移文件快照历史失败:", e);
      }

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

  // ---- 文件级快照 ----

  const listFileHistory = useCallback(
    async (path: string) => {
      if (!activeProjectId) return [];
      const normalized = joinPath(path);
      // store 升序（旧 → 新），时间线展示用新 → 旧
      const list = await getSnapshotManager().listHistory(activeProjectId, normalized);
      return [...list].reverse();
    },
    [activeProjectId],
  );

  const restoreFileSnapshot = useCallback(
    async (snapshotId: string) => {
      if (!activeProjectId) throw new Error("无活动项目");
      const manager = getSnapshotManager();
      const target = await manager.getSnapshot(snapshotId);
      if (!target) throw new Error("快照不存在");

      // 读取当前内容；文件已被删除时视为无当前状态（回滚 = 恢复文件）
      let current: string | null = null;
      try {
        current = await backendRef.current.readFile(activeProjectId, target.path);
      } catch {
        current = null;
      }

      // 内容相同无需回滚
      if (current === target.content) return target;

      // 回滚也是一次修改：先把当前状态存起来，用户可以再滚回来
      if (current !== null) {
        await manager.captureBeforeWrite(activeProjectId, target.path, current, {
          source: "rollback",
          description: "回滚前自动快照",
        });
      }

      // 直接写 VFS（不走 useProject.writeFile，避免再触发一次 manual-save 快照）
      await backendRef.current.writeFile(activeProjectId, target.path, target.content);
      await refreshFileTree();
      return target;
    },
    [activeProjectId, refreshFileTree],
  );

  // ---- 项目级快照 ----

  /** 项目快照管理器访问 VFS 的 io 适配层 */
  const projectIo = useCallback(async (): Promise<ProjectIo> => {
    const projectId = activeProjectId;
    if (!projectId) throw new Error("无活动项目");
    const backend = backendRef.current;
    return {
      listFiles: async () =>
        (await backend.listAllFiles(projectId)).map((n) => n.path),
      readFile: (path) => backend.readFile(projectId, path),
      deleteFile: (path) => backend.delete(projectId, path),
      writeFiles: (items) => backend.batchWrite(projectId, items).then(() => undefined),
    };
  }, [activeProjectId]);

  const createProjectSnapshot = useCallback(
    async (name: string, description?: string) => {
      const io = await projectIo();
      return getProjectSnapshotManager().createSnapshot(activeProjectId!, {
        name: name.trim() || "未命名快照",
        description,
        source: "manual",
      }, io);
    },
    [activeProjectId, projectIo],
  );

  const restoreProjectSnapshot = useCallback(
    async (id: string) => {
      const io = await projectIo();
      const result = await getProjectSnapshotManager().restore(activeProjectId!, id, io);
      if (!result) throw new Error("快照不存在");
      await refreshFileTree();
      return result.snapshot;
    },
    [activeProjectId, projectIo, refreshFileTree],
  );

  const listProjectSnapshots = useCallback(async () => {
    if (!activeProjectId) return [];
    return getProjectSnapshotManager().listSnapshots(activeProjectId);
  }, [activeProjectId]);

  const deleteProjectSnapshot = useCallback(
    async (id: string) => {
      await getProjectSnapshotManager().deleteSnapshot(id);
    },
    [],
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
    applyFileAutoFixes,
  mkdir,
  deleteNode,
  renameNode,
  readFile,
  listFileHistory,
  restoreFileSnapshot,
  createProjectSnapshot,
  restoreProjectSnapshot,
  listProjectSnapshots,
  deleteProjectSnapshot,
  };
}
