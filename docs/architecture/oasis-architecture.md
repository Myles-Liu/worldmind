# OASIS 架构要点

> 来源：camel-ai/oasis (https://github.com/camel-ai/oasis)
> 记录日期：2026-03-11

---

## 1. 整体架构：生产者-消费者异步通信管道

所有智能体（`SocialAgent`）与平台（`Platform`）之间**不直接通信**，通过 `Channel` 对象解耦。

```
Agent → Channel.receive_queue (写入) → Platform (消费并处理)
Agent ← Channel.send_dict (读取)    ← Platform (结果写回)
```

- `Channel` 内部使用 `asyncio.Queue`（接收队列）和 `AsyncSafeDict`（发送字典）
- 每次交互带唯一 `uuid` 作为消息 ID，实现请求-响应的异步匹配
- `Platform.running()` 永久运行，通过 `getattr` 动态路由到 `create_post`/`like_post` 等方法

**源码**：`channel.py:41-70`、`platform.py:128-173`

---

## 2. 智能体设计：LLM + Tool Calling + 社交身份

`SocialAgent` 继承自 CAMEL 框架的 `ChatAgent`，将社交媒体动作封装成 OpenAI Function Calling 格式的工具（`FunctionTool`）。

每个 Agent 拥有：

- **System Prompt**：通过 `UserInfo.to_system_message()` 生成，包含用户名、个性、MBTI、年龄、国籍等
- **Action Tools**：`SocialAction.get_openai_function_list()` 提供 28 种动作（create_post, like_post, repost, quote_post, unlike_post, dislike_post, search_posts, search_user, trend, refresh, do_nothing, create_comment, like_comment, dislike_comment, follow, unfollow, mute, unmute, purchase_product, interview, report_post, join_group, leave_group, send_to_group, create_group 等）
- **Environment Observation**：`SocialEnvironment.to_text_prompt()` 将当前信息流转化为自然语言提示

执行流程：
```python
env_prompt = await self.env.to_text_prompt()  # 观察环境
response = await self.astep(user_msg)          # LLM 选择并执行工具
```

**源码**：`agent.py:55-111`、`agent.py:123-153`、`agent_action.py:28-60`

---

## 3. 社交图谱：双后端可插拔设计

`AgentGraph` 支持两种图后端：

| 后端 | 适用场景 |
|------|---------|
| igraph | 小规模快速仿真 |
| Neo4j | 大规模持久化图数据库 |

两套 API 完全统一，通过 `self.backend` 标志路由切换。

**源码**：`agent_graph.py:175-259`

---

## 4. 多策略推荐系统

平台内置 4 种推荐算法，模拟真实社交平台的内容分发：

| 类型 | 说明 |
|------|------|
| `random` | 随机分发 |
| `reddit` | Reddit 热度分（赞踩差 + 时间衰减的对数算法） |
| `twitter` | 基于用户 bio 与帖子余弦相似度的个性化推荐 |
| `twhin-bert` | Twitter 专用预训练模型 `Twitter/twhin-bert-base` 向量化内容 + 时间分数 |

推荐结果存入 `rec` 表（用户-帖子矩阵），每轮 `step()` 前刷新。

TwHIN-BERT 采用**粗筛 + 精排**两阶段设计，最多对 4000 条帖子做向量化。

**源码**：`recsys.py:168-196`、`recsys.py:419-606`、`platform.py:328-398`

---

## 5. 沙盒时钟：时间加速

`Clock` 类通过倍率因子 `k`（默认 60），将真实时间映射为模拟时间。现实 1 秒 = 仿真 60 秒。

**源码**：`clock.py:17-33`

---

## 6. 环境接口：PettingZoo 风格的多智能体 Gym

`OasisEnv` 遵循 `reset / step / close` 接口：

```python
reset()               # 启动平台异步任务，注册所有 Agent
step(actions_dict)    # 接受 ManualAction 或 LLMAction，asyncio.gather 并发执行
close()               # 发送 EXIT 信号，关闭数据库
```

- **ManualAction**：预定义动作（脚本控制）
- **LLMAction**：LLM 自主决策
- 两者可混合，部分 Agent 脚本控制、部分 LLM 自主
- 并发控制通过 `asyncio.Semaphore` 限流

**源码**：`env.py:118-205`、`env.py:55-70`、`env_action.py:20-44`

---

## 7. 全链路行为追踪：SQLite Trace 表

所有智能体的每一个动作写入 `trace` 表，记录 `user_id`、`action`、`info`、`created_at`。

数据库使用 `PRAGMA synchronous = OFF` 提升写入性能。

**源码**：`database.py:42-59`、`platform.py:83-85`

---

## 8. 用户画像系统

每个 Agent 的 system prompt 通过 `UserInfo.to_system_message()` 动态生成：

- Twitter 模式：用户名 + 个性 + bio
- Reddit 模式：用户名 + 性别 + 年龄 + MBTI + 国籍 + 个性
- 支持自定义 `TextPrompt` 模板

**源码**：`user.py:79-111`、`user.py:31-42`

---

## 9. 百万 Agent 扩展性

通过 `generate_agents_100w` 实现：
- 放弃 `AgentGraph`（改用 list）
- 批量 SQL 插入（`executemany`）
- `asyncio.Semaphore` 限流

**源码**：`agents_generator.py:179-209`

---

## 关键设计理念

> 将 LLM 的 tool-calling 能力与社交媒体平台的行为空间无缝对接，每个 Agent 都是一个"有个性的真实用户"，而不是简单的规则机器人。

---

## WorldMind 中的使用方式

我们的 `world-engine.py` 通过 OASIS 的 Python API 运行：

1. `generate_twitter_agent_graph()` 从 CSV 生成 agent graph
2. 通过环境变量 `WORLDMIND_WORLD_CONTEXT` 注入世界观到每个 agent 的 system prompt
3. `env.step()` 支持 `LLMAction`（原生模式）和 `ManualAction`（directed 模式）
4. 数据持久化到 SQLite，TypeScript 层直接查询 DB 获取 feed/posts/comments
