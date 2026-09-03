# 🛡️ AI Code Auditor (项目 B)

## 📖 项目简介

本项目是基于 Next.js 和 Monaco Editor 打造的 Web 智能代码审计 IDE。通过集成 DeepSeek 大模型，实现对前端代码的实时漏洞扫描、代码规范审查以及 AST 层面的逻辑优化建议。

## 🎯 核心目标 (Roadmap)

- **Phase 1**: 集成 Monaco Editor，构建左右分屏的沉浸式 Web IDE 界面。 ✅
- **Phase 2**: 打通 Next.js API Routes，实现前后端数据流与流式响应 (Streaming)。 ✅
- **Phase 3**: 接入 DeepSeek 大语言模型，提供代码审计与优化建议。 ✅
- **Phase 4**: 预研 AST (抽象语法树) 解析，实现精准的代码高亮标记与漏洞定位。 ✅
- **Phase 5**: 会话管理（历史对话、新建/切换/删除/重命名）与多轮追问上下文。 ✅

## ✨ 核心功能

- **AST 静态分析**：基于 Babel 在本地解析代码并高亮问题（安全 / React / 可维护性 / 最佳实践）。
- **AI 流式审计**：调用 DeepSeek 等模型，SSE 流式输出审计报告。
- **多会话管理**：左侧边栏可新建、切换、删除、双击重命名对话，历史数据本地持久化。
- **多轮追踪**：切换会话保留上下文；追问时后端附带此前的消息历史，模型拥有完整语境。
- **代码恢复**：切换/新建会话时，编辑器自动恢复到该会话的最后一次待审计代码。
- **健壮性**：本地存储具备版本化、损坏容错与容量守卫，存储写入失败不中断使用。

## 🛠️ 技术栈

- **Framework**: Next.js 16 (App Router) + React 19
- **Language**: TypeScript
- **IDE Engine**: `@monaco-editor/react`
- **Styling**: Tailwind CSS
- **AI Integration**: DeepSeek / OpenAI / Anthropic / Gemini（OpenAI 兼容格式流式）

## 📂 目录约定

- `/app`: 路由控制与页面入口（含 `/api/ast`、`/api/audit`）
- `/components`: 视图层组件（Editor、Console、ConversationSidebar）
- `/lib`: 核心业务逻辑（`ast`、`modelService`、`persistence`、`messages`）
- `/hooks`: 状态管理与数据请求（`useAuditor`、`useASTAnalysis`、`useConversations`）
- `/types`: TypeScript 接口统一定义（含会话/消息模型）

## 🔄 数据流

1. 用户在编辑器输入代码，触发 AST 自动分析并高亮。
2. 点击「运行审计」→ 先做 AST 分析，再将本次代码/追问写入当前会话。
3. 前端构建多轮历史 → `POST /api/audit` 流式返回 → 追加到当前 session 的 assistant 消息。
4. 会话数据经 `lib/persistence.ts`（localStorage 后端）去抖持久化。

## 🚀 启动指南

```bash
npm install
npm run dev
```

> 需在 `.env.local` 配置至少一个可用模型的 API Key（如 `DEEPSEEK_API_KEY`）。
> 可选：`NEXT_PUBLIC_DEFAULT_CODE` 可覆盖编辑器默认示例代码。