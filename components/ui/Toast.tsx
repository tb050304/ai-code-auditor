"use client";
/**
 * Toast 通知系统（Day 28）
 *
 * 替代 alert() 的轻量级通知：
 *   - 右上角堆叠展示
 *   - 3 秒后自动消失（error 5 秒）
 *   - 支持手动关闭
 *   - 全局单例，任意组件可通过 useToast() 发送
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  toasts: Toast[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastKind, string> = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  error: "❌",
};

const STYLES: Record<ToastKind, string> = {
  info: "border-slate-600 bg-slate-800 text-slate-200",
  success: "border-emerald-600 bg-emerald-900/80 text-emerald-200",
  warning: "border-amber-600 bg-amber-900/80 text-amber-200",
  error: "border-rose-600 bg-rose-900/80 text-rose-200",
};

const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  info: 3000,
  success: 3000,
  warning: 4000,
  error: 5000,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextIdRef.current++;
      setToasts((prev) => [...prev, { id, kind, message }]);
      const timer = setTimeout(() => {
        dismiss(id);
      }, AUTO_DISMISS_MS[kind]);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toasts, push, dismiss }}>
      {children}
      {/* 渲染层：右上角固定定位 */}
      <div className="fixed top-4 right-4 z-[9000] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-start gap-2 rounded-lg border px-4 py-2.5 text-sm shadow-lg pointer-events-auto min-w-[280px] max-w-[400px] ${STYLES[t.kind]}`}
          >
            <span className="shrink-0">{ICONS[t.kind]}</span>
            <span className="flex-1 break-words">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-current opacity-50 hover:opacity-100"
              aria-label="关闭"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * 无 Provider 时的降级实现。必须是模块级常量：若每次调用都新建对象，
 * useToast() 的返回值就不稳定，会连带让消费方的 useCallback 依赖失效。
 */
const NOOP_TOAST: Pick<ToastContextValue, "push"> = {
  push: (kind: ToastKind, message: string) => {
    if (kind === "error") console.error(`[toast] ${message}`);
    else console.info(`[toast] ${kind}: ${message}`);
  },
};

/** 消费 toast 上下文的 hook，返回 push 函数 */
export function useToast() {
  const ctx = useContext(ToastContext);
  // 降级：没有 Provider 时返回 no-op，避免崩溃
  return ctx ?? NOOP_TOAST;
}
