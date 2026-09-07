import { describe, it, expect } from "vitest";
import {
  summarizeIssues,
  buildTreeIssueMap,
  groupIssuesByFile,
  type NodeIssueSummary,
} from "@/lib/ast/issue-aggregate";
import type { TreeNode } from "@/lib/storage/file-tree";
import type { FileAnalysisResult } from "@/lib/ast/batch-types";
import type { Issue } from "@/lib/ast";

function makeIssue(
  id: string,
  severity: "error" | "warning" | "info",
  startLine = 1,
): Issue {
  return {
    id,
    name: id,
    type: "best-practice",
    severity,
    message: id,
    startLine,
    startColumn: 1,
    endLine: startLine,
    endColumn: 5,
  };
}

function makeFileResult(issues: Issue[]): FileAnalysisResult {
  return {
    path: "/test.js",
    success: true,
    issues,
    duration: 0,
    contentHash: "hash",
  };
}

function makeNode(overrides: Partial<TreeNode> & { path: string; name: string; type: "file" | "directory" }): TreeNode {
  return {
    size: 0,
    mtime: 0,
    ctime: 0,
    ...overrides,
  };
}

describe("summarizeIssues", () => {
  it("空问题列表返回 none 级别", () => {
    const summary = summarizeIssues([]);
    expect(summary.level).toBe("none");
    expect(summary.total).toBe(0);
    expect(summary.errorCount).toBe(0);
    expect(summary.warningCount).toBe(0);
    expect(summary.infoCount).toBe(0);
  });

  it("只有 error 时 level 为 error", () => {
    const summary = summarizeIssues([makeIssue("e1", "error")]);
    expect(summary.level).toBe("error");
    expect(summary.errorCount).toBe(1);
    expect(summary.total).toBe(1);
  });

  it("只有 warning 时 level 为 warning", () => {
    const summary = summarizeIssues([makeIssue("w1", "warning")]);
    expect(summary.level).toBe("warning");
    expect(summary.warningCount).toBe(1);
  });

  it("只有 info 时 level 为 info", () => {
    const summary = summarizeIssues([makeIssue("i1", "info")]);
    expect(summary.level).toBe("info");
    expect(summary.infoCount).toBe(1);
  });

  it("混合严重程度取最高级别", () => {
    const summary = summarizeIssues([
      makeIssue("e1", "error"),
      makeIssue("w1", "warning"),
      makeIssue("i1", "info"),
      makeIssue("i2", "info"),
    ]);
    expect(summary.level).toBe("error");
    expect(summary.errorCount).toBe(1);
    expect(summary.warningCount).toBe(1);
    expect(summary.infoCount).toBe(2);
    expect(summary.total).toBe(4);
  });

  it("warning + info 取 warning", () => {
    const summary = summarizeIssues([
      makeIssue("w1", "warning"),
      makeIssue("i1", "info"),
    ]);
    expect(summary.level).toBe("warning");
  });
});

describe("buildTreeIssueMap", () => {
  it("空树返回空 map", () => {
    const root = makeNode({ path: "/", name: "", type: "directory" });
    const map = buildTreeIssueMap(root, new Map());
    expect(map.size).toBe(1); // 根目录本身
    expect(map.get("/")?.level).toBe("none");
  });

  it("单文件树 - 文件有问题", () => {
    const root = makeNode({
      path: "/",
      name: "",
      type: "directory",
      children: [makeNode({ path: "/a.js", name: "a.js", type: "file" })],
    });
    const fileResults = new Map<string, FileAnalysisResult>([
      ["/a.js", { ...makeFileResult([makeIssue("e1", "error")]), path: "/a.js" }],
    ]);
    const map = buildTreeIssueMap(root, fileResults);
    expect(map.get("/a.js")?.level).toBe("error");
    expect(map.get("/a.js")?.errorCount).toBe(1);
    // 根目录也聚合
    expect(map.get("/")?.level).toBe("error");
    expect(map.get("/")?.total).toBe(1);
  });

  it("多层目录递归聚合", () => {
    const root = makeNode({
      path: "/",
      name: "",
      type: "directory",
      children: [
        makeNode({
          path: "/src",
          name: "src",
          type: "directory",
          children: [
            makeNode({ path: "/src/a.js", name: "a.js", type: "file" }),
            makeNode({
              path: "/src/lib",
              name: "lib",
              type: "directory",
              children: [
                makeNode({ path: "/src/lib/b.js", name: "b.js", type: "file" }),
              ],
            }),
          ],
        }),
        makeNode({ path: "/readme.md", name: "readme.md", type: "file" }),
      ],
    });

    const fileResults = new Map<string, FileAnalysisResult>([
      ["/src/a.js", { ...makeFileResult([makeIssue("e1", "error"), makeIssue("w1", "warning")]), path: "/src/a.js" }],
      ["/src/lib/b.js", { ...makeFileResult([makeIssue("i1", "info")]), path: "/src/lib/b.js" }],
      ["/readme.md", { ...makeFileResult([]), path: "/readme.md" }],
    ]);

    const map = buildTreeIssueMap(root, fileResults);

    // 文件级
    expect(map.get("/src/a.js")?.level).toBe("error");
    expect(map.get("/src/a.js")?.total).toBe(2);
    expect(map.get("/src/lib/b.js")?.level).toBe("info");
    expect(map.get("/readme.md")?.level).toBe("none");

    // 目录级聚合
    expect(map.get("/src/lib")?.level).toBe("info");
    expect(map.get("/src/lib")?.total).toBe(1);
    expect(map.get("/src")?.level).toBe("error");
    expect(map.get("/src")?.total).toBe(3); // 2 + 1
    expect(map.get("/src")?.errorCount).toBe(1);
    expect(map.get("/src")?.warningCount).toBe(1);
    expect(map.get("/src")?.infoCount).toBe(1);

    // 根目录
    expect(map.get("/")?.level).toBe("error");
    expect(map.get("/")?.total).toBe(3);
  });

  it("没有分析结果的文件显示为 none", () => {
    const root = makeNode({
      path: "/",
      name: "",
      type: "directory",
      children: [makeNode({ path: "/a.js", name: "a.js", type: "file" })],
    });
    const map = buildTreeIssueMap(root, new Map());
    expect(map.get("/a.js")?.level).toBe("none");
  });
});

describe("groupIssuesByFile", () => {
  it("空结果返回空数组", () => {
    const groups = groupIssuesByFile(new Map());
    expect(groups).toEqual([]);
  });

  it("跳过无问题的文件", () => {
    const fileResults = new Map<string, FileAnalysisResult>([
      ["/clean.js", { ...makeFileResult([]), path: "/clean.js" }],
    ]);
    const groups = groupIssuesByFile(fileResults);
    expect(groups).toHaveLength(0);
  });

  it("按文件分组并包含摘要", () => {
    const fileResults = new Map<string, FileAnalysisResult>([
      ["/a.js", { ...makeFileResult([makeIssue("e1", "error")]), path: "/a.js" }],
      ["/b.js", { ...makeFileResult([makeIssue("w1", "warning")]), path: "/b.js" }],
    ]);
    const groups = groupIssuesByFile(fileResults);
    expect(groups).toHaveLength(2);
  });

  it("组内问题按严重程度排序，error 在前", () => {
    const issues = [
      makeIssue("i1", "info", 10),
      makeIssue("e1", "error", 1),
      makeIssue("w1", "warning", 5),
    ];
    const fileResults = new Map<string, FileAnalysisResult>([
      ["/a.js", { ...makeFileResult(issues), path: "/a.js" }],
    ]);
    const groups = groupIssuesByFile(fileResults);
    expect(groups).toHaveLength(1);
    const sorted = groups[0].issues;
    expect(sorted[0].severity).toBe("error");
    expect(sorted[1].severity).toBe("warning");
    expect(sorted[2].severity).toBe("info");
  });

  it("同严重程度按行号排序", () => {
    const issues = [
      makeIssue("w2", "warning", 20),
      makeIssue("w1", "warning", 5),
      makeIssue("w3", "warning", 10),
    ];
    const fileResults = new Map<string, FileAnalysisResult>([
      ["/a.js", { ...makeFileResult(issues), path: "/a.js" }],
    ]);
    const groups = groupIssuesByFile(fileResults);
    const sorted = groups[0].issues;
    expect(sorted.map(i => i.startLine)).toEqual([5, 10, 20]);
  });

  it("文件组按最高严重程度排序", () => {
    const fileResults = new Map<string, FileAnalysisResult>([
      ["/info.js", { ...makeFileResult([makeIssue("i1", "info")]), path: "/info.js" }],
      ["/error.js", { ...makeFileResult([makeIssue("e1", "error")]), path: "/error.js" }],
      ["/warn.js", { ...makeFileResult([makeIssue("w1", "warning")]), path: "/warn.js" }],
    ]);
    const groups = groupIssuesByFile(fileResults);
    expect(groups[0].path).toBe("/error.js");
    expect(groups[1].path).toBe("/warn.js");
    expect(groups[2].path).toBe("/info.js");
  });

  it("同严重程度的组按问题总数排序", () => {
    const fileResults = new Map<string, FileAnalysisResult>([
      ["/few.js", { ...makeFileResult([makeIssue("e1", "error")]), path: "/few.js" }],
      ["/many.js", { ...makeFileResult([makeIssue("e1", "error"), makeIssue("e2", "error")]), path: "/many.js" }],
    ]);
    const groups = groupIssuesByFile(fileResults);
    expect(groups[0].path).toBe("/many.js");
    expect(groups[1].path).toBe("/few.js");
  });

  it("跳过分析失败的文件", () => {
    const fileResults = new Map<string, FileAnalysisResult>([
      ["/bad.js", {
        path: "/bad.js",
        success: false,
        error: "parse error",
        issues: [],
        duration: 0,
        contentHash: "hash",
      }],
      ["/good.js", { ...makeFileResult([makeIssue("w1", "warning")]), path: "/good.js" }],
    ]);
    const groups = groupIssuesByFile(fileResults);
    expect(groups).toHaveLength(1);
    expect(groups[0].path).toBe("/good.js");
  });
});
