/**
 * 纯函数行级 diff 引擎（LCS）。
 * 不依赖 Monaco / DOM，可在 Vitest 中独立测试，UI 层只负责展示。
 */

/** 一个 diff 块；行号区间为 0-based 半开区间 [start, end)，对各自文本的行数组索引 */
export interface DiffChunk {
  /** change = 有差异（新增/删除/修改），equal = 上下文相同行 */
  type: "change" | "equal";
  /** change 块的序号（仅 change 有值，从 0 开始），UI 接受/拒绝用它做 key */
  id?: number;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** 规范化换行：Monaco 内部统一用 \n */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * 用 LCS 计算两份文本的行级 diff，输出按顺序排列的块。
 * 相邻的删除/插入会合并成同一个 change 块（git hunk 风格）。
 */
export function computeChunks(oldLines: string[], newLines: string[]): DiffChunk[] {
  const m = oldLines.length;
  const n = newLines.length;

  // dp[i][j] = oldLines[i..] 与 newLines[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 回溯得到操作序列（倒序生成后反转）
  type Op = "eq" | "del" | "ins";
  const ops: Array<{ op: Op }> = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      ops.push({ op: "eq" });
      i++;
      j++;
    } else if (j < n && (i === m || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ op: "ins" });
      j++;
    } else {
      ops.push({ op: "del" });
      i++;
    }
  }

  // 把操作序列聚合成块
  const chunks: DiffChunk[] = [];
  let oi = 0;
  let ni = 0;
  let changeId = 0;
  let k = 0;
  while (k < ops.length) {
    const startOld = oi;
    const startNew = ni;
    const isEqual = ops[k].op === "eq";
    while (k < ops.length && (isEqual ? ops[k].op === "eq" : ops[k].op !== "eq")) {
      if (ops[k].op === "eq" || ops[k].op === "del") oi++;
      if (ops[k].op === "eq" || ops[k].op === "ins") ni++;
      k++;
    }
    const chunk: DiffChunk = {
      type: isEqual ? "equal" : "change",
      oldStart: startOld,
      oldEnd: oi,
      newStart: startNew,
      newEnd: ni,
    };
    if (!isEqual) chunk.id = changeId++;
    chunks.push(chunk);
  }

  return chunks;
}

/** 只取 change 块（UI 的 chunk 列表用） */
export function getChangeChunks(chunks: DiffChunk[]): DiffChunk[] {
  return chunks.filter((c) => c.type === "change");
}

/**
 * 按逐块决策合并出最终文本。
 * @param accepted 被接受的 change 块 id 集合；未在集合中的块按"拒绝"处理（保留旧文本）
 *
 * 约定（与 git 的逐 hunk 操作一致）：
 * - equal 块：旧文本和新文本相同，直接取
 * - change 块：接受 → 取新文本行；拒绝 → 取旧文本行
 * 因此：全部拒绝 === 旧文本，全部接受 === 新文本。
 */
export function mergeLines(
  oldLines: string[],
  newLines: string[],
  chunks: DiffChunk[],
  accepted: Set<number>,
): string[] {
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.type === "equal" || chunk.id === undefined || !accepted.has(chunk.id)) {
      for (let x = chunk.oldStart; x < chunk.oldEnd; x++) result.push(oldLines[x]);
    } else {
      for (let x = chunk.newStart; x < chunk.newEnd; x++) result.push(newLines[x]);
    }
  }
  return result;
}

/** 便捷入口：文本进、文本出 */
export function mergeTexts(
  oldText: string,
  newText: string,
  accepted: Set<number>,
): { text: string; chunks: DiffChunk[] } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const chunks = computeChunks(oldLines, newLines);
  return { text: mergeLines(oldLines, newLines, chunks, accepted).join("\n"), chunks };
}

/** 统计 change 块数量 */
export function countChanges(chunks: DiffChunk[]): number {
  return chunks.reduce((sum, c) => sum + (c.type === "change" ? 1 : 0), 0);
}

/** 1-based 人类可读的行范围描述，如 "L3-L5"、"L12"、纯插入 "L12 后新增" */
export function describeChunkRange(chunk: DiffChunk): { old: string; new: string } {
  const fmt = (start: number, end: number): string => {
    if (start === end) return `L${start + 1} 后`; // 空区间：在该行之后
    if (end - start === 1) return `L${start + 1}`;
    return `L${start + 1}-L${end}`;
  };
  return { old: fmt(chunk.oldStart, chunk.oldEnd), new: fmt(chunk.newStart, chunk.newEnd) };
}
