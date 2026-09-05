"use client";
import { useState, useCallback, useRef } from "react";
import { extname, basename } from "@/lib/storage/path";
import { inferMonacoLanguage } from "@/lib/monaco-lang";

export interface EditorTab {
  /** 文件路径（唯一标识） */
  path: string;
  /** 显示名称（文件名） */
  name: string;
  /** Monaco 语言 */
  language: string;
  /** 当前编辑器内容 */
  content: string;
  /** 从 VFS 读取的原始内容（用于判断是否有修改） */
  originalContent: string;
}

export interface UseEditorTabsReturn {
  tabs: EditorTab[];
  activeTabPath: string | null;
  activeTab: EditorTab | null;
  /** 打开一个文件（已存在则激活，不存在则添加并激活） */
  openTab: (path: string, content: string) => void;
  /** 关闭一个 Tab，返回是否成功关闭（有未保存且用户取消则返回 false） */
  closeTab: (path: string) => boolean;
  /** 激活某个 Tab */
  activateTab: (path: string) => void;
  /** 更新当前激活 Tab 的内容（编辑器 onChange 时调用） */
  updateActiveContent: (content: string) => void;
  /** 保存当前激活 Tab 到 VFS（需要外部提供 save 函数） */
  saveActiveTab: (saveFn: (path: string, content: string) => Promise<void> | void) => Promise<void>;
  /** 判断某个 Tab 是否有未保存修改 */
  isDirty: (path: string) => boolean;
  /** 关闭其他 Tab */
  closeOtherTabs: (path: string) => void;
  /** 关闭所有 Tab（有未保存的会提示，全部取消则返回 false） */
  closeAllTabs: () => boolean;
  /** 外部更新某个 tab 的内容（比如文件被重命名/删除时） */
  renameTab: (oldPath: string, newPath: string) => void;
  removeTab: (path: string) => void;
}

export function useEditorTabs(): UseEditorTabsReturn {
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);

  const openTab = useCallback((path: string, content: string) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.path === path);
      if (existing) {
        // 已经打开过，直接激活
        setActiveTabPath(path);
        return prev;
      }
      const name = basename(path);
      const language = inferMonacoLanguage(path);
      const newTab: EditorTab = {
        path,
        name,
        language,
        content,
        originalContent: content,
      };
      setActiveTabPath(path);
      return [...prev, newTab];
    });
  }, []);

  const activateTab = useCallback((path: string) => {
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) {
        setActiveTabPath(path);
      }
      return prev;
    });
  }, []);

  const closeTab = useCallback(
    (path: string): boolean => {
      let shouldClose = true;

      setTabs((prev) => {
        const target = prev.find((t) => t.path === path);
        if (!target) return prev;

        const isDirty = target.content !== target.originalContent;
        if (isDirty) {
          if (!confirm(`"${target.name}" 有未保存的修改，确定关闭吗？`)) {
            shouldClose = false;
            return prev;
          }
        }

        const newTabs = prev.filter((t) => t.path !== path);

        // 如果关闭的是当前激活的，切换到相邻的
        if (activeTabPath === path) {
          const idx = prev.findIndex((t) => t.path === path);
          if (newTabs.length === 0) {
            setActiveTabPath(null);
          } else {
            const nextIdx = Math.min(idx, newTabs.length - 1);
            setActiveTabPath(newTabs[nextIdx].path);
          }
        }

        return newTabs;
      });

      return shouldClose;
    },
    [activeTabPath],
  );

  const updateActiveContent = useCallback((content: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.path === activeTabPath ? { ...t, content } : t)),
    );
  }, [activeTabPath]);

  const saveActiveTab = useCallback(
    async (saveFn: (path: string, content: string) => Promise<void> | void) => {
      if (!activeTabPath) return;
      const tab = tabs.find((t) => t.path === activeTabPath);
      if (!tab) return;
      await saveFn(tab.path, tab.content);
      setTabs((prev) =>
        prev.map((t) =>
          t.path === activeTabPath ? { ...t, originalContent: t.content } : t,
        ),
      );
    },
    [activeTabPath, tabs],
  );

  const isDirty = useCallback(
    (path: string) => {
      const tab = tabs.find((t) => t.path === path);
      return tab ? tab.content !== tab.originalContent : false;
    },
    [tabs],
  );

  const closeOtherTabs = useCallback((path: string) => {
    setTabs((prev) => {
      const target = prev.find((t) => t.path === path);
      if (!target) return prev;
      setActiveTabPath(path);
      return [target];
    });
  }, []);

  const closeAllTabs = useCallback((): boolean => {
    // 检查有没有脏的 tab，一个个确认
    const dirtyTabs = tabs.filter((t) => t.content !== t.originalContent);
    for (const t of dirtyTabs) {
      if (!confirm(`"${t.name}" 有未保存的修改，确定关闭吗？`)) {
        return false;
      }
    }
    setTabs([]);
    setActiveTabPath(null);
    return true;
  }, [tabs]);

  const renameTab = useCallback((oldPath: string, newPath: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.path !== oldPath) return t;
        return {
          ...t,
          path: newPath,
          name: basename(newPath),
          language: inferMonacoLanguage(newPath),
        };
      }),
    );
    if (activeTabPath === oldPath) {
      setActiveTabPath(newPath);
    }
  }, [activeTabPath]);

  const removeTab = useCallback(
    (path: string) => {
      // 强制移除（不提示），用于文件被删除的情况
      setTabs((prev) => {
        const newTabs = prev.filter((t) => t.path !== path);
        if (activeTabPath === path) {
          if (newTabs.length === 0) {
            setActiveTabPath(null);
          } else {
            const idx = prev.findIndex((t) => t.path === path);
            const nextIdx = Math.min(idx, newTabs.length - 1);
            setActiveTabPath(newTabs[nextIdx].path);
          }
        }
        return newTabs;
      });
    },
    [activeTabPath],
  );

  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null;

  return {
    tabs,
    activeTabPath,
    activeTab,
    openTab,
    closeTab,
    activateTab,
    updateActiveContent,
    saveActiveTab,
    isDirty,
    closeOtherTabs,
    closeAllTabs,
    renameTab,
    removeTab,
  };
}
