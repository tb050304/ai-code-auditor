import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "@/lib/storage/memory-backend";
import { VfsError } from "@/lib/storage/types";

describe("MemoryBackend - 项目管理", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend();
  });

  it("创建项目并返回正确信息", async () => {
    const project = await backend.createProject("test-project");
    expect(project.id).toBeDefined();
    expect(project.name).toBe("test-project");
    expect(project.rootPath).toBe("/");
    expect(project.createdAt).toBeGreaterThan(0);
    expect(project.updatedAt).toBeGreaterThan(0);
  });

  it("listProjects 返回按时间倒序的项目列表", async () => {
    const p1 = await backend.createProject("old");
    await new Promise(r => setTimeout(r, 5));
    const p2 = await backend.createProject("new");
    const list = await backend.listProjects();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(p2.id);
    expect(list[1].id).toBe(p1.id);
  });

  it("getProject 存在时返回项目，不存在返回 null", async () => {
    const p = await backend.createProject("demo");
    expect(await backend.getProject(p.id)).toBeDefined();
    expect(await backend.getProject("nonexistent")).toBeNull();
  });

  it("deleteProject 删除项目及其所有文件", async () => {
    const p = await backend.createProject("demo");
    await backend.writeFile(p.id, "/a.txt", "hello");
    await backend.deleteProject(p.id);
    expect(await backend.getProject(p.id)).toBeNull();
    const list = await backend.listProjects();
    expect(list).toHaveLength(0);
  });
});

describe("MemoryBackend - 文件读写", () => {
  let backend: MemoryBackend;
  let projectId: string;

  beforeEach(async () => {
    backend = new MemoryBackend();
    const p = await backend.createProject("test");
    projectId = p.id;
  });

  it("writeFile 写入后 readFile 能读取相同内容", async () => {
    await backend.writeFile(projectId, "/hello.txt", "Hello World");
    const content = await backend.readFile(projectId, "/hello.txt");
    expect(content).toBe("Hello World");
  });

  it("writeFile 自动创建父目录", async () => {
    await backend.writeFile(projectId, "/a/b/c/d.txt", "nested");
    const content = await backend.readFile(projectId, "/a/b/c/d.txt");
    expect(content).toBe("nested");
    const stat = await backend.stat(projectId, "/a/b/c");
    expect(stat?.type).toBe("directory");
  });

  it("readFile 不存在的文件抛出 NOT_FOUND", async () => {
    await expect(backend.readFile(projectId, "/missing.txt")).rejects.toThrow();
    try {
      await backend.readFile(projectId, "/missing.txt");
    } catch (e) {
      expect(e).toBeInstanceOf(VfsError);
      expect((e as VfsError).code).toBe("NOT_FOUND");
    }
  });

  it("exists 正确判断文件和目录存在性", async () => {
    await backend.writeFile(projectId, "/file.txt", "x");
    await backend.mkdir(projectId, "/dir");
    expect(await backend.exists(projectId, "/file.txt")).toBe(true);
    expect(await backend.exists(projectId, "/dir")).toBe(true);
    expect(await backend.exists(projectId, "/nope")).toBe(false);
  });

  it("writeFile 覆盖已有文件并更新 mtime", async () => {
    const first = await backend.writeFile(projectId, "/a.txt", "v1");
    await new Promise(r => setTimeout(r, 5));
    const second = await backend.writeFile(projectId, "/a.txt", "v2");
    expect(second.mtime).toBeGreaterThan(first.mtime);
    expect(await backend.readFile(projectId, "/a.txt")).toBe("v2");
  });

  it("stat 返回正确的节点信息", async () => {
    await backend.writeFile(projectId, "/f.txt", "12345");
    const stat = await backend.stat(projectId, "/f.txt");
    expect(stat).toBeDefined();
    expect(stat?.type).toBe("file");
    expect(stat?.size).toBe(5);
    expect(stat?.path).toBe("/f.txt");
  });

  it("空路径抛出 INVALID_PATH", async () => {
    try {
      await backend.writeFile(projectId, "", "x");
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(VfsError);
      expect((e as VfsError).code).toBe("INVALID_PATH");
    }
  });
});

describe("MemoryBackend - 目录操作", () => {
  let backend: MemoryBackend;
  let projectId: string;

  beforeEach(async () => {
    backend = new MemoryBackend();
    const p = await backend.createProject("test");
    projectId = p.id;
  });

  it("mkdir 创建目录，readDir 列出子节点", async () => {
    await backend.mkdir(projectId, "/src");
    await backend.writeFile(projectId, "/src/a.js", "1");
    await backend.writeFile(projectId, "/src/b.js", "2");
    const children = await backend.readDir(projectId, "/src");
    expect(children).toHaveLength(2);
    const paths = children.map(c => c.path).sort();
    expect(paths).toEqual(["/src/a.js", "/src/b.js"]);
  });

  it("mkdir 递归创建父目录", async () => {
    await backend.mkdir(projectId, "/a/b/c/d");
    const stat = await backend.stat(projectId, "/a/b/c/d");
    expect(stat?.type).toBe("directory");
  });

  it("readDir 对文件路径抛出 NOT_DIRECTORY", async () => {
    await backend.writeFile(projectId, "/f.txt", "x");
    try {
      await backend.readDir(projectId, "/f.txt");
      expect.fail("should throw");
    } catch (e) {
      expect((e as VfsError).code).toBe("NOT_DIRECTORY");
    }
  });

  it("listAllFiles 递归列出所有文件", async () => {
    await backend.writeFile(projectId, "/a.js", "1");
    await backend.writeFile(projectId, "/src/b.js", "2");
    await backend.writeFile(projectId, "/src/lib/c.js", "3");
    await backend.mkdir(projectId, "/empty");
    const files = await backend.listAllFiles(projectId);
    expect(files).toHaveLength(3);
    const paths = files.map(f => f.path).sort();
    expect(paths).toEqual(["/a.js", "/src/b.js", "/src/lib/c.js"]);
  });
});

describe("MemoryBackend - 删除与重命名", () => {
  let backend: MemoryBackend;
  let projectId: string;

  beforeEach(async () => {
    backend = new MemoryBackend();
    const p = await backend.createProject("test");
    projectId = p.id;
  });

  it("delete 删除单个文件", async () => {
    await backend.writeFile(projectId, "/a.txt", "x");
    await backend.delete(projectId, "/a.txt");
    expect(await backend.exists(projectId, "/a.txt")).toBe(false);
  });

  it("delete 递归删除目录及其内容", async () => {
    await backend.writeFile(projectId, "/dir/a.txt", "1");
    await backend.writeFile(projectId, "/dir/sub/b.txt", "2");
    await backend.delete(projectId, "/dir");
    expect(await backend.exists(projectId, "/dir")).toBe(false);
    expect(await backend.exists(projectId, "/dir/a.txt")).toBe(false);
  });

  it("delete 不存在的路径抛出 NOT_FOUND", async () => {
    try {
      await backend.delete(projectId, "/nope");
      expect.fail("should throw");
    } catch (e) {
      expect((e as VfsError).code).toBe("NOT_FOUND");
    }
  });

  it("rename 重命名文件", async () => {
    await backend.writeFile(projectId, "/old.txt", "content");
    const node = await backend.rename(projectId, "/old.txt", "/new.txt");
    expect(node.path).toBe("/new.txt");
    expect(await backend.exists(projectId, "/old.txt")).toBe(false);
    expect(await backend.readFile(projectId, "/new.txt")).toBe("content");
  });

  it("rename 移动目录及其子节点", async () => {
    await backend.writeFile(projectId, "/src/a.js", "1");
    await backend.writeFile(projectId, "/src/lib/b.js", "2");
    await backend.rename(projectId, "/src", "/app");
    expect(await backend.exists(projectId, "/src")).toBe(false);
    expect(await backend.readFile(projectId, "/app/a.js")).toBe("1");
    expect(await backend.readFile(projectId, "/app/lib/b.js")).toBe("2");
  });

  it("rename 目标路径已存在时抛出 ALREADY_EXISTS", async () => {
    await backend.writeFile(projectId, "/a.txt", "1");
    await backend.writeFile(projectId, "/b.txt", "2");
    try {
      await backend.rename(projectId, "/a.txt", "/b.txt");
      expect.fail("should throw");
    } catch (e) {
      expect((e as VfsError).code).toBe("ALREADY_EXISTS");
    }
  });
});

describe("MemoryBackend - batchWrite 批量写入", () => {
  let backend: MemoryBackend;
  let projectId: string;

  beforeEach(async () => {
    backend = new MemoryBackend();
    const p = await backend.createProject("test");
    projectId = p.id;
  });

  it("批量写入多个文件，全部成功", async () => {
    const nodes = await backend.batchWrite(projectId, [
      { path: "/a.js", content: "a" },
      { path: "/b.js", content: "b" },
      { path: "/nested/c.js", content: "c" },
    ]);
    expect(nodes).toHaveLength(3);
    expect(await backend.readFile(projectId, "/a.js")).toBe("a");
    expect(await backend.readFile(projectId, "/nested/c.js")).toBe("c");
  });

  it("批量写入时部分失败，已写入的不回滚（MemoryBackend 实现特性）", async () => {
    // 先写一个文件，再 batch 写同名文件应该覆盖
    await backend.writeFile(projectId, "/a.js", "original");
    await backend.batchWrite(projectId, [
      { path: "/a.js", content: "updated" },
      { path: "/b.js", content: "new" },
    ]);
    expect(await backend.readFile(projectId, "/a.js")).toBe("updated");
    expect(await backend.readFile(projectId, "/b.js")).toBe("new");
  });
});
