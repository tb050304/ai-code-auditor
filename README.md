# AI Code Auditor

浏览器端智能代码审计 IDE。基于 Next.js 与 Monaco Editor，支持把整个前端项目导入浏览器，在本地完成 AST 静态分析、问题定位、自动修复，并可通过大模型进行多轮代码审计；同时内置一个能实际操作项目文件的 Agent，可以按自然语言指令自主完成"分析 → 修改 → 快照 → 验证"的完整流程。

项目数据（导入的项目文件、快照）保存在浏览器 IndexedDB 中，会话记录保存在 localStorage 中，不依赖任何后端数据库。模型调用通过 Next.js API Routes 转发，API Key 只存在于服务端环境变量，不会暴露到浏览器。

## 功能特性

### 多文件 IDE

- 拖拽整个文件夹或点击选择导入项目，自动过滤 node_modules、.git、dist、锁文件、大于 1MB 的文件与非文本文件
- 导入过程全屏进度展示：扫描、过滤、写入分阶段进度条与当前文件名
- 左侧文件树支持展开折叠、右键新建文件/文件夹、重命名、删除
- 多 Tab 编辑器，Monaco 内核，支持 .js / .jsx / .ts / .tsx / .mjs / .cjs 等文件类型
- 纯浏览器 VFS：IndexedDB 与内存双后端，切换项目互不干扰

### AST 静态分析

- 基于 Babel 在本地解析代码，Web Worker 异步批量分析，不阻塞界面
- 覆盖安全类规则（eval、new Function、innerHTML、硬编码密钥、SQL/命令注入、Math.random 等）、React 规则（列表缺 key、内联函数属性）、可维护性规则（var、==、debugger、console.log、魔法数字、超长函数、未使用 import、模板字符串拼接、未完成注释、硬编码联系方式等）
- 文件树与文件夹按问题严重程度标注，底部问题面板可点击直接跳转到对应文件与行号

### 自动修复

- 每条 AST 规则可附带修复提案，标注安全等级（可安全应用 / 需要人工确认 / 高风险）
- 已支持：var 转 let、eqeqeq、移除 debugger、移除独立 console.log、React 自动补 key、拼接转模板字符串（保留数字加法语义）、清理未使用 import
- 单文件"一键修复"与跨文件"全部修复"两个入口
- 修复默认进入 DiffViewer 预览：修复前后逐块对比，可逐块接受/拒绝/合并，也可一键全部回退
- 修复坐标与 Babel 定位一致，逆序应用避免偏移；提案带锚点校验，文件已被改动时自动跳过过期修改，防止错改

### 快照与版本管理

- 文件级快照：每次写入/修复自动生成，单个文件保留最近 50 个版本，增量编码存储（带检查点与链式修复）
- 项目级快照：给整个项目打版本标签，每个项目保留最近 20 个
- Monaco DiffEditor 左右对比与内联 diff 两种模式
- 文件历史时间线（文件树右键进入）与项目快照侧边栏，可回滚到任意版本；回滚前自动备份当前状态，删除的文件也能从历史恢复

### AI 审计会话

- 接入 DeepSeek（默认，走 OpenAI 兼容 SDK），也支持 OpenAI、Anthropic、Gemini 的配置项
- SSE 流式输出 Markdown 审计报告，生成过程可随时停止
- 多会话管理：新建、切换、删除、重命名，追问时自动携带此前的完整对话历史
- 会话本地持久化，带去抖写入、损坏容错与容量守卫

### Agent 思考-执行循环

- 控制台可切换到 Agent 模式，直接用自然语言下达任务（如"审计整个项目并自动修复所有可安全修复的问题"）
- 模型通过工具协议操作项目：listFiles、readFile、runAnalysis、applyAutoFix、writeFile、createSnapshot 共 6 个工具
- 多轮循环：模型思考 → 输出工具调用 → 浏览器端执行 → 结果回执 → 继续思考，最多 8 步自动止损，可随时中止
- 每一步在 Tool 面板流式展示：思考文本、调用的工具与参数、是否修改项目、耗时与结果摘要；执行失败的工具会以错误信息回执，模型可自行调整策略
- Agent 写入文件前自动生成快照，可与普通修复一样在 diff 视图中回退
- 工具调用协议与循环器均为纯函数实现，模型调用与工具执行依赖注入，可独立测试

## 技术栈

- Next.js 16（App Router）+ React 19 + TypeScript
- Monaco Editor（@monaco-editor/react）
- Tailwind CSS 4
- Babel（parser / traverse / generator / types）做 AST 分析与修复
- Web Worker 批量分析
- IndexedDB（文件与快照）+ localStorage（会话）
- OpenAI SDK / axios 对接模型流式接口
- Vitest 单元测试，ESLint，TypeScript 严格模式

## 快速开始

### 环境要求

- Node.js 20.9 或更高版本
- npm（仓库附带 package-lock.json，建议用 npm 安装以保证依赖一致）
- 至少一个可用的模型 API Key（默认使用 DeepSeek）

### 拉取代码并安装依赖

```bash
git clone https://github.com/tb050304/ai-code-auditor.git
cd ai-code-auditor
npm install
```

### 配置环境变量

仓库根目录提供了配置示例，复制一份并填入自己的 Key：

```bash
# Windows PowerShell
copy .env.example .env.local

# macOS / Linux
cp .env.example .env.local
```

编辑 `.env.local`，至少配置一个模型的 API Key：

```bash
# 必填（默认模型）
DEEPSEEK_API_KEY=sk-你的key

# 可选：配置后可在界面模型下拉中切换
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GEMINI_API_KEY=

# 可选：访问外部 API 需要代理时填写（axios 分支生效）
# PROXY_URL=http://localhost:7890
```

说明：

- 模型下拉只展示已配置 Key 的模型；一个 Key 都没有时，AST 本地分析仍可使用，但 AI 审计与 Agent 功能会报错
- 模型列表写在 `lib/models.ts`，如需改模型名或接入其他 OpenAI 兼容服务，直接修改该文件中的 endpoint 与 model 字段
- `.env.local` 已在 .gitignore 中，不会被提交

### 启动开发服务器

```bash
npm run dev
```

启动后浏览器打开 http://localhost:3000 。开发模式默认使用 Turbopack（Worker 与首屏编译更快）；如遇兼容问题可用 `npm run dev:webpack` 回退到 webpack。

### 生产构建

```bash
npm run build
npm run start
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动开发服务器（Turbopack） |
| `npm run dev:webpack` | 以 webpack 模式启动开发服务器 |
| `npm run build` | 生产构建 |
| `npm run start` | 运行生产构建 |
| `npm run lint` | ESLint 检查 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run test` | 运行全部单元测试（Vitest，一次性） |
| `npm run test:watch` | 监听模式运行测试 |
| `npm run verify` | 提交前自检：类型检查 + lint + 全部测试 |

## 使用流程

1. 打开页面后，将项目文件夹拖入左侧边栏（或点击选择），等待导入完成
2. 点击边栏顶部的批量分析按钮，Worker 扫描全部可分析文件，问题数与进度实时显示
3. 在文件树中点击有问题的文件，编辑器内行号处有问题标注，底部问题面板列出全部问题
4. 修复方式二选一或配合使用：
   - 自动修复：问题面板中单文件或全局一键修复，在 DiffViewer 中逐块确认
   - AI 审计：右侧控制台输入补充要求后运行审计，获取模型的流式报告并多轮追问
5. 需要 Agent 自主操作时，打开控制台的"Agent 模式"，输入任务指令（如先建快照、批量修复、读文件核对），观察 Tool 面板的每一步执行
6. 任何修改前后都可通过文件右键历史时间线或项目快照面板查看 diff、回滚版本

## 目录结构

```
app/
  api/
    audit/route.ts    # AI 审计流式接口（单轮/多轮报告）
    agent/route.ts    # Agent 循环的模型转发接口（无状态）
    ast/route.ts      # AST 相关接口
  page.tsx            # IDE 主页面（三栏布局编排）
components/
  file-tree/          # 项目侧边栏、文件树、右键菜单、拖拽导入
  editor/             # Monaco 编辑器、Tab、分析进度、问题面板
  diff/               # DiffViewer（逐块接受/拒绝/回退）
  snapshots/          # 文件历史与项目快照面板
  console/            # AI 控制台、会话侧边栏、Agent 工具步骤面板
hooks/                # useProject / useBatchAnalysis / useAuditor /
                      # useAgentTools / useAgentLoop / useConversations 等
lib/
  storage/            # 浏览器 VFS（IndexedDB + 内存后端、文件树、导入过滤）
  snapshots/          # 文件/项目快照、增量编码、历史栈
  ast/                # 批量分析、Worker、修复器
  agent/              # Agent 工具协议、执行器、系统提示、思考-执行循环
  ast.ts              # AST 规则定义与单文件分析
  modelService.ts     # 模型流式调用（audit 与 agent 共用底层）
  models.ts           # 模型配置列表
__tests__/            # Vitest 单元测试
types/                # 全局共享类型
```

## 数据与隐私说明

- 导入的项目文件与快照保存在浏览器 IndexedDB，会话记录保存在 localStorage，数据不会上传到任何第三方服务器
- 模型请求通过本项目的 Next.js API Routes 转发，API Key 只存在于服务端环境变量，不会下发到浏览器
- 清理浏览器站点数据会同时删除项目、快照与会话记录，重要项目请保留源码备份

## 测试

核心模块（AST 规则、修复器、快照增量存储、文件系统、Agent 工具执行器与思考循环）均有单元测试覆盖：

```bash
npm run test        # 运行全部测试
npm run test:watch  # 监听模式
```

提交前可用 `npm run verify` 一次性完成类型检查、lint 与全部测试。

