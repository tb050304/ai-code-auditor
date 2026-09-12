import { describe, it, expect } from "vitest";
import {
  splitLines,
  computeChunks,
  getChangeChunks,
  mergeLines,
  mergeTexts,
  countChanges,
  describeChunkRange,
} from "@/lib/diff/lines";

describe("splitLines", () => {
  it("规范化 CRLF 为 LF", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b", ""]);
  });
  it("空文本得到一个空行（Monaco 模型约定）", () => {
    expect(splitLines("")).toEqual([""]);
  });
});

describe("computeChunks - 基础场景", () => {
  it("完全相同 → 只有一个 equal 块、0 个 change", () => {
    const chunks = computeChunks(["a", "b"], ["a", "b"]);
    expect(countChanges(chunks)).toBe(0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("equal");
  });

  it("完全不同 → 一个 change 块", () => {
    const chunks = computeChunks(["a"], ["b"]);
    const changes = getChangeChunks(chunks);
    expect(changes).toHaveLength(1);
    expect(changes[0].oldStart).toBe(0);
    expect(changes[0].newStart).toBe(0);
  });

  it("空旧文本 → 全部为新增（空文档按 Monaco 约定含一个空行）", () => {
    const chunks = computeChunks([""], ["a", "b"]);
    const changes = getChangeChunks(chunks);
    expect(changes).toHaveLength(1);
    // 旧侧的空行被替换为 2 个新行
    expect(changes[0].oldEnd - changes[0].oldStart).toBe(1);
    expect(changes[0].newEnd - changes[0].newStart).toBe(2);
    // 接受后得到新内容，拒绝后回到空文档
    expect(mergeLines([""], ["a", "b"], chunks, new Set([0]))).toEqual(["a", "b"]);
    expect(mergeLines([""], ["a", "b"], chunks, new Set())).toEqual([""]);
  });

  it("纯删除：新文本为空", () => {
    const chunks = computeChunks(["a", "b"], [""]);
    const changes = getChangeChunks(chunks);
    expect(changes).toHaveLength(1);
    expect(changes[0].oldEnd - changes[0].oldStart).toBe(2);
    // 新侧空文档保留一个空行
    expect(changes[0].newEnd - changes[0].newStart).toBe(1);
    expect(mergeLines(["a", "b"], [""], chunks, new Set([0]))).toEqual([""]);
  });

  it("中间修改：相邻的删除+插入合并为一个 change 块", () => {
    const oldLines = ["1", "2", "3", "4"];
    const newLines = ["1", "TWO", "3", "4"];
    const changes = getChangeChunks(computeChunks(oldLines, newLines));
    expect(changes).toHaveLength(1);
    expect(changes[0].oldStart).toBe(1);
    expect(changes[0].newStart).toBe(1);
  });

  it("多处不相邻修改 → 多个 change 块，中间夹 equal 块", () => {
    const oldLines = ["a", "keep", "b", "keep2", "c"];
    const newLines = ["A", "keep", "B", "keep2", "C"];
    const changes = getChangeChunks(computeChunks(oldLines, newLines));
    expect(changes).toHaveLength(3);
    // id 按顺序分配
    expect(changes.map((c) => c.id)).toEqual([0, 1, 2]);
  });

  it("change id 只在 change 块上递增", () => {
    const oldLines = ["a", "x", "b"];
    const newLines = ["A", "x", "B"];
    const chunks = computeChunks(oldLines, newLines);
    expect(chunks[0].type).toBe("change");
    expect(chunks[0].id).toBe(0);
    expect(chunks[2].type).toBe("change");
    expect(chunks[2].id).toBe(1);
    expect(chunks[1].id).toBeUndefined();
  });
});

describe("mergeLines - 逐块接受/拒绝", () => {
  it("全部拒绝（空 accepted）=== 旧文本", () => {
    const oldLines = ["a", "keep", "b"];
    const newLines = ["A", "keep", "B"];
    const chunks = computeChunks(oldLines, newLines);
    expect(mergeLines(oldLines, newLines, chunks, new Set())).toEqual(oldLines);
  });

  it("全部接受 === 新文本", () => {
    const oldLines = ["a", "keep", "b"];
    const newLines = ["A", "keep", "B"];
    const chunks = computeChunks(oldLines, newLines);
    const all = new Set(chunks.filter((c) => c.id !== undefined).map((c) => c.id!));
    expect(mergeLines(oldLines, newLines, chunks, all)).toEqual(newLines);
  });

  it("只接受第一块：A keep b", () => {
    const oldLines = ["a", "keep", "b"];
    const newLines = ["A", "keep", "B"];
    const chunks = computeChunks(oldLines, newLines);
    expect(mergeLines(oldLines, newLines, chunks, new Set([0]))).toEqual(["A", "keep", "b"]);
  });

  it("只接受第二块：a keep B", () => {
    const oldLines = ["a", "keep", "b"];
    const newLines = ["A", "keep", "B"];
    const chunks = computeChunks(oldLines, newLines);
    expect(mergeLines(oldLines, newLines, chunks, new Set([1]))).toEqual(["a", "keep", "B"]);
  });

  it("纯插入被接受时行数增加", () => {
    const oldLines = ["a", "c"];
    const newLines = ["a", "b", "c"];
    const chunks = computeChunks(oldLines, newLines);
    const changes = getChangeChunks(chunks);
    expect(mergeLines(oldLines, newLines, chunks, new Set([changes[0].id!]))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("纯删除被接受时行数减少", () => {
    const oldLines = ["a", "b", "c"];
    const newLines = ["a", "c"];
    const chunks = computeChunks(oldLines, newLines);
    const changes = getChangeChunks(chunks);
    expect(mergeLines(oldLines, newLines, chunks, new Set([changes[0].id!]))).toEqual([
      "a",
      "c",
    ]);
  });

  it("两边都空文本不报错", () => {
    const chunks = computeChunks([""], [""]);
    expect(mergeLines([""], [""], chunks, new Set())).toEqual([""]);
  });
});

describe("mergeTexts / 工具函数", () => {
  it("mergeTexts 处理 CRLF 并返回文本", () => {
    const { text, chunks } = mergeTexts("a\r\nb", "a\r\nB", new Set());
    expect(text).toBe("a\nb"); // 拒绝 = 旧内容，换行统一为 LF
    expect(countChanges(chunks)).toBe(1);
  });

  it("describeChunkRange 普通区间与空区间", () => {
    const oldLines = ["1", "2"];
    const newLines = ["1", "x", "2"];
    const change = getChangeChunks(computeChunks(oldLines, newLines))[0];
    const range = describeChunkRange(change);
    expect(range.old).toContain("L2"); // 纯插入，旧侧空区间
    expect(range.new).toBe("L2");
  });
});
