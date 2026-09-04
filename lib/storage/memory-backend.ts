import { FileNode, Project, VfsBackend, VfsError } from "./types";
import {
  ancestorPaths,
  basename,
  dirname,
  isChildOf,
  normalizePath,
  validatePath,
} from "./path";

interface MemoryFileNode extends FileNode {
  type: "file";
  content: string;
}

interface MemoryDirNode extends FileNode {
  type: "directory";
  children: Map<string, FileNode>;
}

type MemoryNode = MemoryFileNode | MemoryDirNode;

interface ProjectState {
  project: Project;
  nodes: Map<string, MemoryNode>;
}

/**
 * 纯内存 VFS 后端。
 * 用途：单元测试、SSR 环境（无 IndexedDB）、临时演示。
 */
export class MemoryBackend implements VfsBackend {
  readonly name = "memory";

  private projects = new Map<string, ProjectState>();

  // ---- 项目级 ----

  async listProjects(): Promise<Project[]> {
    return Array.from(this.projects.values())
      .map((s) => s.project)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getProject(id: string): Promise<Project | null> {
    return this.projects.get(id)?.project ?? null;
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
    const rootNode: MemoryDirNode = {
      path: "/",
      type: "directory",
      size: 0,
      mtime: now,
      ctime: now,
      children: new Map(),
    };
    const nodes = new Map<string, MemoryNode>();
    nodes.set("/", rootNode);
    this.projects.set(id, { project, nodes });
    return project;
  }

  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
  }

  // ---- 读操作 ----

  async exists(projectId: string, path: string): Promise<boolean> {
    validatePath(path);
    const state = this.getState(projectId);
    return state.nodes.has(normalizePath(path));
  }

  async readFile(projectId: string, path: string): Promise<string> {
    validatePath(path);
    const state = this.getState(projectId);
    const normalized = normalizePath(path);
    const node = state.nodes.get(normalized);
    if (!node) throw new VfsError("NOT_FOUND", `文件不存在: ${path}`);
    if (node.type !== "file") throw new VfsError("NOT_FILE", `不是文件: ${path}`);
    return node.content;
  }

  async readDir(projectId: string, path: string): Promise<FileNode[]> {
    validatePath(path);
    const state = this.getState(projectId);
    const normalized = normalizePath(path);
    const node = state.nodes.get(normalized);
    if (!node) throw new VfsError("NOT_FOUND", `目录不存在: ${path}`);
    if (node.type !== "directory") throw new VfsError("NOT_DIRECTORY", `不是目录: ${path}`);
    return [...node.children.values()].map((c) => ({ ...c }));
  }

  async stat(projectId: string, path: string): Promise<FileNode | null> {
    validatePath(path);
    const state = this.getState(projectId);
    const normalized = normalizePath(path);
    const node = state.nodes.get(normalized);
    if (!node) return null;
    return this.stripInternal(node);
  }

  async listAllFiles(projectId: string): Promise<FileNode[]> {
    const state = this.getState(projectId);
    const result: FileNode[] = [];
    for (const node of state.nodes.values()) {
      if (node.type === "file") {
        result.push(this.stripInternal(node));
      }
    }
    return result;
  }

  // ---- 写操作 ----

  async writeFile(
    projectId: string,
    path: string,
    content: string,
  ): Promise<FileNode> {
    validatePath(path);
    const state = this.getState(projectId);
    const normalized = normalizePath(path);
    if (normalized === "/") throw new VfsError("INVALID_PATH", "不能写入根路径");

    const now = Date.now();
    const existing = state.nodes.get(normalized);

    if (existing?.type === "directory") {
      throw new VfsError("ALREADY_EXISTS", `同名目录已存在: ${path}`);
    }

    const ctime = existing?.type === "file" ? existing.ctime : now;

    const fileNode: MemoryFileNode = {
      path: normalized,
      type: "file",
      size: new Blob([content]).size,
      mtime: now,
      ctime,
      content,
    };

    state.nodes.set(normalized, fileNode);
    this.ensureParentDirs(state, normalized, now);
    this.addToParent(state, normalized, fileNode, now);
    this.touchProject(state, now);

    return this.stripInternal(fileNode);
  }

  async mkdir(projectId: string, path: string): Promise<FileNode> {
    validatePath(path);
    const state = this.getState(projectId);
    const normalized = normalizePath(path);
    if (normalized === "/") {
      return this.stripInternal(state.nodes.get("/")!);
    }

    const existing = state.nodes.get(normalized);
    if (existing) {
      if (existing.type === "directory") return this.stripInternal(existing);
      throw new VfsError("ALREADY_EXISTS", `同名文件已存在: ${path}`);
    }

    const now = Date.now();
    const dirNode: MemoryDirNode = {
      path: normalized,
      type: "directory",
      size: 0,
      mtime: now,
      ctime: now,
      children: new Map(),
    };

    state.nodes.set(normalized, dirNode);
    this.ensureParentDirs(state, normalized, now);
    this.addToParent(state, normalized, dirNode, now);
    this.touchProject(state, now);

    return this.stripInternal(dirNode);
  }

  async delete(projectId: string, path: string): Promise<void> {
    validatePath(path);
    const state = this.getState(projectId);
    const normalized = normalizePath(path);
    if (normalized === "/") throw new VfsError("INVALID_PATH", "不能删除根目录");

    const node = state.nodes.get(normalized);
    if (!node) throw new VfsError("NOT_FOUND", `路径不存在: ${path}`);

    const toDelete: string[] = [normalized];
    if (node.type === "directory") {
      for (const p of state.nodes.keys()) {
        if (isChildOf(normalized, p)) toDelete.push(p);
      }
    }

    for (const p of toDelete) state.nodes.delete(p);

    const parentPath = dirname(normalized);
    const parent = state.nodes.get(parentPath);
    if (parent?.type === "directory") {
      parent.children.delete(basename(normalized));
      parent.mtime = Date.now();
    }

    this.touchProject(state, Date.now());
  }

  async rename(
    projectId: string,
    oldPath: string,
    newPath: string,
  ): Promise<FileNode> {
    validatePath(oldPath);
    validatePath(newPath);
    const state = this.getState(projectId);
    const oldNorm = normalizePath(oldPath);
    const newNorm = normalizePath(newPath);

    if (oldNorm === "/" || newNorm === "/") {
      throw new VfsError("INVALID_PATH", "不能移动或重命名根目录");
    }
    if (oldNorm === newNorm) {
      const node = state.nodes.get(oldNorm);
      if (!node) throw new VfsError("NOT_FOUND", `路径不存在: ${oldPath}`);
      return this.stripInternal(node);
    }
    if (isChildOf(oldNorm, newNorm)) {
      throw new VfsError("INVALID_PATH", "不能将目录移动到自身子目录下");
    }

    const node = state.nodes.get(oldNorm);
    if (!node) throw new VfsError("NOT_FOUND", `路径不存在: ${oldPath}`);
    if (state.nodes.has(newNorm)) {
      throw new VfsError("ALREADY_EXISTS", `目标路径已存在: ${newPath}`);
    }

    const now = Date.now();

    // 收集待移动的所有节点
    const moves: Array<{ oldP: string; newP: string }> = [{ oldP: oldNorm, newP: newNorm }];
    if (node.type === "directory") {
      for (const p of state.nodes.keys()) {
        if (isChildOf(oldNorm, p)) {
          moves.push({ oldP: p, newP: newNorm + p.slice(oldNorm.length) });
        }
      }
    }

    // 从旧父目录移除
    const oldParentPath = dirname(oldNorm);
    const oldParent = state.nodes.get(oldParentPath);
    if (oldParent?.type === "directory") {
      oldParent.children.delete(basename(oldNorm));
      oldParent.mtime = now;
    }

    // 读出所有节点
    const movedEntries: Array<[string, MemoryNode]> = [];
    for (const { oldP, newP } of moves) {
      const n = state.nodes.get(oldP)!;
      state.nodes.delete(oldP);
      movedEntries.push([newP, n]);
    }

    // 更新路径并写回
    for (const [newP, n] of movedEntries) {
      const updated: MemoryNode = { ...n, path: newP, mtime: now };
      if (updated.type === "directory") {
        // children Map 中每个子节点的 path 也需要更新
        const newChildren = new Map<string, FileNode>();
        for (const [name, child] of n.type === "directory" ? n.children : []) {
          const childNewPath = newP + "/" + name;
          newChildren.set(name, { ...child, path: childNewPath });
        }
        updated.children = newChildren;
      }
      state.nodes.set(newP, updated);
    }

    // 确保新路径的父目录存在
    this.ensureParentDirs(state, newNorm, now);
    // 添加到新父目录
    const newNode = state.nodes.get(newNorm)!;
    this.addToParent(state, newNorm, newNode, now);

    this.touchProject(state, now);
    return this.stripInternal(newNode);
  }

  async batchWrite(
    projectId: string,
    items: Array<{ path: string; content: string }>,
  ): Promise<FileNode[]> {
    const results: FileNode[] = [];
    for (const item of items) {
      results.push(await this.writeFile(projectId, item.path, item.content));
    }
    return results;
  }

  // ---- 内部方法 ----

  private getState(projectId: string): ProjectState {
    const state = this.projects.get(projectId);
    if (!state) throw new VfsError("NOT_FOUND", `项目不存在: ${projectId}`);
    return state;
  }

  /** 去除内部字段，返回纯 FileNode */
  private stripInternal(node: MemoryNode): FileNode {
    if (node.type === "file") {
      const { content: _c, ...rest } = node;
      void _c;
      return { ...rest };
    }
    const { children: _ch, ...rest } = node;
    void _ch;
    return { ...rest };
  }

  /** 确保所有祖先目录存在，不存在则创建 */
  private ensureParentDirs(state: ProjectState, path: string, now: number) {
    const ancestors = ancestorPaths(path);
    for (const ancestor of ancestors) {
      if (!state.nodes.has(ancestor)) {
        const dirNode: MemoryDirNode = {
          path: ancestor,
          type: "directory",
          size: 0,
          mtime: now,
          ctime: now,
          children: new Map(),
        };
        state.nodes.set(ancestor, dirNode);
      }
    }
  }

  /** 将节点添加到父目录的 children 中 */
  private addToParent(
    state: ProjectState,
    path: string,
    node: MemoryNode,
    now: number,
  ) {
    const parentPath = dirname(path);
    let parent = state.nodes.get(parentPath);
    if (!parent) {
      const newParent: MemoryDirNode = {
        path: parentPath,
        type: "directory",
        size: 0,
        mtime: now,
        ctime: now,
        children: new Map(),
      };
      state.nodes.set(parentPath, newParent);
      parent = newParent;
    }
    if (parent.type !== "directory") return;
    const name = basename(path);
    const childMeta = this.stripInternal(node);
    parent.children.set(name, childMeta);
    parent.mtime = now;
  }

  private touchProject(state: ProjectState, now: number) {
    state.project = { ...state.project, updatedAt: now };
  }
}
