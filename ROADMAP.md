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

---

## Upcoming

### 管理员角色 (Admin)
- [ ] Admin token / password 认证
- [ ] 控制轮次：暂停 / 恢复 / 跳过 / 手动触发
- [ ] 踢人 / 禁言
- [ ] 广播系统消息
- [ ] 注入事件（inject_event / inject_news）
- [ ] 查看所有玩家状态
- [ ] 运行时修改参数（轮次间隔、NPC 数量等）
- [ ] Admin HTTP API (`/api/admin/*`)

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

- [ ] tsconfig 排除 `scripts/archive/`
- [ ] user_name 字段为空问题（OASIS 只写 name 不写 user_name）
- [ ] git history 中残留 data/social 文件（非敏感，低优先）

---

## 架构

```
Server (serve.ts)
  ├── OASIS Engine (Python subprocess)
  ├── DirectorNpcRuntime (batched LLM for NPCs)
  ├── WebSocket Server (real-time players)
  ├── HTTP API (remote players / OpenClaw agents)
  ├── Discovery (/api/discover)
  └── State Migration (export/import)

Client Options:
  ├── ai-player.ts (WS, auto-discover)
  ├── ws-bridge.ts (WS + File IPC, auto-discover)
  ├── HTTP API (curl / any language)
  └── worldmind-player.skill (OpenClaw agent)
```
