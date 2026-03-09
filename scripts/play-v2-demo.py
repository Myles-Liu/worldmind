#!/usr/bin/env python3
"""
WorldMind v2 Demo — Memory + Conversation Chains + Goals

This demo shows:
1. Agent memory persists across rounds (they remember what happened)
2. Conversation chains (you reply → agent replies back → real dialogue)
3. Goal system (you have a mission, world tracks your progress)
"""

import asyncio, os, json, sqlite3, random, sys, copy
from datetime import datetime
from collections import defaultdict

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, 'data/social/v2_demo.db')

def load_env():
    env_path = os.path.join(PROJECT_ROOT, '.env')
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    os.environ.setdefault(k.strip(), v.strip())

load_env()
os.environ['OPENAI_API_KEY'] = os.environ.get('WORLDMIND_LLM_API_KEY', '')
os.environ['OPENAI_API_BASE_URL'] = os.environ.get('WORLDMIND_LLM_BASE_URL', '')


def patch_camel():
    from camel.models.openai_model import OpenAIModel
    async def _patched(self, messages, tools=None):
        cfg = copy.deepcopy(self.model_config_dict)
        if tools: cfg["tools"] = tools
        cfg = self._sanitize_config(cfg)
        cfg["stream"] = True
        stream = await self._async_client.chat.completions.create(
            messages=messages, model=self.model_type, **cfg)
        parts, tc_map, finish, cid = [], {}, None, ""
        async for chunk in stream:
            if chunk.id: cid = chunk.id
            for ch in (chunk.choices or []):
                if ch.delta.content: parts.append(ch.delta.content)
                if ch.finish_reason: finish = ch.finish_reason
                if ch.delta.tool_calls:
                    for tc in ch.delta.tool_calls:
                        if tc.index not in tc_map:
                            tc_map[tc.index] = {"id":"","type":"function","function":{"name":"","arguments":""}}
                        if tc.id: tc_map[tc.index]["id"] = tc.id
                        if tc.function:
                            if tc.function.name: tc_map[tc.index]["function"]["name"] = tc.function.name
                            if tc.function.arguments: tc_map[tc.index]["function"]["arguments"] += tc.function.arguments
        from openai.types.chat import ChatCompletion, ChatCompletionMessage
        from openai.types.chat.chat_completion import Choice
        from openai.types.completion_usage import CompletionUsage
        import time
        msg = ChatCompletionMessage.model_construct(
            role="assistant", content="".join(parts) or None,
            tool_calls=[tc_map[i] for i in sorted(tc_map)] if tc_map else None)
        return ChatCompletion.model_construct(
            id=cid or "x", object="chat.completion", created=int(time.time()),
            model=self.model_type,
            usage=CompletionUsage.model_construct(prompt_tokens=0, completion_tokens=0, total_tokens=0),
            choices=[Choice.model_construct(finish_reason=finish or "stop", index=0, message=msg)])
    OpenAIModel._arequest_chat_completion = _patched


# ─── Agent Memory (Python side) ─────────────────────────────────

class AgentMemory:
    """Simple per-agent memory that persists across rounds."""
    
    def __init__(self):
        self.memories = defaultdict(lambda: {
            'episodes': [],      # what happened
            'relationships': {}, # who they know
            'opinions': [],      # what they think
        })
    
    def record(self, agent_id, event_type, content, importance=0.5):
        mem = self.memories[agent_id]
        mem['episodes'].append({
            'type': event_type,
            'content': content[:200],
            'importance': importance,
        })
        # Keep last 30 episodes
        if len(mem['episodes']) > 30:
            mem['episodes'] = sorted(mem['episodes'], key=lambda x: -x['importance'])[:20]
    
    def record_relationship(self, agent_id, target_id, target_name, interaction):
        mem = self.memories[agent_id]
        if target_id not in mem['relationships']:
            mem['relationships'][target_id] = {'name': target_name, 'interactions': [], 'sentiment': 0}
        rel = mem['relationships'][target_id]
        rel['interactions'].append(interaction)
        if len(rel['interactions']) > 10:
            rel['interactions'] = rel['interactions'][-10:]
        # Update sentiment
        positive = ['liked', 'followed', 'agreed', 'praised']
        negative = ['criticized', 'disagreed', 'ignored']
        if any(p in interaction for p in positive):
            rel['sentiment'] = min(1, rel['sentiment'] + 0.1)
        elif any(n in interaction for n in negative):
            rel['sentiment'] = max(-1, rel['sentiment'] - 0.1)
    
    def get_summary(self, agent_id):
        mem = self.memories[agent_id]
        if not mem['episodes'] and not mem['relationships']:
            return ''
        
        parts = []
        
        # Recent episodes
        recent = mem['episodes'][-8:]
        if recent:
            parts.append('你的近期记忆:')
            for e in recent:
                parts.append(f'- {e["content"]}')
        
        # Key relationships
        rels = sorted(mem['relationships'].items(), 
                      key=lambda x: len(x[1]['interactions']), reverse=True)[:5]
        if rels:
            parts.append('\n你认识的人:')
            for tid, rel in rels:
                feeling = '友好' if rel['sentiment'] > 0.2 else '一般' if rel['sentiment'] > -0.2 else '不太好'
                parts.append(f'- {rel["name"]}: 互动{len(rel["interactions"])}次, 关系{feeling}')
        
        return '\n'.join(parts)
    
    def process_db_changes(self, conn, last_ids, agent_names):
        """Read new DB entries and update memories."""
        lp, lc, ll, lf = last_ids
        
        # New posts
        for row in conn.execute('SELECT post_id, user_id, content FROM post WHERE post_id > ?', (lp,)):
            name = agent_names.get(row[1], f'agent_{row[1]}')
            self.record(row[1], 'action', f'我发了帖: "{(row[2] or "")[:60]}"', 0.7)
        
        # New comments
        for row in conn.execute(
            'SELECT c.comment_id, c.user_id, c.content, c.post_id, p.user_id as post_author '
            'FROM comment c JOIN post p ON c.post_id=p.post_id WHERE c.comment_id > ?', (lc,)):
            commenter = agent_names.get(row[1], f'agent_{row[1]}')
            author = agent_names.get(row[4], f'agent_{row[4]}')
            self.record(row[1], 'action', f'我评论了{author}的帖子: "{(row[2] or "")[:60]}"', 0.6)
            self.record(row[4], 'interaction', f'{commenter}评论了我的帖子: "{(row[2] or "")[:60]}"', 0.7)
            self.record_relationship(row[4], row[1], commenter, f'commented: {(row[2] or "")[:40]}')
            self.record_relationship(row[1], row[4], author, f'I commented on their post')
        
        # New likes
        for row in conn.execute(
            'SELECT l.like_id, l.user_id, l.post_id, p.user_id as post_author '
            'FROM like l JOIN post p ON l.post_id=p.post_id WHERE l.like_id > ?', (ll,)):
            liker = agent_names.get(row[1], f'agent_{row[1]}')
            author = agent_names.get(row[3], f'agent_{row[3]}')
            self.record(row[3], 'interaction', f'{liker}赞了我的帖子', 0.3)
            self.record_relationship(row[3], row[1], liker, 'liked my post')
        
        # New follows
        for row in conn.execute('SELECT follow_id, follower_id, followee_id FROM follow WHERE follow_id > ?', (lf,)):
            follower = agent_names.get(row[1], f'agent_{row[1]}')
            followee = agent_names.get(row[2], f'agent_{row[2]}')
            self.record(row[2], 'interaction', f'{follower}关注了我', 0.5)
            self.record_relationship(row[2], row[1], follower, 'followed me')
        
        # Update last ids
        new_lp = conn.execute('SELECT MAX(post_id) FROM post').fetchone()[0] or lp
        new_lc = conn.execute('SELECT MAX(comment_id) FROM comment').fetchone()[0] or lc
        new_ll = conn.execute('SELECT MAX(like_id) FROM like').fetchone()[0] or ll
        new_lf = conn.execute('SELECT MAX(follow_id) FROM follow').fetchone()[0] or lf
        return (new_lp, new_lc, new_ll, new_lf)


def inject_memories(agents_list, memory: AgentMemory):
    """Inject memory summaries into each agent's system prompt."""
    from oasis.social_agent.agent import SocialAgent
    
    for aid, agent in agents_list:
        summary = memory.get_summary(aid)
        if summary and hasattr(agent, 'system_message') and agent.system_message:
            # Store original content on first call
            if not hasattr(agent, '_original_system_content'):
                agent._original_system_content = agent.system_message.content
            
            agent.system_message.content = (
                agent._original_system_content + 
                f'\n\n=== 你的记忆 ===\n{summary}\n=== 记忆结束 ===\n'
            )


# ─── Goal System ─────────────────────────────────────────────────

class GoalTracker:
    """Track player's mission progress."""
    
    def __init__(self, goal_description, targets):
        self.description = goal_description
        self.targets = targets  # dict of metric -> target value
        self.progress = {k: 0 for k in targets}
    
    def update(self, conn, player_id):
        """Update progress from DB."""
        if 'followers' in self.targets:
            self.progress['followers'] = conn.execute(
                'SELECT COUNT(*) FROM follow WHERE followee_id=?', (player_id,)).fetchone()[0]
        if 'likes' in self.targets:
            self.progress['likes'] = len(conn.execute(
                'SELECT l.like_id FROM like l JOIN post p ON l.post_id=p.post_id WHERE p.user_id=?',
                (player_id,)).fetchall())
        if 'comments_received' in self.targets:
            self.progress['comments_received'] = len(conn.execute(
                'SELECT c.comment_id FROM comment c JOIN post p ON c.post_id=p.post_id WHERE p.user_id=?',
                (player_id,)).fetchall())
        if 'posts' in self.targets:
            self.progress['posts'] = conn.execute(
                'SELECT COUNT(*) FROM post WHERE user_id=?', (player_id,)).fetchone()[0]
    
    def display(self):
        print(f'\n  🎯 任务: {self.description}')
        all_done = True
        for metric, target in self.targets.items():
            current = self.progress.get(metric, 0)
            pct = min(100, int(current / target * 100))
            bar = '█' * (pct // 10) + '░' * (10 - pct // 10)
            done = '✅' if current >= target else '⬜'
            print(f'     {done} {metric}: {current}/{target} [{bar}] {pct}%')
            if current < target:
                all_done = False
        if all_done:
            print(f'  🏆 任务完成!')
        return all_done


# ─── Main ────────────────────────────────────────────────────────

async def main():
    patch_camel()
    
    from camel.models import ModelFactory
    from camel.types import ModelPlatformType
    import oasis
    from oasis import ActionType, LLMAction, ManualAction
    from oasis.social_agent.agents_generator import generate_twitter_agent_graph
    
    world_path = os.path.join(PROJECT_ROOT, 'worlds/cn-tech.json')
    with open(world_path) as f:
        world = json.load(f)
    
    print(f'\n🌍 WorldMind v2 — {world["name"]}')
    print(f'   记忆系统 + 对话链 + 目标系统')
    print('═' * 55)
    
    # Goal
    goal = GoalTracker(
        '让你的项目在社区中获得关注',
        {'followers': 4, 'likes': 6, 'comments_received': 5}
    )
    goal.display()
    print()
    
    # Generate profiles
    lang_suffix = f' 用{world["language"]}交流。'
    directive = world.get('agentDirective', '')
    lines = ['username,description,user_char']
    for arch in world['archetypes']:
        char = f'{arch["personality"]}{lang_suffix} {directive}'.replace('"', '""')
        lines.append(f'{arch["role"]},"{arch["description"]}","{char}"')
    lines.append(f'Myles,"Myles Liu","探索 AI 模拟的真人，正在做多 Agent 世界模拟项目。{lang_suffix}"')
    csv_path = os.path.join(PROJECT_ROOT, 'data/social/v2_profiles.csv')
    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    with open(csv_path, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    
    model = ModelFactory.create(
        model_platform=ModelPlatformType.OPENAI,
        model_type=os.environ.get('WORLDMIND_LLM_MODEL', 'gpt-4'))
    
    agent_graph = await generate_twitter_agent_graph(
        profile_path=csv_path, model=model,
        available_actions=[
            ActionType.CREATE_POST, ActionType.LIKE_POST,
            ActionType.REPOST, ActionType.CREATE_COMMENT,
            ActionType.FOLLOW, ActionType.DO_NOTHING,
        ])
    agents = list(agent_graph.get_agents())
    player_id, player_agent = agents[-1]
    
    # Build agent name map
    agent_names = {}
    for aid, ag in agents:
        ui = getattr(ag, 'user_info', None)
        agent_names[aid] = getattr(ui, 'user_name', None) or f'agent_{aid}'
    
    print(f'  ✅ {len(agents)} 个 Agent，你是 {agent_names[player_id]} (#{player_id})\n')
    
    if os.path.exists(DB_PATH): os.remove(DB_PATH)
    env = oasis.make(agent_graph=agent_graph, platform=oasis.DefaultPlatformType.TWITTER, database_path=DB_PATH)
    await env.reset()
    
    # Init systems
    memory = AgentMemory()
    conn = sqlite3.connect(DB_PATH)
    last_ids = (0, 0, 0, 0)
    
    async def do_step(n_min=5, n_max=None):
        nonlocal last_ids
        inject_memories(agents, memory)
        non_player = [(aid, ag) for aid, ag in agents if aid != player_id]
        n_max = n_max or len(non_player)
        n = random.randint(min(n_min, len(non_player)), min(n_max, len(non_player)))
        active = random.sample(non_player, n)
        t1 = datetime.now()
        await env.step({ag: LLMAction() for _, ag in active})
        elapsed = (datetime.now() - t1).total_seconds()
        last_ids = memory.process_db_changes(conn, last_ids, agent_names)
        return n, elapsed
    
    def show_new(since_ids):
        """Show new activity since given IDs."""
        lp, lc, ll, lf = since_ids
        for row in conn.execute('SELECT post_id, user_id, content FROM post WHERE post_id > ? ORDER BY post_id', (lp,)):
            you = ' (你)' if row[1] == player_id else ''
            print(f'    📄 {agent_names.get(row[1], "?")}{you}: {(row[2] or "")[:120]}')
        for row in conn.execute(
            'SELECT c.comment_id, c.user_id, c.content, c.post_id FROM comment c WHERE c.comment_id > ? ORDER BY c.comment_id', (lc,)):
            you = ' (你)' if row[1] == player_id else ''
            print(f'    💬 {agent_names.get(row[1], "?")}{you} → 帖子#{row[3]}: {(row[2] or "")[:120]}')
    
    # ═══════════════════════════════════════════════════════════
    # ROUND 1: 你发帖介绍项目
    # ═══════════════════════════════════════════════════════════
    print('═══ Round 1: 你发帖介绍项目 ═══\n')
    before = (
        conn.execute('SELECT MAX(post_id) FROM post').fetchone()[0] or 0,
        conn.execute('SELECT MAX(comment_id) FROM comment').fetchone()[0] or 0,
        conn.execute('SELECT MAX(like_id) FROM like').fetchone()[0] or 0,
        conn.execute('SELECT MAX(follow_id) FROM follow').fetchone()[0] or 0,
    )
    
    await env.step({player_agent: ManualAction(
        action_type=ActionType.CREATE_POST,
        action_args={'content': '大家好！我在做 WorldMind——一个多 Agent 世界模拟引擎。每个 Agent 有独立记忆和人格，能形成观点、传播信息、甚至进化。底层用 OASIS，上层 TypeScript。寻找志同道合的伙伴！🌍🤖'})})
    last_ids = memory.process_db_changes(conn, last_ids, agent_names)
    print('  📝 你: 发帖成功')
    
    print('  ⏱️  Agent 反应中...')
    n, t = await do_step(6, 10)
    print(f'  ✅ {n} 个 Agent ({t:.0f}s)\n')
    show_new(before)
    
    goal.update(conn, player_id)
    goal.display()
    print()
    
    # ═══════════════════════════════════════════════════════════
    # ROUND 2: 你回复一个质疑者（对话链）
    # ═══════════════════════════════════════════════════════════
    print('═══ Round 2: 回复质疑（对话链测试）═══\n')
    before = (
        conn.execute('SELECT MAX(post_id) FROM post').fetchone()[0] or 0,
        conn.execute('SELECT MAX(comment_id) FROM comment').fetchone()[0] or 0,
        conn.execute('SELECT MAX(like_id) FROM like').fetchone()[0] or 0,
        conn.execute('SELECT MAX(follow_id) FROM follow').fetchone()[0] or 0,
    )
    
    # Find a comment on player's post to reply to
    critic = conn.execute(
        'SELECT c.post_id, c.user_id, c.content FROM comment c JOIN post p ON c.post_id=p.post_id '
        'WHERE p.user_id=? ORDER BY c.comment_id LIMIT 1', (player_id,)).fetchone()
    
    if critic:
        critic_name = agent_names.get(critic[1], f'agent_{critic[1]}')
        print(f'  💬 {critic_name} 说: "{(critic[2] or "")[:100]}"')
        reply = f'@{critic_name} 好问题！WorldMind 的核心区别是每个 Agent 有持久记忆——他们会记住之前的对话和互动，形成真实的社交关系，而不是每轮都从零开始。这就是为什么行为更真实。'
        print(f'  💬 你回复: "{reply[:80]}..."')
        await env.step({player_agent: ManualAction(
            action_type=ActionType.CREATE_COMMENT,
            action_args={'post_id': critic[0], 'content': reply})})
        last_ids = memory.process_db_changes(conn, last_ids, agent_names)
    
    # Agents react — with memory of Round 1!
    print('  ⏱️  Agent 反应中（带记忆）...')
    n, t = await do_step(6, 9)
    print(f'  ✅ {n} 个 Agent ({t:.0f}s)\n')
    show_new(before)
    
    goal.update(conn, player_id)
    goal.display()
    print()
    
    # ═══════════════════════════════════════════════════════════
    # ROUND 3: 你发第二条帖子（验证记忆——agents 应该引用你之前说的）
    # ═══════════════════════════════════════════════════════════
    print('═══ Round 3: 第二条帖子（记忆验证）═══\n')
    before = (
        conn.execute('SELECT MAX(post_id) FROM post').fetchone()[0] or 0,
        conn.execute('SELECT MAX(comment_id) FROM comment').fetchone()[0] or 0,
        conn.execute('SELECT MAX(like_id) FROM like').fetchone()[0] or 0,
        conn.execute('SELECT MAX(follow_id) FROM follow').fetchone()[0] or 0,
    )
    
    await env.step({player_agent: ManualAction(
        action_type=ActionType.CREATE_POST,
        action_args={'content': 'WorldMind 更新：刚刚实现了 Agent 记忆系统！现在每个 Agent 都能记住之前的对话和互动。下一步是进化系统——表现好的 Agent 人格会被"繁殖"，差的会被淘汰。达尔文社交模拟！🧬'})})
    last_ids = memory.process_db_changes(conn, last_ids, agent_names)
    print('  📝 你: 发布项目更新')
    
    print('  ⏱️  Agent 反应中（应该引用之前的对话）...')
    n, t = await do_step(7, 10)
    print(f'  ✅ {n} 个 Agent ({t:.0f}s)\n')
    show_new(before)
    
    goal.update(conn, player_id)
    goal.display()
    print()
    
    # ═══════════════════════════════════════════════════════════
    # ROUND 4: 注入新闻 + 你参与讨论
    # ═══════════════════════════════════════════════════════════
    print('═══ Round 4: 💥 突发新闻 + 你参与讨论 ═══\n')
    before = (
        conn.execute('SELECT MAX(post_id) FROM post').fetchone()[0] or 0,
        conn.execute('SELECT MAX(comment_id) FROM comment').fetchone()[0] or 0,
        conn.execute('SELECT MAX(like_id) FROM like').fetchone()[0] or 0,
        conn.execute('SELECT MAX(follow_id) FROM follow').fetchone()[0] or 0,
    )
    
    # Inject news from journalist
    journalist_agent = None
    for aid, ag in agents:
        if agent_names.get(aid) == 'journalist':
            journalist_agent = ag
            break
    if journalist_agent:
        await env.step({journalist_agent: ManualAction(
            action_type=ActionType.CREATE_POST,
            action_args={'content': '📢 重磅：Google DeepMind 宣布实现 AGI 基准测试 90% 通过率，论文将在下周公开。如果属实，这将是 AI 领域的里程碑时刻。'})})
        last_ids = memory.process_db_changes(conn, last_ids, agent_names)
        print('  📢 journalist 发布: AGI 突破新闻')
    
    # You comment on the news
    news_post = conn.execute('SELECT post_id FROM post ORDER BY post_id DESC LIMIT 1').fetchone()
    if news_post:
        await env.step({player_agent: ManualAction(
            action_type=ActionType.CREATE_COMMENT,
            action_args={'post_id': news_post[0], 'content': '有意思。如果 AGI 真的来了，WorldMind 这样的多 Agent 模拟就更重要了——我们需要理解 AGI agent 在社会中的涌现行为。这不是玩具项目，是安全研究的基础设施。'})})
        last_ids = memory.process_db_changes(conn, last_ids, agent_names)
        print('  💬 你评论: 把 AGI 新闻跟你的项目关联起来')
    
    print('  ⏱️  Agent 反应中...')
    n, t = await do_step(8, 10)
    print(f'  ✅ {n} 个 Agent ({t:.0f}s)\n')
    show_new(before)
    
    goal.update(conn, player_id)
    goal.display()
    
    # ═══════════════════════════════════════════════════════════
    # Final report
    # ═══════════════════════════════════════════════════════════
    print('\n' + '═' * 55)
    print('📊 最终报告\n')
    
    tp = conn.execute('SELECT COUNT(*) FROM post').fetchone()[0]
    tc = conn.execute('SELECT COUNT(*) FROM comment').fetchone()[0]
    tl = conn.execute('SELECT COUNT(*) FROM like').fetchone()[0]
    tf = conn.execute('SELECT COUNT(*) FROM follow').fetchone()[0]
    tt = conn.execute('SELECT COUNT(*) FROM trace').fetchone()[0]
    
    print(f'  世界: {tp} 帖, {tc} 评论, {tl} 赞, {tf} 关注, {tt} 行为')
    
    yf = conn.execute('SELECT COUNT(*) FROM follow WHERE followee_id=?', (player_id,)).fetchone()[0]
    yl = len(conn.execute('SELECT l.like_id FROM like l JOIN post p ON l.post_id=p.post_id WHERE p.user_id=?', (player_id,)).fetchall())
    print(f'  你: {yf} 粉丝, {yl} 赞')
    
    # Show agent memory state
    print('\n  🧠 Agent 记忆状态:')
    for aid in sorted(memory.memories.keys()):
        name = agent_names.get(aid, f'agent_{aid}')
        mem = memory.memories[aid]
        n_eps = len(mem['episodes'])
        n_rels = len(mem['relationships'])
        if n_eps > 0 or n_rels > 0:
            print(f'    {name}: {n_eps} 条记忆, 认识 {n_rels} 个人')
    
    print()
    conn.close()
    await env.close()
    print('✅ v2 演示完成!\n')


if __name__ == '__main__':
    asyncio.run(main())
