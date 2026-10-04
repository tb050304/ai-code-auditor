/**
 * 对话消息构造测试（Day 22 重点 + 历史回归）
 *
 * 覆盖：
 * - 系统提示按模式选择（audit / chat）
 * - buildChatUserContent：提问为主体、代码可选
 * - buildUserContent：审计格式回归
 * - buildHistoryMessages：chat 模式无代码消息纳入历史、混合模式按各自格式重建、
 *   running/error 消息排除
 */

import { describe, it, expect } from "vitest";
import {
  AUDIT_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  getSystemPrompt,
  buildUserContent,
  buildChatUserContent,
  buildHistoryMessages,
  createMessage,
} from "@/lib/messages";
import type { Conversation } from "@/types";

function makeConversation(messages: Conversation["messages"]): Conversation {
  return {
    id: "conv-1",
    title: "测试会话",
    createdAt: 0,
    updatedAt: 0,
    messages,
  };
}

describe("getSystemPrompt", () => {
  it("audit 与 chat 返回各自的系统提示，agent 回落到审计提示", () => {
    expect(getSystemPrompt("audit")).toBe(AUDIT_SYSTEM_PROMPT);
    expect(getSystemPrompt("chat")).toBe(CHAT_SYSTEM_PROMPT);
    // agent 的提示由 /api/agent 单独注入，这里只需保证不抛错
    expect(getSystemPrompt("agent")).toBe(AUDIT_SYSTEM_PROMPT);
    expect(CHAT_SYSTEM_PROMPT).toContain("编程助手");
    expect(AUDIT_SYSTEM_PROMPT).toContain("审计报告");
  });
});

describe("buildChatUserContent（通用编程模式）", () => {
  it("无代码时只发送问题原文", () => {
    expect(buildChatUserContent(undefined, "帮我写个防抖")).toBe("帮我写个防抖");
    expect(buildChatUserContent("", "  ")).toBe("");
  });

  it("空白代码等同于无代码", () => {
    expect(buildChatUserContent("   \n  ", "解释下闭包")).toBe("解释下闭包");
  });

  it("有代码时作为参考上下文附带，问题在末尾", () => {
    const text = buildChatUserContent("const a = 1;", "这段代码什么意思");
    expect(text).toContain("当前编辑器中的代码");
    expect(text).toContain("const a = 1;");
    expect(text).toContain("我的问题 / 需求");
    expect(text).toContain("这段代码什么意思");
    // 不应使用审计模式的措辞
    expect(text).not.toContain("待审计代码");
  });

  it("有代码但无问题时只附代码（不输出空标题）", () => {
    const text = buildChatUserContent("const a = 1;");
    expect(text).toContain("const a = 1;");
    expect(text).not.toContain("我的问题");
  });
});

describe("buildUserContent（审计模式回归）", () => {
  it("代码为主体，补充要求拼接在后", () => {
    const text = buildUserContent("var x = 1;", "重点看安全问题");
    expect(text.startsWith("待审计代码如下")).toBe(true);
    expect(text).toContain("var x = 1;");
    expect(text).toContain("用户补充要求");
    expect(text).toContain("重点看安全问题");
  });

  it("无补充要求时不输出分隔标题", () => {
    const text = buildUserContent("var x = 1;");
    expect(text).not.toContain("用户补充要求");
  });
});

describe("buildHistoryMessages", () => {
  it("chat 模式无代码的 user 消息直接以提问纳入", () => {
    const conv = makeConversation([
      createMessage("user", { status: "done", mode: "chat", userPrompt: "什么是闭包？" }),
      createMessage("assistant", { status: "done", content: "闭包是…" }),
    ]);
    const history = buildHistoryMessages(conv);
    expect(history).toEqual([
      { role: "user", content: "什么是闭包？" },
      { role: "assistant", content: "闭包是…" },
    ]);
  });

  it("audit 模式无代码的旧消息仍被跳过（向后兼容）", () => {
    const conv = makeConversation([
      createMessage("user", { status: "done", userPrompt: "没有代码快照的旧消息" }),
    ]);
    expect(buildHistoryMessages(conv)).toEqual([]);
  });

  it("混合模式：按各消息的 mode 选择重建格式", () => {
    const conv = makeConversation([
      createMessage("user", {
        status: "done",
        mode: "audit",
        code: "var a = 1;",
        userPrompt: "审计它",
      }),
      createMessage("assistant", { status: "done", content: "报告：var 有风险" }),
      createMessage("user", { status: "done", mode: "chat", userPrompt: "那改成 let 怎么写" }),
      createMessage("assistant", { status: "done", content: "let a = 1;" }),
    ]);
    const history = buildHistoryMessages(conv);
    expect(history).toHaveLength(4);
    expect(history[0].content).toContain("待审计代码");
    expect(history[2].content).toBe("那改成 let 怎么写");
  });

  it("running / error 状态的 user 消息不纳入；无内容 assistant 不纳入", () => {
    const conv = makeConversation([
      createMessage("user", { status: "running", mode: "chat", userPrompt: "正在发送" }),
      createMessage("user", { status: "error", mode: "chat", userPrompt: "发送失败" }),
      createMessage("assistant", { status: "running", content: "半截输出" }),
      createMessage("assistant", { status: "done", content: "" }),
      createMessage("user", { status: "done", mode: "chat", userPrompt: "有效问题" }),
      createMessage("assistant", { status: "done", content: "有效回答" }),
    ]);
    const history = buildHistoryMessages(conv);
    expect(history).toEqual([
      { role: "user", content: "有效问题" },
      { role: "assistant", content: "有效回答" },
    ]);
  });

  it("chat 消息的空问题（无 prompt 无 code）被跳过", () => {
    const conv = makeConversation([
      createMessage("user", { status: "done", mode: "chat" }),
    ]);
    expect(buildHistoryMessages(conv)).toEqual([]);
  });

  it("untilMessageId 之前的消息才纳入", () => {
    const u1 = createMessage("user", { status: "done", mode: "chat", userPrompt: "问题一" });
    const a1 = createMessage("assistant", { status: "done", content: "回答一" });
    const u2 = createMessage("user", { status: "done", mode: "chat", userPrompt: "问题二" });
    const conv = makeConversation([u1, a1, u2]);
    expect(buildHistoryMessages(conv, u2.id)).toEqual([
      { role: "user", content: "问题一" },
      { role: "assistant", content: "回答一" },
    ]);
  });
});
