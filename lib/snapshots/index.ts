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

export type {
  ProjectSnapshot,
  ProjectSnapshotFile,
  ProjectSnapshotSource,
  ProjectSnapshotMeta,
  ProjectSnapshotStore,
  ProjectIo,
} from "./project-types";
export { MemoryProjectSnapshotStore } from "./project-memory-store";
export { ProjectIdbSnapshotStore } from "./idb-store";
export {
  ProjectSnapshotManager,
  DEFAULT_MAX_PROJECT_SNAPSHOTS,
  type RestoreResult,
} from "./project-history";

import type { SnapshotStore } from "./types";
import { MemorySnapshotStore } from "./memory-store";
import { IdbSnapshotStore } from "./idb-store";
import { SnapshotManager } from "./history";
import type { ProjectSnapshotStore } from "./project-types";
import { MemoryProjectSnapshotStore } from "./project-memory-store";
import { ProjectIdbSnapshotStore } from "./idb-store";
import { ProjectSnapshotManager } from "./project-history";

let sharedStore: SnapshotStore | null = null;

/**
 * 获取默认的文件快照存储后端。
 * 浏览器环境用 IndexedDB（独立于 VFS 数据库），SSR / 测试回退内存实现。
 */
export function getDefaultSnapshotStore(): SnapshotStore {
  if (sharedStore) return sharedStore;

  const isBrowser =
    typeof window !== "undefined" && typeof indexedDB !== "undefined";

  sharedStore = isBrowser ? new IdbSnapshotStore() : new MemorySnapshotStore();
  return sharedStore;
}

/** 覆盖默认文件快照存储（主要用于测试） */
export function setDefaultSnapshotStore(store: SnapshotStore | null): void {
  sharedStore = store;
}

let sharedManager: SnapshotManager | null = null;

/** 获取全局文件快照管理器单例（默认上限 50 份/文件） */
export function getSnapshotManager(): SnapshotManager {
  if (!sharedManager) {
    sharedManager = new SnapshotManager(getDefaultSnapshotStore());
  }
  return sharedManager;
}

let sharedProjectStore: ProjectSnapshotStore | null = null;

/** 获取默认的项目快照存储后端（与文件快照同库不同 store） */
export function getDefaultProjectSnapshotStore(): ProjectSnapshotStore {
  if (sharedProjectStore) return sharedProjectStore;

  const isBrowser =
    typeof window !== "undefined" && typeof indexedDB !== "undefined";

  sharedProjectStore = isBrowser
    ? new ProjectIdbSnapshotStore()
    : new MemoryProjectSnapshotStore();
  return sharedProjectStore;
}

/** 覆盖默认项目快照存储（主要用于测试） */
export function setDefaultProjectSnapshotStore(
  store: ProjectSnapshotStore | null,
): void {
  sharedProjectStore = store;
}

let sharedProjectManager: ProjectSnapshotManager | null = null;

/** 获取全局项目快照管理器单例（默认上限 20 个/项目） */
export function getProjectSnapshotManager(): ProjectSnapshotManager {
  if (!sharedProjectManager) {
    sharedProjectManager = new ProjectSnapshotManager(
      getDefaultProjectSnapshotStore(),
    );
  }
  return sharedProjectManager;
}
