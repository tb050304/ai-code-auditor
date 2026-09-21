/**
 * AST 自动修复框架（Day 15）
 *
 * 设计要点：
 * 1. 修复以「文本区间编辑（TextEdit）」表达，坐标约定与 Issue 一致
 *    （行列均 1-based，区间为 [start, end) 半开，endColumn = 末字符列 +1，
 *    与 Babel loc.end.column + 1 的存储约定相同）。
 * 2. 修复提案（FixProposal）是可结构化克隆的纯数据，可随 Worker 分析结果传递。
 * 3. applyFixes 是纯函数：所有编辑按「原始代码坐标」一次性校验、冲突检测后
 *    逆序拼接，避免顺序应用带来的偏移累积问题。
 * 4. 每个修复带风险等级（safe/review/risky），供 UI 决定是否需要人工确认。
 *
 * 本模块不依赖 Babel/React，规则侧在 lib/ast.ts 中基于 AST 节点生成编辑。
 */

/** 修复风险等级 */
export type FixRisk = "safe" | "review" | "risky";

/**
 * 文本区间编辑。
 * 替换 [startLine:startColumn, endLine:endColumn) 区间为 replacement；
 * 零长度区间（起止相同）表示插入，replacement 为空串表示删除。
 */
export interface TextEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  replacement: string;
  /**
   * 可选锚点：应用前该区间的当前文本必须与此完全相等，
   * 否则判定为 stale（分析后代码已被改动），跳过该修复，防止错改。
   */
  expected?: string;
}

/** 规则产出的修复提案（规则侧填充） */
export interface FixProposal {
  /** 一次修复可包含多个编辑，但同一提案内的编辑不得重叠 */
  edits: TextEdit[];
  /** 给用户看的描述，如「将 var 替换为 let」 */
  description: string;
  /** 风险等级 */
  risk: FixRisk;
}

/** 挂到 Issue 上的修复提案，带来源规则 id */
export interface IssueFix extends FixProposal {
  ruleId: string;
}

/** 修复被跳过的原因 */
export type FixSkipReason =
  | "empty" // 提案不含任何编辑
  | "invalid-edit" // 坐标非法（非正整数/起晚于止）
  | "out-of-range" // 坐标超出当前代码范围
  | "stale" // expected 锚点与当前代码不匹配
  | "overlap" // 与另一个被采纳的修复区间重叠
  | "no-op"; // 替换文本与原文一致，修复不产生变化

export interface AppliedFix {
  ruleId: string;
  description: string;
  risk: FixRisk;
  edits: TextEdit[];
}

export interface SkippedFix {
  ruleId: string;
  reason: FixSkipReason;
  message: string;
}

export interface ApplyFixesResult {
  /** 应用全部有效修复后的代码（CRLF 会被归一化为 \n） */
  code: string;
  applied: AppliedFix[];
  skipped: SkippedFix[];
}

/** 结构类型：任何带可选 fix 字段的对象都可做可修复判断 */
interface FixBearer {
  fix?: IssueFix | null;
}

/** 该问题是否带自动修复提案 */
export function isFixable(issue: FixBearer): boolean {
  return !!issue.fix && issue.fix.edits.length > 0;
}

interface SourceMap {
  /** 每行起始偏移，lines[i].start = offsets[i] */
  offsets: number[];
  /** 每行字符数（不含换行符） */
  lengths: number[];
  lineCount: number;
  length: number;
}

function buildSourceMap(code: string): SourceMap {
  const offsets: number[] = [0];
  const lengths: number[] = [];
  let lineStart = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "\n") {
      lengths.push(i - lineStart);
      offsets.push(i + 1);
      lineStart = i + 1;
    }
  }
  lengths.push(code.length - lineStart);
  return { offsets, lengths, lineCount: lengths.length, length: code.length };
}

function isPosInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

/**
 * 行列（1-based，与 TextEdit/Issue 同约定）→ 字符偏移。
 * 供规则侧从 Babel 节点 loc 切取源码文本；越界返回 null。
 * 输入假定已是 LF（调用方若读外部文件应先归一化 CRLF）。
 */
export function lineColumnToOffset(
  code: string,
  line: number,
  column: number,
): number | null {
  const map = buildSourceMap(code);
  return toOffset(map, line, column);
}

/** 行列（1-based）→ 字符偏移；坐标越界返回 null */
function toOffset(map: SourceMap, line: number, column: number): number | null {
  if (!isPosInt(line) || line > map.lineCount) return null;
  if (!isPosInt(column) || column > map.lengths[line - 1] + 1) return null;
  return map.offsets[line - 1] + (column - 1);
}

interface ValidatedEdit {
  edit: TextEdit;
  start: number;
  end: number;
}

type ValidateResult =
  | { ok: true; value: ValidatedEdit }
  | { ok: false; reason: Exclude<FixSkipReason, "overlap" | "empty" | "no-op">; message: string };

function validateEdit(code: string, map: SourceMap, edit: TextEdit): ValidateResult {
  if (!isPosInt(edit.startLine) || !isPosInt(edit.startColumn) ||
      !isPosInt(edit.endLine) || !isPosInt(edit.endColumn)) {
    return { ok: false, reason: "invalid-edit", message: "行列必须为正整数" };
  }
  if (typeof edit.replacement !== "string") {
    return { ok: false, reason: "invalid-edit", message: "replacement 必须是字符串" };
  }
  const start = toOffset(map, edit.startLine, edit.startColumn);
  const end = toOffset(map, edit.endLine, edit.endColumn);
  if (start === null || end === null) {
    return {
      ok: false,
      reason: "out-of-range",
      message: `编辑区间 (${edit.startLine}:${edit.startColumn}~${edit.endLine}:${edit.endColumn}) 超出代码范围`,
    };
  }
  if (start > end) {
    return { ok: false, reason: "invalid-edit", message: "起始位置晚于结束位置" };
  }
  if (edit.expected !== undefined && code.slice(start, end) !== edit.expected) {
    return {
      ok: false,
      reason: "stale",
      message: "锚点文本与当前代码不一致（代码可能在分析后被修改），已跳过",
    };
  }
  return { ok: true, value: { edit, start, end } };
}

/** 两个半开区间是否重叠（首尾相接不算重叠） */
function overlaps(a: ValidatedEdit, b: ValidatedEdit): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * 批量应用修复。
 *
 * - 入参顺序 = 问题在源码中出现的顺序；重叠冲突时跳过「起点更靠后」的整个修复，
 *   先到先得，结果确定。
 * - 单个修复非法/过期不影响其他修复，全部进入 skipped 报告。
 * - 所有编辑均以传入代码（归一化 CRLF 后）的坐标为准，一次性逆序拼接，
 *   不存在中途偏移。
 * - 单个修复场景直接传长度 1 的数组即可。
 */
export function applyFixes(code: string, fixes: IssueFix[]): ApplyFixesResult {
  const source = code.replace(/\r\n/g, "\n");
  const map = buildSourceMap(source);

  const applied: AppliedFix[] = [];
  const skipped: SkippedFix[] = [];
  /** 已采纳的编辑区间（带归属规则，用于冲突报告） */
  const accepted: Array<ValidatedEdit & { ruleId: string }> = [];

  // 按最早编辑起点排序处理，保证重叠时「靠前的修复」确定性获胜
  const earliest = (ve: ValidatedEdit[]) =>
    ve.reduce((m, v) => Math.min(m, v.start), Number.POSITIVE_INFINITY);

  const ordered = fixes
    .map((fix, index) => ({ fix, index }))
    .filter(({ fix }) => {
      if (fix.edits.length === 0) {
        skipped.push({ ruleId: fix.ruleId, reason: "empty", message: "修复提案不包含任何编辑" });
        return false;
      }
      return true;
    })
    .map(({ fix, index }) => {
      const validated: ValidateResult[] = fix.edits.map((e) => validateEdit(source, map, e));
      const okEdits: ValidatedEdit[] = [];
      for (const r of validated) {
        if (!r.ok) {
          skipped.push({ ruleId: fix.ruleId, reason: r.reason, message: r.message });
          return null;
        }
        okEdits.push(r.value);
      }
      return { fix, index, okEdits };
    })
    .filter((x): x is { fix: IssueFix; index: number; okEdits: ValidatedEdit[] } => x !== null)
    .sort((a, b) => earliest(a.okEdits) - earliest(b.okEdits) || a.index - b.index);

  for (const { fix, okEdits } of ordered) {
    // 提案内部重叠 = 非法提案
    let internalOverlap = false;
    for (let i = 0; i < okEdits.length; i++) {
      for (let j = i + 1; j < okEdits.length; j++) {
        if (overlaps(okEdits[i], okEdits[j])) {
          internalOverlap = true;
          break;
        }
      }
      if (internalOverlap) break;
    }
    if (internalOverlap) {
      skipped.push({ ruleId: fix.ruleId, reason: "invalid-edit", message: "修复提案内部编辑区间互相重叠" });
      continue;
    }

    // 与已采纳修复的冲突：整组放弃
    const clashWith = okEdits
      .map((e) => accepted.find((a) => overlaps(a, e)))
      .find((a): a is (typeof accepted)[number] => !!a);
    if (clashWith) {
      skipped.push({
        ruleId: fix.ruleId,
        reason: "overlap",
        message: `与规则 ${clashWith.ruleId} 的修复区间重叠，已跳过`,
      });
      continue;
    }

    // no-op：每个编辑替换后文本都与原文相同
    if (okEdits.every(({ edit, start, end }) => source.slice(start, end) === edit.replacement)) {
      skipped.push({ ruleId: fix.ruleId, reason: "no-op", message: "修复不改变任何内容" });
      continue;
    }

    for (const v of okEdits) accepted.push({ ...v, ruleId: fix.ruleId });
    applied.push({
      ruleId: fix.ruleId,
      description: fix.description,
      risk: fix.risk,
      edits: fix.edits,
    });
  }

  // 全部有效编辑以原始坐标逆序拼接
  const all = accepted
    .slice()
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let result = source;
  for (const { start, end, edit } of all) {
    result = result.slice(0, start) + edit.replacement + result.slice(end);
  }

  // applied 按最早编辑位置升序（= 问题在源码中出现的顺序），便于 UI 展示
  return { code: result, applied, skipped };
}
