/**
 * /api/agent —— Agent 思考-执行循环的模型调用端点（Day 20）
 *
 * 设计：无状态转发。循环由前端驱动（工具在浏览器端执行：
 * IndexedDB VFS / Worker AST 分析），本端点只做一次"多轮 messages →
 * 流式文本"的转发，并在头部注入 Agent 系统提示（含工具目录）。
 * 前端每轮循环 POST 一次，直到模型不再输出工具调用块。
 */

import { chatStream, type ChatMessage } from "@/lib/modelService";
import { buildAgentSystemPrompt } from "@/lib/agent/prompt";

/** 从 unknown 中安全提取错误消息 */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" ? error : "未知错误";
}

const VALID_ROLES = new Set(["system", "user", "assistant"]);

function isValidMessages(messages: unknown): messages is ChatMessage[] {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every(
      (m) =>
        m &&
        typeof m === "object" &&
        VALID_ROLES.has((m as { role?: unknown }).role as string) &&
        typeof (m as { content?: unknown }).content === "string",
    )
  );
}

export async function POST(req: Request) {
  try {
    const { messages, model }: { messages?: ChatMessage[]; model?: string } = await req.json();

    if (!isValidMessages(messages)) {
      return Response.json(
        { error: "messages 必须为非空数组，且每项含合法 role 与字符串 content" },
        { status: 400 },
      );
    }

    // 注入 Agent 系统提示（调用方未自带 system 时）
    const finalMessages: ChatMessage[] =
      messages[0]?.role === "system"
        ? messages
        : [{ role: "system", content: buildAgentSystemPrompt() }, ...messages];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of chatStream(finalMessages, model)) {
            if (chunk.done) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(chunk.content));
          }
          controller.close();
        } catch (error: unknown) {
          console.error("Agent stream error:", error);
          controller.enqueue(encoder.encode(`\n\n**流式传输错误: ${errorMessage(error)}**`));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error: unknown) {
    console.error("Agent API Error:", error);
    return Response.json({ error: `Agent 服务出现异常: ${errorMessage(error)}` }, { status: 500 });
  }
}
