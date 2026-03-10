# WorldMind Multiplayer — Feature Roadmap

> Created: 2026-03-10
> Last Updated: 2026-03-10

| Phase | Status | Commit |
|-------|--------|--------|
| Phase 1: 扩展 Action | ✅ Done | `dc50e85` |
| Phase 2: 群聊系统 | ✅ Done | `b8d8129` |
| Phase 3: 外部工具 | 🔲 Planned | — |
| Phase 4: Interview 复盘 | ✅ Done | `da3a085` |

---

## Phase 1: 扩展 Action 集（丰富社交行为）

**目标**：让 NPC 和 Player 不止发帖/评论，行为更像真人

### 1.1 转发 & 引用转发（Repost / Quote Post）
- [ ] world-engine.py `directed_step` 支持 `REPOST` 和 `QUOTE_POST` action
- [ ] AgentDirector prompt 中加入转发/引用选项
- [ ] Decision schema 增加 `repost` / `quote` action type
- [ ] AI Player 支持转发决策
- **价值**：信息传播链可追踪，模拟"病毒传播"现象

### 1.2 关注 / 取关（Follow / Unfollow）
- [ ] directed_step 支持 `FOLLOW` / `UNFOLLOW`
- [ ] Agent 根据互动历史自动关注志同道合者
- [ ] 关注关系影响 feed 推荐（OASIS 已内置推荐系统）
- **价值**：形成社交网络拓扑，agent 不再是平面互动

### 1.3 点赞优化
- [ ] 让 agent 自然地点赞（目前 94 评论只有 1 个赞）
- [ ] 点赞作为轻量互动，降低"沉默轮"比例
- **价值**：更真实的社交信号

### 1.4 搜索帖子 / 用户（Search）
- [ ] Agent 可以搜索平台内容，而不仅依赖 feed
- [ ] 搜索结果影响决策（如"搜一下 Tony 之前说过什么"）
- **价值**：agent 有主动获取信息的能力

---

## Phase 2: 群聊系统（私密社交维度）

**目标**：公开帖子 + 私密群聊，两条社交线并行

### 2.1 群聊基础
- [ ] world-engine.py 支持 `CREATE_GROUP` / `JOIN_GROUP` / `SEND_TO_GROUP` / `LEAVE_GROUP`
- [ ] DirectorNpcRuntime 在 decideBatch 中输出群聊 action
- [ ] 群消息纳入 agent memory

### 2.2 群聊剧情引擎
- [ ] World config 中定义初始群聊（如"复仇者作战指挥部"）
- [ ] Agent 可自发建群拉人（如 Thanos 私下密谋群）
- [ ] 群聊内容对非成员不可见，形成信息不对称

### 2.3 Player 加入群聊
- [ ] AI Player / Human Player 可通过 WebSocket 加入群聊
- [ ] join.ts CLI 支持群聊消息收发
- **价值**：模拟"暗线"剧情，信息不对称驱动冲突

---

## Phase 3: 外部工具（Agent 搜索真实信息）

**目标**：Agent 不再纯靠幻想，能引用真实世界知识

### 3.1 搜索工具集成
- [ ] 给 OASIS agent 挂 CAMEL SearchToolkit（DuckDuckGo）
- [ ] Directed 模式下：AgentDirector 决策后，如需搜索则调用工具补充内容
- [ ] 搜索结果注入 agent 发言（"根据 Nature 2024 论文..."）

### 3.2 知识验证
- [ ] Agent 发言前可以 fact-check 自己的内容
- [ ] 其他 agent 可以搜索反驳（"你说的数据是错的，实际上..."）
- **价值**：发言质量从"角色扮演幻想"升级到"有理有据的讨论"

---

## Phase 4: Interview 复盘系统

**目标**：模拟结束后，生成深度角色分析报告

### 4.1 自动采访
- [ ] 模拟结束后对每个 agent 执行 `INTERVIEW` action
- [ ] 预设采访问题（"你为什么在第 X 轮改变了立场？""你怎么看 Tony？"）
- [ ] 采访基于 agent 完整 memory，回答有上下文

### 4.2 分析报告生成
- [ ] 汇总所有采访 → LLM 生成"角色心理分析报告"
- [ ] 社交关系图谱可视化（谁和谁互动最多、立场对立/一致）
- [ ] 关键事件时间线提取
- [ ] 信息传播路径分析

### 4.3 输出格式
- [ ] Markdown 报告
- [ ] 可选：HTML 可视化页面
- **价值**：把模拟从"看热闹"升级到"可分析的社会实验"

---

## 技术债务 / 改进

- [ ] tsconfig 排除 `scripts/archive/`（消除编译警告）
- [ ] user_name 字段为空问题（OASIS 只写 name 不写 user_name）
- [ ] 清理 data/social/ 下的旧文件（历史遗留的平铺文件）
- [ ] LLMAction 独立模式 vs Directed 模式对比实验

---

## 依赖关系

```
Phase 1（基础 action）
  ↓
Phase 2（群聊，依赖 action 扩展）
  ↓
Phase 3（工具，独立于群聊但丰富内容）
  ↓
Phase 4（复盘，依赖完整模拟数据）
```
