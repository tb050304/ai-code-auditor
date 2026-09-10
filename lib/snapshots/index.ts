export type {
  FileSnapshot,
  SnapshotMeta,
  SnapshotSource,
  SnapshotStore,
} from "./types";
export { MemorySnapshotStore } from "./memory-store";
export { IdbSnapshotStore } from "./idb-store";
export {
  SnapshotManager,
  DEFAULT_MAX_SNAPSHOTS_PER_FILE,
} from "./history";

import type { SnapshotStore } from "./types";
import { MemorySnapshotStore } from "./memory-store";
import { IdbSnapshotStore } from "./idb-store";
import { SnapshotManager } from "./history";

let sharedStore: SnapshotStore | null = null;

/**
 * 获取默认的快照存储后端。
 * 浏览器环境用 IndexedDB（独立于 VFS 数据库），SSR / 测试回退内存实现。
 */
export function getDefaultSnapshotStore(): SnapshotStore {
  if (sharedStore) return sharedStore;

  const isBrowser =
    typeof window !== "undefined" && typeof indexedDB !== "undefined";

  sharedStore = isBrowser ? new IdbSnapshotStore() : new MemorySnapshotStore();
  return sharedStore;
}

/** 覆盖默认快照存储（主要用于测试） */
export function setDefaultSnapshotStore(store: SnapshotStore | null): void {
  sharedStore = store;
}

let sharedManager: SnapshotManager | null = null;

/** 获取全局快照管理器单例（默认上限 50 份/文件） */
export function getSnapshotManager(): SnapshotManager {
  if (!sharedManager) {
    sharedManager = new SnapshotManager(getDefaultSnapshotStore());
  }
  return sharedManager;
}
