import { analyzeCodeStream } from "@/lib/modelService";
import type { AuditHistoryMessage } from "@/types";

/** 从 unknown 中安全提取错误消息，避免在 catch 中使用 any */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" ? error : "未知错误";
}

export async function POST(req: Request) {
  try {
    // history 为可选的多轮上下文（此前 user/assistant 消息）
    const { code, model, userPrompt, history }: {
      code: string;
      model?: string;
      userPrompt?: string;
      history?: AuditHistoryMessage[];
    } = await req.json();

    if (!code || typeof code !== "string" || code.trim() === "") {
      return new Response("代码不能为空", { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of analyzeCodeStream(code, model, userPrompt, history)) {
            if (chunk.done) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(chunk.content));
          }
        } catch (error: unknown) {
          console.error("Stream error:", error);
          controller.enqueue(
            encoder.encode(`\n\n**流式传输错误: ${errorMessage(error)}**`)
          );
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
    console.error("API Error:", error);
    return new Response(`AI 审计服务出现异常: ${errorMessage(error)}`, { status: 500 });
  }
}

export async function GET() {
  const models = await getAvailableModels();
  return Response.json(models);
}

async function getAvailableModels() {
  const { getAvailableModels: fetchModels } = await import("@/lib/models");
  return fetchModels();
}