# 🛡️ AI Code Auditor (项目 B)

## 📖 项目简介

本项目是基于 Next.js 和 Monaco Editor 打造的 Web 智能代码审计 IDE。通过集成 DeepSeek 大模型，实现对前端代码的实时漏洞扫描、代码规范审查以及 AST 层面的逻辑优化建议。

## 🎯 核心目标 (Roadmap)

- **Phase 1**: 集成 Monaco Editor，构建左右分屏的沉浸式 Web IDE 界面。 ✅
- **Phase 2**: 打通 Next.js API Routes，实现前后端数据流与流式响应 (Streaming)。 ✅
- **Phase 3**: 接入 DeepSeek 大语言模型，提供代码审计与优化建议。 ✅
- **Phase 4**: 预研 AST (抽象语法树) 解析，实现精准的代码高亮标记与漏洞定位。 ✅

## 🛠️ 技术栈

- **Framework**: Next.js 14/15 (App Router)
- **Language**: TypeScript
- **IDE Engine**: `@monaco-editor/react`
- **Styling**: Tailwind CSS
- **AI Integration**: DeepSeek API

## 📂 目录约定

- `/app`: 路由控制与页面入口
- `/components`: 视图层组件 (Editor, Console)
- `/lib`: 核心业务逻辑与 AI 客户端封装
- `/hooks`: 状态管理与数据请求
- `/types`: TypeScript 接口统一定义

## 🚀 启动指南

```bash
npm install
npm run dev
```
