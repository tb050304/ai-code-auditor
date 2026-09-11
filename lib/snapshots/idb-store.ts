import type { FileSnapshot, SnapshotStore } from "./types";
import type { ProjectSnapshot, ProjectSnapshotStore } from "./project-types";

const DB_NAME = "ai-code-auditor-snapshots";
const DB_VERSION = 2;

// 文件快照 store
const STORE_FILES = "snapshots";
const INDEX_PROJECT_PATH = "project-path";
const INDEX_PROJECT = "project";

// 项目快照 store
const STORE_PROJECT = "project-snapshots";
const INDEX_PSNAP_PROJECT = "project";

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * 打开共享的快照数据库（文件快照 + 项目快照共用一个连接）。
 * v2 起包含 project-snapshots store；老用户从 v1 升级时自动补建。
 */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前环境不支持 IndexedDB"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORE_FILES)) {
        const store = db.createObjectStore(STORE_FILES, { keyPath: "id" });
        store.createIndex(INDEX_PROJECT_PATH, ["projectId", "path"], { unique: false });
        store.createIndex(INDEX_PROJECT, ["projectId"], { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_PROJECT)) {
        const store = db.createObjectStore(STORE_PROJECT, { keyPath: "id" });
        store.createIndex(INDEX_PSNAP_PROJECT, ["projectId"], { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error("打开快照数据库失败"));
    };
  });

  return dbPromise;
}

/** 把 IDBRequest 包装成 Promise（成功 resolve，失败 reject） */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
  });
}

/** 等待事务完成（保证写入真正落盘） */
function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务中止"));
  });
}

/**
 * IndexedDB 文件快照存储。
 * 独立于 VFS 的数据库（ai-code-auditor-snapshots），避免快照记录混进用户文件树。
 * 仅在浏览器环境可用；SSR / 测试环境请用 MemorySnapshotStore。
 */
export class IdbSnapshotStore implements SnapshotStore {
  readonly name = "indexeddb";

  private async open(): Promise<IDBDatabase> {
    return openDb();
  }

  async append(snapshot: FileSnapshot): Promise<void> {
    const db = await this.open();
    await requestToPromise(
      db.transaction(STORE_FILES, "readwrite").objectStore(STORE_FILES).put(snapshot),
    );
  }

  async get(id: string): Promise<FileSnapshot | null> {
    const db = await this.open();
    const result = await requestToPromise<FileSnapshot | undefined>(
      db.transaction(STORE_FILES, "readonly").objectStore(STORE_FILES).get(id),
    );
    return result ?? null;
  }

  async listByFile(projectId: string, path: string): Promise<FileSnapshot[]> {
    const db = await this.open();
    const index = db
      .transaction(STORE_FILES, "readonly")
      .objectStore(STORE_FILES)
      .index(INDEX_PROJECT_PATH);
    const range = IDBKeyRange.only([projectId, path]);
    const result = await requestToPromise<FileSnapshot[]>(index.getAll(range));
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  async listByProject(projectId: string): Promise<FileSnapshot[]> {
    const db = await this.open();
    const index = db
      .transaction(STORE_FILES, "readonly")
      .objectStore(STORE_FILES)
      .index(INDEX_PROJECT);
    const range = IDBKeyRange.only(projectId);
    const result = await requestToPromise<FileSnapshot[]>(index.getAll(range));
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  async countByFile(projectId: string, path: string): Promise<number> {
    const db = await this.open();
    const index = db
      .transaction(STORE_FILES, "readonly")
      .objectStore(STORE_FILES)
      .index(INDEX_PROJECT_PATH);
    const range = IDBKeyRange.only([projectId, path]);
    const result = await requestToPromise<number>(index.count(range));
    return result;
  }

  async deleteSnapshots(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.open();
    const store = db.transaction(STORE_FILES, "readwrite").objectStore(STORE_FILES);
    // 把所有 delete 排进同一个事务，等事务整体完成
    const deletes = ids.map((id) => requestToPromise(store.delete(id)));
    await Promise.all(deletes);
    await txComplete(store.transaction);
  }

  async migratePath(projectId: string, oldPath: string, newPath: string): Promise<void> {
    const list = await this.listByFile(projectId, oldPath);
    if (list.length === 0) return;
    const db = await this.open();
    const store = db.transaction(STORE_FILES, "readwrite").objectStore(STORE_FILES);
    const puts = list.map((snap) => requestToPromise(store.put({ ...snap, path: newPath })));
    await Promise.all(puts);
    await txComplete(store.transaction);
  }

  async purgeProject(projectId: string): Promise<void> {
    const list = await this.listByProject(projectId);
    await this.deleteSnapshots(list.map((s) => s.id));
  }
}

/**
 * IndexedDB 项目快照存储（与文件快照同库不同 store）。
 */
export class ProjectIdbSnapshotStore implements ProjectSnapshotStore {
  readonly name = "indexeddb";

  async append(snapshot: ProjectSnapshot): Promise<void> {
    const db = await openDb();
    await requestToPromise(
      db.transaction(STORE_PROJECT, "readwrite").objectStore(STORE_PROJECT).put(snapshot),
    );
  }

  async get(id: string): Promise<ProjectSnapshot | null> {
    const db = await openDb();
    const result = await requestToPromise<ProjectSnapshot | undefined>(
      db.transaction(STORE_PROJECT, "readonly").objectStore(STORE_PROJECT).get(id),
    );
    return result ?? null;
  }

  async listByProject(projectId: string): Promise<ProjectSnapshot[]> {
    const db = await openDb();
    const index = db
      .transaction(STORE_PROJECT, "readonly")
      .objectStore(STORE_PROJECT)
      .index(INDEX_PSNAP_PROJECT);
    const range = IDBKeyRange.only(projectId);
    const result = await requestToPromise<ProjectSnapshot[]>(index.getAll(range));
    // 项目快照列表新 → 旧
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteSnapshots(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await openDb();
    const store = db.transaction(STORE_PROJECT, "readwrite").objectStore(STORE_PROJECT);
    const deletes = ids.map((id) => requestToPromise(store.delete(id)));
    await Promise.all(deletes);
    await txComplete(store.transaction);
  }

  async purgeProject(projectId: string): Promise<void> {
    const list = await this.listByProject(projectId);
    await this.deleteSnapshots(list.map((s) => s.id));
  }
}
