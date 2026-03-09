# Anthropic Context Engineering 学习笔记

> 来源：3 篇 Anthropic 官方工程博客（2025-2026）
> 整理日期：2026-03-09

---

## 1. 核心原则

### "找到最小高信号 token 集合"
> "Find the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome."

这是 Anthropic 整篇文章的核心。不是"给够信息"，是"给最少的、最精准的信息"。

### Context Rot（上下文腐烂）
- token 越多，模型回忆准确度越差
- 不是 cliff（悬崖），是 gradient（斜坡）——越长越差
- 原因：Transformer 的 n² 注意力关系被摊薄
- **启示：WorldMind 的 4000 token budget 方向是对的，但每一层都要精确**

### 注意力预算（Attention Budget）
- LLM 有固定的注意力预算，每个新 token 都在消耗预算
- **冗余 token = 浪费预算 = 降低有用信息的接收概率**

---

## 2. System Prompt 设计

### "Right Altitude"（正确的高度）
两种失败模式：
- **太具体**：硬编码 if-else 逻辑 → 脆弱、难维护
- **太模糊**：缺乏具体信号 → 模型猜测

最佳区间：**足够具体以引导行为，足够灵活以提供启发式规则**

### 结构化
- 用 XML tags 或 Markdown headers 分段
- 但格式本身越来越不重要（模型能力在提升）

### "Minimal ≠ Short"
> "Minimal does not necessarily mean short; you still need to give the agent sufficient information."
- 从最小 prompt 开始，用最好的模型测试
- 根据失败模式逐步增加指令
- **WorldMind 对照：我们的 soul 文件有大段 personality/identity，这不是 "sufficient information"，是 noise**

---

## 3. Tool 设计

### 每个 tool 必须：
- 自包含、健壮、用途清晰
- 功能无重叠
- 参数描述明确

### 最常见的失败：
> "Bloated tool sets that cover too much functionality or lead to ambiguous decision points."
- 如果人类工程师无法确定该用哪个 tool，AI 也做不到
- **WorldMind 对照：我们的 agent 没有 tool，但 "SharedContextBus" 的输出格式就是隐式 tool——输出格式要紧凑明确**

---

## 4. Just-in-Time Context（即时上下文）

### 不要预加载所有数据
- 保留轻量级标识符（文件路径、查询、链接）
- 运行时按需加载
- Claude Code 的做法：维护文件路径，用 grep/head/tail 按需读取

### Progressive Disclosure（渐进式披露）
- 每次交互产生的上下文指导下一步决策
- Agent 逐层构建理解，只保留必要的 working memory

### 混合策略
- 部分数据预加载（速度优先）
- 部分数据运行时探索（精度优先）
- Claude Code 的 CLAUDE.md = 预加载，grep = 即时

**WorldMind 对照：**
- Layer 5 Knowledge 是预加载 ✅
- 但 Layer 3 Working Memory 把所有 bus 输出都塞进去 ❌ → 应该只保留摘要
- Layer 4 Semantic Memory 检索 10→5 条已改进 ✅ → 但检索质量未验证

---

## 5. 长时间任务的三个技术

### Compaction（压缩）
- 接近窗口上限时，总结历史，开新窗口
- 关键：**选择保留什么 vs 丢弃什么**
- 最安全的轻量压缩：清理旧的 tool call/result（已完成的调用不需要原始结果）
- "Start by maximizing recall, then iterate to improve precision"

### Structured Note-Taking（结构化笔记）
- Agent 定期写笔记到 context window 外的持久存储
- 跨 session 保持连贯性
- 示例：NOTES.md、to-do list、progress tracker

### Sub-Agent Architecture（子代理架构）
- 每个子代理有干净的 context window
- 子代理大量探索（数万 token），但只返回压缩摘要（1000-2000 token）
- **关注点分离**：搜索上下文隔离在子代理内，主代理只处理综合分析

**WorldMind 对照：**
- 我们的 5 Agent 就是子代理架构 ✅
- 但 Agent 之间通过 SharedContextBus 传递**完整输出** ❌
- Anthropic 说子代理应只返回 1000-2000 token 摘要
- **这是我们最大的改进点：每个 Agent 的输出应该有 summary 和 detail，下游只读 summary**

---

## 6. 多 Agent 系统的关键教训

### Orchestrator-Worker 模式
- Lead agent 分解任务、协调
- Subagent 并行探索、返回压缩结果
- Lead agent 综合分析

### Token 使用解释了 80% 的性能差异
- 更多 token ≈ 更好结果（到一定程度）
- 但更好的模型 > 更多 token（Sonnet 4 > 2x token on Sonnet 3.7）
- **启示：与其给每个 agent 塞更多 context，不如让 context 更精准**

### 规模化努力匹配查询复杂度
- 简单任务：1 agent, 3-10 tool calls
- 中等任务：2-4 subagents, 10-15 calls each
- 复杂任务：10+ subagents

### "Teach the orchestrator how to delegate"
- 每个子任务需要：目标、输出格式、工具指导、明确边界
- 模糊指令 → 重复工作、遗漏、误解

---

## 7. Long-Running Agent Harness

### 两个核心失败模式：
1. **Agent 试图一次做完所有事** → 上下文耗尽，半成品
2. **Agent 看到进度就宣布完成** → 遗漏功能

### 解决方案：
- **Initializer Agent**：设置环境、写 feature list（JSON）、写 init.sh
- **Coding Agent**：每次只做一个 feature，做完 commit + 更新 progress

### Feature List = 结构化的目标追踪
- JSON 格式（比 Markdown 不容易被 LLM 改动）
- 每个 feature 有 `passes: true/false`
- 强提示："不可删除或编辑测试"

### 每个 session 开始的固定流程：
1. `pwd` 确认位置
2. 读 progress 文件 + git log
3. 读 feature list，选最高优先级未完成项
4. 跑 init.sh 启动环境
5. 跑基本 e2e 测试确认没坏
6. 开始工作

---

## 8. 对 WorldMind 的行动项

### 立即可做：
1. **Agent 输出压缩**：每个 Agent 输出分 `summary`（给下游）和 `detail`（存档），SharedContextBus 只传 summary
2. **清理 soul 文件**：删掉所有 personality/identity 描述，只保留任务相关的 heuristics
3. **Layer 3 Working Memory 瘦身**：bus briefing 从完整输出改为 1-2 sentence per agent
4. **Layer 5 Knowledge 精确匹配**：已做 ✅
5. **Tool result clearing 思想**：旧的 Agent 输出在下一轮 cycle 应被清理，不累积

### 中期：
6. **渐进式上下文**：Agent 先收到摘要，按需请求详情（类似 Claude Code 的 grep 模式）
7. **Compaction 机制**：长 cycle 后压缩历史 bus 数据
8. **Feature list for backtest**：用 JSON 追踪 backtest cases 的状态

### 架构级：
9. **考虑 Orchestrator-Worker 重构**：当前 pipeline 是固定顺序，可以进化为动态分配
10. **Token 计数监控**：每层实际 token 数 vs budget，持续追踪
