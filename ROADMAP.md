# WorldMind Multiplayer — Feature Roadmap

> Created: 2026-03-10
> Last Updated: 2026-03-10

## Core Features

| Feature | Status | Commit |
|---------|--------|--------|
| Phase 1: 扩展 Action | ✅ Done | `dc50e85` |
| Phase 2: 群聊系统 | ✅ Done | `b8d8129` |
| Phase 3: 外部工具 (OpenClaw Skill) | ✅ Done | `734cca4` |
| Phase 4: Interview 复盘 | ✅ Done | `da3a085` |
| HTTP REST API | ✅ Done | `c7935bf` |
| LAN 自动发现 (Discovery) | ✅ Done | `54a2129` |
| 客户端 Skill 打包 + GitHub Release | ✅ Done | v0.1.0 |
| 优雅重启 + 状态迁移 (--resume) | ✅ Done | `9b319c0` |
| Player Slot 回收复用 | ✅ Done | `9b319c0` |
| 管理员 API (Admin) | ✅ Done | `41fa178` `77a7b46` |
| 投票系统 (Poll/Vote) | ✅ Done | `41fa178` `77a7b46` |

### 管理员 API 详情

| 功能 | 端点 | 状态 |
|------|------|------|
| Admin token 认证 | 所有 /api/admin/* | ✅ |
| 踢人 | POST /api/admin/kick | ✅ |
| 禁言 / 解禁 | POST /api/admin/mute, unmute | ✅ |
| 广播系统消息 | POST /api/admin/broadcast | ✅ |
| 暂停 / 恢复 | POST /api/admin/pause, resume | ✅ |
| 手动触发轮次 | POST /api/admin/round | ✅ |
| 注入事件 | POST /api/admin/inject | ✅ |
| 查看所有玩家 | GET /api/admin/players | ✅ |
| 修改运行参数 | POST /api/admin/config | ✅ |

### 投票系统详情

| 功能 | 端点 | 状态 |
|------|------|------|
| 创建投票 (LLM 生成选项) | POST /api/poll/create | ✅ |
| 确认/修改选项 | POST /api/poll/confirm | ✅ |
| 投票 | POST /api/action {vote} | ✅ |
| 查看结果 | GET /api/poll/results | ✅ |
| 关闭投票 | POST /api/poll/close | ✅ |
| 自动关闭 (N 轮后) | 内置 | ✅ |
| NPC 投票 | AgentDirector 集成 | ✅ |

---

## Upcoming

### 观众模式 (Spectator)
- [ ] 只读连接，看 feed 不参与
- [ ] 实时观看所有互动
- [ ] 用于直播 / 展示场景

### Web UI
- [ ] 简单前端看 feed + 发 action
- [ ] 实时更新（WebSocket）
- [ ] 角色头像 / 社交关系可视化

### 更丰富的 World Config
- [ ] 预设群组（世界配置中定义初始群聊）
- [ ] 预设关注关系
- [ ] 事件脚本（X 轮后触发某事件）
- [ ] 多世界模板（漫威、三体、office drama...）

---

## 技术债务

- ✅ tsconfig 排除 `scripts/archive/`
- ✅ user_name 字段修复
- ✅ data/social 从 git 清除

---

## 架构

```
Server (serve.ts)
  ├── OASIS Engine (Python subprocess)
  ├── DirectorNpcRuntime (batched LLM for NPCs)
  ├── WebSocket Server (real-time players)
  ├── HTTP API (remote players / OpenClaw agents)
  ├── Admin API (kick/mute/pause/inject)
  ├── Poll System (create/vote/close, LLM options)
  ├── Discovery (/api/discover)
  └── State Migration (export/import)

Client Options:
  ├── ai-player.ts (WS, auto-discover)
  ├── ws-bridge.ts (WS + File IPC, auto-discover)
  ├── HTTP API (curl / any language)
  └── worldmind-player.skill (OpenClaw agent)
```
