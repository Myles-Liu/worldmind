# OpenClaw 仓库核心设计解析

> 来源：DeepWiki 分析 openclaw/openclaw + 源码阅读
> 记录日期：2026-03-11（Agent Loop 深度分析更新：2026-03-12）

---

## 1. 🤖 子代理（Subagent）分层编排系统

这是整个仓库最精彩的设计之一。AI 代理可以动态"孵化"子代理（subagent），形成有深度限制的父子代理树形结构。

### 核心思路

- 父代理通过 `sessions_spawn` 工具启动子代理，子代理在独立 session 中运行
- 子代理完成后，通过一套**公告（announce）机制**将结果回传给父代理
- 使用带指数退避的重试队列确保结果可靠送达，最大重试次数为 3，退避上限 8 秒

### 实现细节

- `SubagentRegistry`（`subagent-registry.ts`）用一个 `Map<string, SubagentRunRecord>` 维护所有子代理的运行状态
- 支持持久化到磁盘，进程重启后可恢复
- 内置防孤儿清理机制：检测 `missing-session-entry` 或 `missing-session-id` 的过期记录
- `subagent-announce.ts` 中实现了完整的公告投递流程，包含幂等键防重投
- 子代理的深度限制从 session store 中读取，防止无限递归

**源码**：`src/agents/subagent-registry.ts:63-95`、`src/agents/subagent-announce.ts:51-57`、`src/agents/subagent-depth.ts:1-50`

---

## 2. 🔌 极度灵活的插件系统

插件系统设计得非常全面，一个插件可以同时扩展系统的多个维度，通过统一的 `OpenClawPluginApi` 注册：

### 注册维度

| 方法 | 扩展内容 |
|------|---------|
| `registerTool` | 注册 AI 工具 |
| `registerHook` | 注册生命周期钩子 |
| `registerHttpRoute` | 注册 HTTP 路由 |
| `registerChannel` | 注册新的通信渠道 |
| `registerGatewayMethod` | 注册网关方法 |
| `registerService` | 注册后台服务 |
| `registerProvider` | 注册 LLM 提供商 |
| `registerCommand` | 注册绕过 LLM 的直接命令 |
| `registerContextEngine` | 注册可替换的上下文引擎（独占槽位） |

### 插件钩子

覆盖代理生命周期的每一个阶段：
- `before_agent_start` / `after_agent_end`
- `before_model_resolve`
- `before_prompt_build`
- `llm_input` / `llm_output`
- `before_tool_call` / `after_tool_call`
- `before_compaction` / `after_compaction`
- `session_start` / `session_end`
- `message_received` / `message_sending` / `message_sent`
- `subagent_spawning` / `subagent_ended`

**源码**：`src/plugins/types.ts:257-300`、`src/plugins/hooks.ts:1-53`

---

## 3. 🧠 混合语义记忆检索系统

记忆模块采用了学术界标准的**混合检索（Hybrid Search）**架构，兼顾精确性和语义性：

### 三层融合

1. **向量检索**：用 OpenAI / Gemini / Voyage / Mistral / Ollama 等多种嵌入提供商将文本转为向量，存储于 SQLite-vec
2. **BM25 全文检索**：用 SQLite FTS5 做关键词检索，BM25 rank 通过 `1/(1+rank)` 归一化为 [0,1] 分数
3. **加权融合**：向量分和关键词分按权重合并

### 高级重排序策略

- **MMR（最大边际相关性）算法**：在提升相关性的同时保证结果多样性，通过 Jaccard 相似度去冗余，λ 参数控制相关性与多样性的权衡
- **时间衰减评分**：对带日期的记忆文件（`memory/YYYY-MM-DD.md`）按指数半半衰期降权，越旧的记忆权重越低

`MemoryIndexManager` 统一管理所有嵌入提供商、向量表、FTS 表及嵌入缓存表，还支持 batch 模式异步提交嵌入任务。

**源码**：`src/memory/hybrid.ts:46-64`、`src/memory/mmr.ts:1-30`、`src/memory/temporal-decay.ts:1-43`、`src/memory/manager.ts:45-80`

---

## 4. ⚡ 智能上下文压缩（Compaction）

当对话历史接近模型上下文窗口上限时，系统自动触发压缩。

### 核心思路

- 将历史消息按 token 数量分成若干块（chunk），逐块用 LLM 生成摘要，再合并所有摘要
- 自适应 chunk 比例：当消息平均 token 占上下文比例 > 10% 时，动态缩小 chunk 比例，防止超出模型限制
- **安全边际系数**（`SAFETY_MARGIN = 1.2`）：估算 token 时多留 20% 余量，补偿多字节字符和特殊 token 的漏估
- **标识符保全策略**：可配置要求 LLM 在摘要中原样保留 UUID、哈希、API key、URL 等不可缩写标识符

**源码**：`src/agents/compaction.ts:12-70`、`src/agents/compaction.ts:181-200`

---

## 5. 🛡️ 多层工具策略管道（Tool Policy Pipeline）

工具的可用性不是简单的开关，而是经过一条**多层级策略管道**过滤的结果，从低到高优先级依次为：

1. Profile 级别策略（`tools.profile`）
2. Provider Profile 策略（`tools.byProvider.profile`）
3. 全局工具策略（`tools.allow`）
4. 全局 Provider 策略（`tools.byProvider.allow`）
5. Agent 专属策略（`agents.<id>.tools.allow`）
6. Agent Provider 策略
7. 群组策略（`group tools.allow`）

在此之上还叠加了 **Owner-only 工具**概念：某些高权限工具（如 `whatsapp_login`、`cron`、`gateway`）只有 owner 身份的发送者才能看到和执行。

**源码**：`src/plugins/tool-policy-pipeline.ts:17-63`、`src/plugins/tool-policy.ts:19-52`

---

## 6. 🔄 Auth Profile 轮转与故障转移

认证系统设计得非常工程化，支持多账号轮转：

- 每个 LLM 提供商可配置多个 Auth Profile（API key、OAuth token 等）
- 调用失败时自动进入**冷却（cooldown）**状态，下次调用时跳过该 Profile
- 失败类型有优先级排序：`auth_permanent > auth > billing > format > model_not_found > overloaded > timeout > rate_limit > unknown`
- `resolveAuthProfileOrder` 根据冷却状态、上次使用时间等因素自动排序 Profile
- **模型故障转移**（`model-fallback.ts`）实现了多模型 fallback 链：当主模型调用失败时依次尝试备用模型，只有明确的用户中止（`AbortError`）才会停止重试
- 提供商名归一化确保 `z.ai` / `z-ai`、`bedrock` / `aws-bedrock`、`doubao` / `volcengine` 等别名统一处理

**源码**：`src/providers/usage.ts:1-56`、`src/providers/order.ts:67-80`、`src/providers/model-fallback.ts:59-72`、`src/providers/model-selection.ts:40-62`

---

## 7. 🔁 Agent Loop 核心机制：双层循环与退出条件

> 源码精读：2026-03-12，直接阅读 `pi-agent-core/dist/agent-loop.js`、`src/agents/pi-embedded-runner/run.ts`、`src/agents/pi-embedded-runner/run/attempt.ts`

这是整个系统最核心的运行时机制——AI Agent 如何在"调用 LLM → 执行工具 → 再调用 LLM"的循环中决定何时停止。

### 7.1 双层循环架构

OpenClaw 的 Agent 运行时由两层嵌套循环组成：

```
┌─────────────────────────────────────────────────┐
│  Outer: Run Retry Loop (run.ts)                 │
│  处理基础设施级别的重试                              │
│  ┌───────────────────────────────────────────┐   │
│  │  Inner: Agent Tool Loop (agent-loop.js)   │   │
│  │  处理 LLM 推理 + 工具执行的循环               │   │
│  │                                           │   │
│  │  while (hasMoreToolCalls || pending) {     │   │
│  │    response = callLLM()                   │   │
│  │    if (response has toolCalls)             │   │
│  │      execute tools → loop                 │   │
│  │    else                                   │   │
│  │      break  ← LLM 自主决定停止              │   │
│  │  }                                        │   │
│  └───────────────────────────────────────────┘   │
│  if (auth failure) → rotate profile → retry      │
│  if (context overflow) → compaction → retry      │
│  if (thinking unsupported) → downgrade → retry   │
└─────────────────────────────────────────────────┘
```

### 7.2 内层循环：Agent Tool Loop

位于 `@mariozechner/pi-agent-core/dist/agent-loop.js` 的 `runLoop()` 函数。

```javascript
// 简化后的核心逻辑
async function runLoop(currentContext, newMessages, config, signal, stream) {
  while (true) {                                    // 外层：follow-up 消息循环
    let hasMoreToolCalls = true;
    
    while (hasMoreToolCalls || pendingMessages.length > 0) {  // 内层：工具循环
      // 1. 注入 steering 消息（用户在 agent 运行中插入的新消息）
      if (pendingMessages.length > 0) {
        currentContext.messages.push(...pendingMessages);
        pendingMessages = [];
      }
      
      // 2. 调用 LLM 获取 assistant response
      const message = await streamAssistantResponse(currentContext, config, signal, stream);
      
      // 3. 错误或中止 → 立即退出
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "agent_end", messages: newMessages });
        return;
      }
      
      // 4. 检查是否有工具调用
      const toolCalls = message.content.filter(c => c.type === "toolCall");
      hasMoreToolCalls = toolCalls.length > 0;
      
      // 5. 有工具调用 → 执行并循环
      if (hasMoreToolCalls) {
        const { toolResults, steeringMessages } = await executeToolCalls(...);
        currentContext.messages.push(...toolResults);
        // 执行期间用户可能插入了 steering 消息
        pendingMessages = steeringMessages ?? await config.getSteeringMessages();
      }
    }
    
    // 6. 内层退出后，检查有没有 follow-up 消息
    const followUpMessages = await config.getFollowUpMessages();
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;  // 有 follow-up → 继续外层循环
    }
    
    break;  // 没有 → 彻底退出
  }
}
```

**退出条件总结**：

| 条件 | 触发者 | 结果 |
|------|--------|------|
| LLM 返回纯文本（无 toolCall） | LLM 自主决定 | 退出内层循环 |
| `stopReason === "error"` | LLM API 错误 | 立即退出全部循环 |
| `stopReason === "aborted"` | AbortSignal | 立即退出全部循环 |
| 无 follow-up 消息 | 用户无新输入 | 退出外层循环 |

**关键洞察：OpenClaw 没有设置 `max_iterations` 上限。** 它完全信任 LLM 在合适的时候停下来（不再发出 tool_call）。唯一的硬保护是外层的全局超时。

### 7.3 Steering 与 Follow-up 机制

Agent 运行期间支持两种用户介入：

- **Steering Messages**：用户在工具执行期间发送的消息。执行完当前工具后注入到 context 中，**剩余未执行的工具调用会被跳过**（标记为 `"Skipped due to queued user message."`）
- **Follow-up Messages**：Agent 完成一轮后（即将退出循环时），检查是否有用户新消息。有则重新进入循环继续处理

这使得用户可以在 Agent 运行过程中随时"插话"，修正 Agent 的行为方向。

### 7.4 外层循环：Run Retry Loop

位于 `src/agents/pi-embedded-runner/run.ts`。负责处理基础设施级别的失败和重试：

```typescript
// 简化后的核心逻辑
const MAX_RUN_LOOP_ITERATIONS = 32 ~ 160;  // 根据 auth profile 数量动态计算

while (true) {
  if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) → 报错退出;
  
  const attempt = await runEmbeddedAttempt(params);  // 跑一次完整的 agent tool loop
  
  // 重试条件判断：
  if (context overflow && compactionRetries < 3)     → compaction 后重试
  if (auth failure)                                   → 切换 auth profile 重试
  if (rate limit)                                     → 切换 auth profile 重试
  if (thinking level unsupported)                     → 降级 thinking level 重试
  if (timeout && hasMoreProfiles)                     → 切换 auth profile 重试
  if (CloudCodeAssist format error)                   → 切换 profile 重试
  
  // 正常完成 → return 结果
  return result;
}
```

### 7.5 Thinking Level 降级机制

OpenClaw 支持 6 个 thinking level：`off → minimal → low → medium → high → xhigh`

不是所有模型都支持所有级别。当 LLM API 返回类似 `"Unsupported thinking level. Supported values are: 'low', 'off'"` 的错误时：

```typescript
// src/agents/pi-embedded-helpers/thinking.ts
function pickFallbackThinkingLevel({ message, attempted }) {
  // 1. 从错误消息中正则提取支持的级别列表
  const supported = extractSupportedValues(message);  // e.g. ["low", "off"]
  
  // 2. 遍历支持的级别，跳过已尝试过的
  for (const level of supported) {
    const normalized = normalizeThinkLevel(level);
    if (!attempted.has(normalized)) return normalized;
  }
  
  return undefined;  // 全试过了，放弃
}
```

**实际流程示例**：
1. 用户配置 `thinking: high`
2. 第一次调用 → 模型报错 "只支持 low, off"
3. 降级到 `low`，标记 `attempted = {high, low}`
4. 第二次调用 → 成功 ✅（如果 `low` 也失败则继续降到 `off`）

### 7.6 安全兜底机制总览

| 机制 | 来源文件 | 默认值 |
|------|---------|--------|
| LLM 不再调 tool → 自然退出 | `agent-loop.js` | 由 LLM 自主决定 |
| 全局超时 abort | `run/attempt.ts` | 600秒（`agents.defaults.timeoutSeconds`） |
| 外层重试次数上限 | `run.ts` | 32~160次（仅基础设施重试） |
| Compaction 重试上限 | `run.ts` | 3次 |
| AbortSignal 取消 | `run/attempt.ts` | 外部随时可触发 |
| Auth profile 耗尽 | `run.ts` | 所有 profile 进入冷却期后触发 model fallback |
| Thinking level 全部失败 | `run.ts` | 返回最终错误 |

**源码**：`node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js`、`src/agents/pi-embedded-runner/run.ts:380-520`、`src/agents/pi-embedded-runner/run/attempt.ts:1-680`、`src/agents/pi-embedded-helpers/thinking.ts:1-40`

---

## 8. 📦 可替换上下文引擎（Pluggable Context Engine）

上下文管理被抽象成一个标准接口 `ContextEngine`，任何插件都可以注册自己的实现来完全替换内置的对话历史管理逻辑：

关键方法：
- `bootstrap`（初始化）
- `ingest` / `ingestBatch`（消息写入）
- `afterTurn`（轮次后处理）
- `assemble`（按 token budget 组装上下文）
- `compact`（压缩）
- `prepareSubagentSpawn`（子代理准备）
- `onSubagentEnded`（子代理结束通知）

**源码**：`src/context-engine/types.ts:67-166`

---

## 9. 📡 流式分块输出（EmbeddedBlockChunker）

为了在消息平台（如 Telegram、Slack）上实现流式分段发送，系统实现了一个感知 Markdown 语法结构的分块器：

- 识别代码围栏（fenced code blocks），避免在围栏内部切割
- 支持段落（`\n\n`）、句子（`.!?`）、换行三种断点偏好
- 若在代码围栏中间不得不分割，会自动插入闭合围栏并在下一块重新打开

**源码**：`src/shared/text/pi-embedded-block-chunker.ts:1-60`

---

## 架构总览

```
OpenClaw
├── agents/          # 子代理编排、上下文压缩
├── plugins/         # 插件系统、钩子、工具策略
├── memory/          # 混合检索、MMR、时间衰减
├── providers/       # 多提供商、Auth Profile、模型故障转移
├── context-engine/  # 可替换上下文引擎
├── channels/        # 多渠道支持（Telegram、Discord、Slack...）
├── sandbox/         # Docker/浏览器沙箱
└── apps/           # iOS/Android/macOS 客户端
```

---

## Notes

- 该仓库的代码名"OpenClaw"来自项目自身命名，`pi-embedded-runner` 等名称中的"pi"是其底层 AI 代理核心库 `@mariozechner/pi-agent-core` / `@mariozechner/pi-coding-agent` 的前缀
- `skills/` 目录下有 50+ 个内置 Skill（如 `spotify-player`、`github`、`notion`、`obsidian`、`weather` 等），每个 Skill 是一个独立的可安装扩展包
- 系统同时支持 **Docker 沙箱**（`sandbox/docker.ts`）和**浏览器沙箱**（`sandbox/browser.ts`），可以在隔离环境中执行代码和网页操作
- `apps/` 目录包含 iOS / Android / macOS 客户端代码，说明这是一个完整的端到端平台，不只是后端服务
