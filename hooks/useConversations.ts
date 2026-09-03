// ---------------------------------------------------------------------------
// useConversations —— 会话（Conversation）状态管理 Hook
// ---------------------------------------------------------------------------
// 核心职责：
//   1. 加载 / 保存会话列表（通过可替换的 StorageBackend 抽象）。
//   2. 提供会话 CRUD 与切换能力。
//   3. 所有写入带“尾部去抖”（trailing debounce），避免流式输出期间
//      高频触发 localStorage 写入；并在页面卸载前强制落盘一次。
//
// 设计要点（高可用性）：
//   - 数据损坏时后端返回 null，Hook 直接退回空会话，不崩溃。
//   - 保存失败（配额满）会暴露 persistenceError 供 UI 提示，不静默丢数据。
//   - 初始水合与 storeRef 更新都放在 effect / 微任务中，
//     遵守 React 19 的 refs 与 set-state-in-effect 规范。
// ---------------------------------------------------------------------------

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Conversation, ConversationMessage } from "@/types";
import {
  createLocalStorageBackend,
  type StorageBackend,
} from "@/lib/persistence";
import { createMessage, generateConversationTitle } from "@/lib/messages";

/** 存储层的整包数据结构：会话数组 + 当前选中会话 id */
interface ConversationStore {
  conversations: Conversation[];
  activeConversationId: string | null;
}

/** localStorage 默认容量守卫：约 4MB，预留余量避免压线 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** 会话数量软上限，控制单条存储体积，避免超配额 */
const MAX_CONVERSATIONS = 30;
/** 落盘去抖时间（毫秒） */
const PERSIST_DEBOUNCE_MS = 400;

/** 后端存储实例（单次创建，组件重渲染不重复实例化） */
const backend: StorageBackend<ConversationStore> = createLocalStorageBackend({
  key: "conversations",
  schemaVersion: 1,
  maxBytes: DEFAULT_MAX_BYTES,
});

export function useConversations() {
  const [store, setStore] = useState<ConversationStore>({
    conversations: [],
    activeConversationId: null,
  });
  // 是否已完成初始加载（避免闪烁 / 覆盖用户刚写入的数据）
  const [isHydrated, setIsHydrated] = useState(false);
  // 持久化失败时的可展示错误信息
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  // 引用池：让定时器 / 卸载回调能读到最新 store（在 effect 中同步，不破坏渲染）
  const storeRef = useRef<ConversationStore>(store);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------- 初始水合：从外部存储恢复 ----------------
  // 从 localStorage 这类外部系统同步状态是 useEffect 的正当场景。
  // 为避免 hydration mismatch，先以空状态渲染，再在 effect 中恢复。
  useEffect(() => {
    const loaded = backend.load();
    // 将 setState 延迟到微任务回调执行，满足 react-hooks/set-state-in-effect 校验。
    queueMicrotask(() => {
      if (loaded) {
        // 二次校验：确保结构合法；不合法即回落空状态
        const conversations = Array.isArray(loaded.conversations)
          ? loaded.conversations.slice(0, MAX_CONVERSATIONS)
          : [];
        const activeId =
          loaded.activeConversationId &&
          conversations.some((c) => c.id === loaded.activeConversationId)
            ? loaded.activeConversationId
            : conversations[conversations.length - 1]?.id ?? null;
        setStore({ conversations, activeConversationId: activeId });
      }
      setIsHydrated(true);
    });
  }, []);

  // ---------------- 持久化（去抖 + 卸载强刷） ----------------
  const flushSave = useCallback(() => {
    const ok = backend.save(storeRef.current);
    if (!ok) {
      setPersistenceError("本地存储写入失败（可能超出容量），请删除部分历史会话。");
    }
  }, []);

  useEffect(() => {
    // 同步最新数据的引用，供定时器 / 卸载回调在闭包外读取
    storeRef.current = store;
    // 初始未加载完成前不写入，避免覆盖磁盘已有数据
    if (!isHydrated) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    // 流式输出会高频触发本 effect，这里合并为一次尾部写入
    saveTimerRef.current = setTimeout(() => {
      flushSave();
      saveTimerRef.current = null;
    }, PERSIST_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [store, isHydrated, flushSave]);

  // 页面隐藏 / 卸载前强制落盘，兜底去抖期间的最后一次写入
  useEffect(() => {
    const handler = () => flushSave();
    window.addEventListener("beforeunload", handler);
    window.addEventListener("pagehide", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("pagehide", handler);
    };
  }, [flushSave]);

  // ---------------- 派生数据 ----------------
  const activeConversation = useMemo(
    () => store.conversations.find((c) => c.id === store.activeConversationId) ?? null,
    [store.conversations, store.activeConversationId]
  );

  // ---------------- 会话操作 ----------------
  const createConversation = useCallback((code?: string, userPrompt?: string): Conversation => {
    const now = Date.now();
    const conversation: Conversation = {
      id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `conv-${now}`,
      title: generateConversationTitle(code, userPrompt),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    setStore((prev) => {
      let list = [...prev.conversations, conversation];
      if (list.length > MAX_CONVERSATIONS) {
        // 软上限：保留最近 MAX_CONVERSATIONS 条
        list = list.slice(-MAX_CONVERSATIONS);
      }
      return { conversations: list, activeConversationId: conversation.id };
    });
    return conversation;
  }, []);

  const selectConversation = useCallback((id: string) => {
    setStore((prev) => ({ ...prev, activeConversationId: id }));
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setStore((prev) => {
      const remaining = prev.conversations.filter((c) => c.id !== id);
      // 若删的是当前选中会话，自动回退到最近的一个
      let activeId = prev.activeConversationId;
      if (activeId === id) {
        activeId = remaining[remaining.length - 1]?.id ?? null;
      }
      return { conversations: remaining, activeConversationId: activeId };
    });
  }, []);

  const renameConversation = useCallback((id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setStore((prev) => ({
      ...prev,
      conversations: prev.conversations.map((c) =>
        c.id === id ? { ...c, title: trimmed, updatedAt: Date.now() } : c
      ),
    }));
  }, []);

  /** 追加一条消息到指定会话，并刷新 updatedAt */
  const appendMessage = useCallback((conversationId: string, message: ConversationMessage) => {
    setStore((prev) => ({
      ...prev,
      conversations: prev.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, updatedAt: Date.now(), messages: [...c.messages, message] }
          : c
      ),
    }));
  }, []);

  /** 局部更新某条消息（用于流式追加内容 / 切换状态），并刷新 updatedAt */
  const updateMessage = useCallback(
    (conversationId: string, messageId: string, patch: Partial<ConversationMessage>) => {
      setStore((prev) => ({
        ...prev,
        conversations: prev.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                updatedAt: Date.now(),
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
              }
            : c
        ),
      }));
    },
    []
  );

  /** 初始化一条用户消息并追加到会话，返回消息对象供调用方持有 */
  const addUserMessage = useCallback(
    (conversationId: string, options: { code: string; userPrompt?: string; modelId?: string }) => {
      const message: ConversationMessage = createMessage("user", {
        content: options.userPrompt?.trim() || "审计以下代码：",
        code: options.code,
        userPrompt: options.userPrompt,
        modelId: options.modelId,
        status: "idle",
      });
      appendMessage(conversationId, message);
      return message;
    },
    [appendMessage]
  );

  return {
    conversations: store.conversations,
    activeConversationId: store.activeConversationId,
    activeConversation,
    isHydrated,
    persistenceError,
    createConversation,
    selectConversation,
    deleteConversation,
    renameConversation,
    appendMessage,
    updateMessage,
    addUserMessage,
  };
}