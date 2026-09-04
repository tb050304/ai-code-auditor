export * from "./types";
export * from "./path";
export { MemoryBackend } from "./memory-backend";
export { IdbBackend } from "./idb-backend";

import { VfsBackend, VfsError } from "./types";
import { MemoryBackend } from "./memory-backend";
import { IdbBackend } from "./idb-backend";

let sharedBackend: VfsBackend | null = null;

/**
 * 获取默认的 VFS 后端。
 * 浏览器环境优先使用 IndexedDB，SSR / 测试环境回退到内存后端。
 * 单例模式，全局共用一个实例。
 */
export function getDefaultBackend(): VfsBackend {
  if (sharedBackend) return sharedBackend;

  const isBrowser =
    typeof window !== "undefined" && typeof indexedDB !== "undefined";

  sharedBackend = isBrowser ? new IdbBackend() : new MemoryBackend();
  return sharedBackend;
}

/** 覆盖默认后端（主要用于测试） */
export function setDefaultBackend(backend: VfsBackend | null): void {
  sharedBackend = backend;
}

export { VfsError };
