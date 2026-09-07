import { FileNode, Project, VfsBackend, VfsError } from "./types";
import {
  ancestorPaths,
  basename,
  dirname,
  isChildOf,
  normalizePath,
  validatePath,
} from "./path";

const DB_NAME = "ai-code-auditor";
const DB_VERSION = 1;

const STORE_PROJECTS = "projects";
const STORE_FILES = "files";
// files 索引：按 projectId + path 查，按 projectId + parentPath 列目录
const INDEX_PROJECT_PATH = "project-path";
const INDEX_PROJECT_PARENT = "project-parent";

/** IndexedDB 中存储的文件记录 */
interface FileRecord {
  /** 复合主键：projectId + path */
  id: string;
  projectId: string;
  path: string;
  /** 父目录路径，方便列目录 */
  parentPath: string;
  type: "file" | "directory";
  size: number;
  mtime: number;
  ctime: number;
  /** 文件内容（仅 type=file） */
  content?: string;
}

function makeId(projectId: string, path: string): string {
  return `${projectId}::${path}`;
}

/**
 * IndexedDB VFS 后端。
 * 浏览器端持久化存储，刷新页面数据不丢。
 * 仅在浏览器环境可用；SSR / 测试环境请用 MemoryBackend。
 */
export class IdbBackend implements VfsBackend {
  readonly name = "indexeddb";

  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(
          new VfsError(
            "BACKEND_ERROR",
            "当前环境不支持 IndexedDB",
          ),
        );
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // 项目表
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
          db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
        }

        // 文件表
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          const store = db.createObjectStore(STORE_FILES, { keyPath: "id" });
          store.createIndex(INDEX_PROJECT_PATH, ["projectId", "path"], {
            unique: true,
          });
          store.createIndex(INDEX_PROJECT_PARENT, ["projectId", "parentPath"]);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new VfsError("BACKEND_ERROR", request.error?.message ?? "IndexedDB 打开失败"));
    });

    return this.dbPromise;
  }

  private async withTx<T>(
    storeNames: string | string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(storeNames, mode);
    const result = await fn(tx);

    // 等待事务完成，确保写入生效
    if (mode === "readwrite") {
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(
            new VfsError(
              "BACKEND_ERROR",
              tx.error?.message ?? "事务执行失败",
            ),
          );
        tx.onabort = () =>
          reject(
            new VfsError(
              "BACKEND_ERROR",
              tx.error?.message ?? "事务被中止",
            ),
          );
      });
    }

    return result;
  }

  // ---- 项目级 ----

  async listProjects(): Promise<Project[]> {
    return this.withTx(STORE_PROJECTS, "readonly", (tx) => {
      return new Promise<Project[]>((resolve, reject) => {
        const store = tx.objectStore(STORE_PROJECTS);
        const request = store.getAll();
        request.onsuccess = () => {
          const result = (request.result as Project[]).sort(
            (a, b) => b.updatedAt - a.updatedAt,
          );
          resolve(result);
        };
        request.onerror = () =>
          reject(new VfsError("BACKEND_ERROR", request.error?.message ?? ""));
      });
    });
  }

  async getProject(id: string): Promise<Project | null> {
    return this.withTx(STORE_PROJECTS, "readonly", (tx) => {
      return new Promise<Project | null>((resolve, reject) => {
        const store = tx.objectStore(STORE_PROJECTS);
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () =>
          reject(new VfsError("BACKEND_ERROR", request.error?.message ?? ""));
      });
    });
  }

  async createProject(name: string, rootPath = "/"): Promise<Project> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const project: Project = {
      id,
      name,
      rootPath: normalizePath(rootPath),
      createdAt: now,
      updatedAt: now,
    };

    await this.withTx(
      [STORE_PROJECTS, STORE_FILES],
      "readwrite",
      (tx) => {
        return new Promise<void>((resolve, reject) => {
          const projStore = tx.objectStore(STORE_PROJECTS);
          const filesStore = tx.objectStore(STORE_FILES);

          const projReq = projStore.add(project);
          projReq.onerror = () =>
            reject(new VfsError("BACKEND_ERROR", projReq.error?.message ?? ""));

          const rootRecord: FileRecord = {
            id: makeId(id, "/"),
            projectId: id,
            path: "/",
            parentPath: "",
            type: "directory",
            size: 0,
            mtime: now,
            ctime: now,
          };
          const fileReq = filesStore.add(rootRecord);
          fileReq.onerror = () =>
            reject(new VfsError("BACKEND_ERROR", fileReq.error?.message ?? ""));

          projReq.onsuccess = () => fileReq.onsuccess = () => resolve();
        });
      },
    );

    return project;
  }

  async deleteProject(id: string): Promise<void> {
    await this.withTx(
      [STORE_PROJECTS, STORE_FILES],
      "readwrite",
      (tx) => {
        return new Promise<void>((resolve, reject) => {
          const projStore = tx.objectStore(STORE_PROJECTS);
          const filesStore = tx.objectStore(STORE_FILES);
          const idx = filesStore.index(INDEX_PROJECT_PARENT);

          // 先删项目记录
          projStore.delete(id);

          // 找出该项目所有文件记录并删除
          const range = IDBKeyRange.bound([id, "/"], [id, "￿"]);
          const cursorReq = idx.openCursor(range);
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              filesStore.delete(cursor.value.id);
              cursor.continue();
            } else {
              resolve();
            }
          };
          cursorReq.onerror = () =>
            reject(new VfsError("BACKEND_ERROR", cursorReq.error?.message ?? ""));
        });
      },
    );
  }

  // ---- 读操作 ----

  async exists(projectId: string, path: string): Promise<boolean> {
    validatePath(path);
    const normalized = normalizePath(path);
    const record = await this.getRecord(projectId, normalized);
    return record !== null;
  }

  async readFile(projectId: string, path: string): Promise<string> {
    validatePath(path);
    const normalized = normalizePath(path);
    const record = await this.getRecord(projectId, normalized);
    if (!record) {
      throw new VfsError("NOT_FOUND", `文件不存在: ${path}`);
    }
    if (record.type !== "file") {
      throw new VfsError("NOT_FILE", `不是文件: ${path}`);
    }
    return record.content ?? "";
  }

  async readDir(projectId: string, path: string): Promise<FileNode[]> {
    validatePath(path);
    const normalized = normalizePath(path);

    const parent = await this.getRecord(projectId, normalized);
    if (!parent) {
      throw new VfsError("NOT_FOUND", `目录不存在: ${path}`);
    }
    if (parent.type !== "directory") {
      throw new VfsError("NOT_DIRECTORY", `不是目录: ${path}`);
    }

    return this.withTx(STORE_FILES, "readonly", (tx) => {
      return new Promise<FileNode[]>((resolve, reject) => {
        const store = tx.objectStore(STORE_FILES);
        const idx = store.index(INDEX_PROJECT_PARENT);
        const range = IDBKeyRange.only([projectId, normalized]);
        const request = idx.getAll(range);
        request.onsuccess = () => {
          const records = request.result as FileRecord[];
          const nodes = records
            .map(recordToNode)
            .sort((a, b) => {
              // 目录在前，文件在后；同名按字母序
              if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
              return basename(a.path).localeCompare(basename(b.path));
            });
          resolve(nodes);
        };
        request.onerror = () =>
          reject(new VfsError("BACKEND_ERROR", request.error?.message ?? ""));
      });
    });
  }

  async stat(projectId: string, path: string): Promise<FileNode | null> {
    validatePath(path);
    const normalized = normalizePath(path);
    const record = await this.getRecord(projectId, normalized);
    return record ? recordToNode(record) : null;
  }

  async listAllFiles(projectId: string): Promise<FileNode[]> {
    return this.withTx(STORE_FILES, "readonly", (tx) => {
      return new Promise<FileNode[]>((resolve, reject) => {
        const store = tx.objectStore(STORE_FILES);
        const idx = store.index(INDEX_PROJECT_PARENT);
        const range = IDBKeyRange.bound([projectId, "/"], [projectId, "￿"]);
        const request = idx.getAll(range);
        request.onsuccess = () => {
          const records = request.result as FileRecord[];
          resolve(
            records
              .filter((r) => r.type === "file")
              .map(recordToNode),
          );
        };
        request.onerror = () =>
          reject(new VfsError("BACKEND_ERROR", request.error?.message ?? ""));
      });
    });
  }

  // ---- 写操作 ----

  async writeFile(
    projectId: string,
    path: string,
    content: string,
  ): Promise<FileNode> {
    validatePath(path);
    const normalized = normalizePath(path);
    if (normalized === "/") {
      throw new VfsError("INVALID_PATH", "不能写入根路径");
    }

    const now = Date.now();
    const size = new Blob([content]).size;

    return this.withTx(
      [STORE_FILES, STORE_PROJECTS],
      "readwrite",
      async (tx) => {
        await this.ensureProjectExists(tx, projectId);

        const existing = await this.getRecordInTx(tx, projectId, normalized);

        let ctime = now;
        if (existing?.type === "file") {
          ctime = existing.ctime;
        } else if (existing?.type === "directory") {
          throw new VfsError("ALREADY_EXISTS", `同名目录已存在: ${path}`);
        }

        const record: FileRecord = {
          id: makeId(projectId, normalized),
          projectId,
          path: normalized,
          parentPath: dirname(normalized),
          type: "file",
          size,
          mtime: now,
          ctime,
          content,
        };

        await this.putRecordInTx(tx, record);
        await this.ensureParentDirsInTx(tx, projectId, normalized, now);
        await this.touchProjectInTx(tx, projectId, now);

        return recordToNode(record);
      },
    );
  }

  async mkdir(projectId: string, path: string): Promise<FileNode> {
    validatePath(path);
    const normalized = normalizePath(path);
    if (normalized === "/") {
      const root = await this.getRecord(projectId, "/");
      if (!root) throw new VfsError("NOT_FOUND", "项目不存在");
      return recordToNode(root);
    }

    const existing = await this.getRecord(projectId, normalized);
    if (existing) {
      if (existing.type === "directory") return recordToNode(existing);
      throw new VfsError("ALREADY_EXISTS", `同名文件已存在: ${path}`);
    }

    const now = Date.now();
    return this.withTx(
      [STORE_FILES, STORE_PROJECTS],
      "readwrite",
      async (tx) => {
        await this.ensureProjectExists(tx, projectId);
        const record = this.makeDirRecord(projectId, normalized, now);
        await this.putRecordInTx(tx, record);
        await this.ensureParentDirsInTx(tx, projectId, normalized, now);
        await this.touchProjectInTx(tx, projectId, now);
        return recordToNode(record);
      },
    );
  }

  async delete(projectId: string, path: string): Promise<void> {
    validatePath(path);
    const normalized = normalizePath(path);
    if (normalized === "/") {
      throw new VfsError("INVALID_PATH", "不能删除根目录");
    }

    const target = await this.getRecord(projectId, normalized);
    if (!target) {
      throw new VfsError("NOT_FOUND", `路径不存在: ${path}`);
    }

    const now = Date.now();
    await this.withTx(
      [STORE_FILES, STORE_PROJECTS],
      "readwrite",
      async (tx) => {
        // 收集所有待删除的记录
        const toDelete: string[] = [target.id];

        if (target.type === "directory") {
          // 递归删除所有子孙
          const descendants = await this.getDescendantsInTx(tx, projectId, normalized);
          for (const d of descendants) toDelete.push(d.id);
        }

        const store = tx.objectStore(STORE_FILES);
        for (const id of toDelete) {
          store.delete(id);
        }

        // 更新父目录 mtime
        const parentPath = dirname(normalized);
        await this.touchDirInTx(tx, projectId, parentPath, now);
        await this.touchProjectInTx(tx, projectId, now);
      },
    );
  }

  async rename(
    projectId: string,
    oldPath: string,
    newPath: string,
  ): Promise<FileNode> {
    validatePath(oldPath);
    validatePath(newPath);
    const oldNorm = normalizePath(oldPath);
    const newNorm = normalizePath(newPath);

    if (oldNorm === "/" || newNorm === "/") {
      throw new VfsError("INVALID_PATH", "不能移动或重命名根目录");
    }
    if (oldNorm === newNorm) {
      const node = await this.stat(projectId, oldNorm);
      if (!node) throw new VfsError("NOT_FOUND", `路径不存在: ${oldPath}`);
      return node;
    }
    if (isChildOf(oldNorm, newNorm)) {
      throw new VfsError("INVALID_PATH", "不能将目录移动到自身子目录下");
    }

    const source = await this.getRecord(projectId, oldNorm);
    if (!source) {
      throw new VfsError("NOT_FOUND", `路径不存在: ${oldPath}`);
    }

    const destExists = await this.exists(projectId, newNorm);
    if (destExists) {
      throw new VfsError("ALREADY_EXISTS", `目标路径已存在: ${newPath}`);
    }

    const now = Date.now();
    return this.withTx(
      [STORE_FILES, STORE_PROJECTS],
      "readwrite",
      async (tx) => {
        // 收集待移动的所有记录
        const moves: Array<{ old: FileRecord; newPath: string }> = [];
        moves.push({ old: source, newPath: newNorm });

        if (source.type === "directory") {
          const descendants = await this.getDescendantsInTx(
            tx,
            projectId,
            oldNorm,
          );
          for (const d of descendants) {
            const rel = d.path.slice(oldNorm.length);
            moves.push({ old: d, newPath: newNorm + rel });
          }
        }

        // 从旧父目录移除概念上的引用（这里没有 children 列表，只更新 mtime）
        const oldParentPath = dirname(oldNorm);
        await this.touchDirInTx(tx, projectId, oldParentPath, now);

        // 确保新父目录存在
        const newParentPath = dirname(newNorm);
        await this.ensureDirInTx(tx, projectId, newParentPath, now);

        // 删除旧记录，写新记录
        const store = tx.objectStore(STORE_FILES);
        let firstResult: FileNode | null = null;

        for (const { old: oldRec, newPath: np } of moves) {
          store.delete(oldRec.id);

          const newRec: FileRecord = {
            ...oldRec,
            id: makeId(projectId, np),
            path: np,
            parentPath: dirname(np),
            mtime: now,
          };
          store.put(newRec);

          if (!firstResult) firstResult = recordToNode(newRec);
        }

        await this.touchProjectInTx(tx, projectId, now);
        return firstResult!;
      },
    );
  }

  async batchWrite(
    projectId: string,
    items: Array<{ path: string; content: string }>,
  ): Promise<FileNode[]> {
    if (items.length === 0) return [];

    const now = Date.now();
    // 分块处理，避免单个事务过大；每块作为一个独立事务提交
    const CHUNK_SIZE = 200;
    const results: FileNode[] = [];

    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      const chunkResults = await this.batchWriteChunk(projectId, chunk, now);
      results.push(...chunkResults);
    }
    return results;
  }

  /**
   * 批量写入的分块实现。
   * 关键优化：不逐个 await IDB 请求，而是同步地把所有 put 请求排进事务队列，
   * 然后等事务的 oncomplete。IDB 会按队列顺序执行，性能远高于 await 每个请求。
   * 注意：这里跳过了「已存在则保留 ctime / 已存在目录则报错」的逐条检查，
   * 用 put 覆盖语义，ctime 统一用 now —— 导入场景下这是可接受的妥协。
   */
  private async batchWriteChunk(
    projectId: string,
    items: Array<{ path: string; content: string }>,
    now: number,
  ): Promise<FileNode[]> {
    const db = await this.open();

    // 先同步构建所有 record，避免在事务回调里做重计算
    const fileRecords: FileRecord[] = [];
    const results: FileNode[] = [];
    const dirsToEnsure = new Set<string>();

    for (const item of items) {
      const normalized = normalizePath(item.path);
      validatePath(normalized);
      if (normalized === "/") {
        throw new VfsError("INVALID_PATH", "不能写入根路径");
      }

      const record: FileRecord = {
        id: makeId(projectId, normalized),
        projectId,
        path: normalized,
        parentPath: dirname(normalized),
        type: "file",
        size: new Blob([item.content]).size,
        mtime: now,
        ctime: now,
        content: item.content,
      };
      fileRecords.push(record);
      results.push(recordToNode(record));

      // 收集所有祖先目录，稍后一次性建
      for (const anc of ancestorPaths(normalized)) {
        dirsToEnsure.add(anc);
      }
    }

    return new Promise<FileNode[]>((resolve, reject) => {
      const tx = db.transaction([STORE_FILES, STORE_PROJECTS], "readwrite");
      const filesStore = tx.objectStore(STORE_FILES);
      const projectsStore = tx.objectStore(STORE_PROJECTS);

      let rejected = false;
      const fail = (err: VfsError) => {
        if (!rejected) {
          rejected = true;
          try { tx.abort(); } catch {}
          reject(err);
        }
      };

      // 1) 先确认项目存在
      const projReq = projectsStore.get(projectId);
      projReq.onerror = () =>
        fail(new VfsError("BACKEND_ERROR", projReq.error?.message ?? ""));
      projReq.onsuccess = () => {
        if (rejected) return;
        const project = projReq.result as Project | undefined;
        if (!project) {
          fail(new VfsError("NOT_FOUND", `项目不存在: ${projectId}`));
          return;
        }

        // 2) 同步把所有 file put 排进队列（不 await）
        for (const record of fileRecords) {
          filesStore.put(record);
        }

        // 3) 同步把所有祖先目录 put 排进队列（覆盖式，存在则更新 mtime）
        for (const dirPath of dirsToEnsure) {
          const dirRecord: FileRecord = {
            id: makeId(projectId, dirPath),
            projectId,
            path: dirPath,
            parentPath: dirname(dirPath),
            type: "directory",
            size: 0,
            mtime: now,
            ctime: now,
          };
          filesStore.put(dirRecord);
        }

        // 4) 更新项目 updatedAt
        project.updatedAt = now;
        projectsStore.put(project);
      };

      // 5) 事务完成后 resolve；此时所有 put 已生效
      tx.oncomplete = () => {
        if (!rejected) resolve(results);
      };
      tx.onerror = () =>
        fail(new VfsError("BACKEND_ERROR", tx.error?.message ?? "事务执行失败"));
      tx.onabort = () =>
        fail(new VfsError("BACKEND_ERROR", tx.error?.message ?? "事务被中止"));
    });
  }

  // ---- 内部辅助 ----

  private getRecord(
    projectId: string,
    path: string,
  ): Promise<FileRecord | null> {
    return this.withTx(STORE_FILES, "readonly", (tx) =>
      this.getRecordInTx(tx, projectId, path),
    );
  }

  private getRecordInTx(
    tx: IDBTransaction,
    projectId: string,
    path: string,
  ): Promise<FileRecord | null> {
    return new Promise((resolve, reject) => {
      const store = tx.objectStore(STORE_FILES);
      const idx = store.index(INDEX_PROJECT_PATH);
      const request = idx.get([projectId, path]);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () =>
        reject(new VfsError("BACKEND_ERROR", request.error?.message ?? ""));
    });
  }

  private putRecordInTx(
    tx: IDBTransaction,
    record: FileRecord,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = tx.objectStore(STORE_FILES);
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(new VfsError("BACKEND_ERROR", request.error?.message ?? ""));
    });
  }

  private makeDirRecord(
    projectId: string,
    path: string,
    now: number,
  ): FileRecord {
    return {
      id: makeId(projectId, path),
      projectId,
      path,
      parentPath: dirname(path),
      type: "directory",
      size: 0,
      mtime: now,
      ctime: now,
    };
  }

  private async ensureParentDirsInTx(
    tx: IDBTransaction,
    projectId: string,
    path: string,
    now: number,
  ): Promise<void> {
    const ancestors = ancestorPaths(path);
    for (const anc of ancestors) {
      await this.ensureDirInTx(tx, projectId, anc, now);
    }
  }

  private async ensureDirInTx(
    tx: IDBTransaction,
    projectId: string,
    path: string,
    now: number,
  ): Promise<void> {
    const existing = await this.getRecordInTx(tx, projectId, path);
    if (existing) {
      if (existing.type === "file") {
        throw new VfsError("ALREADY_EXISTS", `路径已被文件占用: ${path}`);
      }
      return;
    }
    const record = this.makeDirRecord(projectId, path, now);
    await this.putRecordInTx(tx, record);
  }

  private async getDescendantsInTx(
    tx: IDBTransaction,
    projectId: string,
    dirPath: string,
  ): Promise<FileRecord[]> {
    return new Promise((resolve, reject) => {
      const store = tx.objectStore(STORE_FILES);
      const idx = store.index(INDEX_PROJECT_PARENT);
      // 以 dirPath + "/" 开头的所有路径
      const range = IDBKeyRange.bound(
        [projectId, dirPath + "/"],
        [projectId, dirPath + "0"],
      );
      const request = idx.getAll(range);
      request.onsuccess = () => resolve(request.result as FileRecord[]);
      request.onerror = () =>
        reject(new VfsError("BACKEND_ERROR", request.error?.message ?? ""));
    });
  }

  private async touchDirInTx(
    tx: IDBTransaction,
    projectId: string,
    path: string,
    now: number,
  ): Promise<void> {
    const rec = await this.getRecordInTx(tx, projectId, path);
    if (!rec) return;
    rec.mtime = now;
    await this.putRecordInTx(tx, rec);
  }

  private touchProjectInTx(
    tx: IDBTransaction,
    projectId: string,
    now: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = tx.objectStore(STORE_PROJECTS);
      const req = store.get(projectId);
      req.onsuccess = () => {
        const project = req.result as Project | undefined;
        if (!project) {
          reject(new VfsError("NOT_FOUND", `项目不存在: ${projectId}`));
          return;
        }
        project.updatedAt = now;
        const putReq = store.put(project);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () =>
          reject(
            new VfsError("BACKEND_ERROR", putReq.error?.message ?? ""),
          );
      };
      req.onerror = () =>
        reject(new VfsError("BACKEND_ERROR", req.error?.message ?? ""));
    });
  }

  private async ensureProjectExists(
    tx: IDBTransaction,
    projectId: string,
  ): Promise<void> {
    const project = await new Promise<Project | undefined>((resolve, reject) => {
      const store = tx.objectStore(STORE_PROJECTS);
      const req = store.get(projectId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(new VfsError("BACKEND_ERROR", req.error?.message ?? ""));
    });
    if (!project) {
      throw new VfsError("NOT_FOUND", `项目不存在: ${projectId}`);
    }
  }
}

function recordToNode(rec: FileRecord): FileNode {
  return {
    path: rec.path,
    type: rec.type,
    size: rec.size,
    mtime: rec.mtime,
    ctime: rec.ctime,
  };
}
