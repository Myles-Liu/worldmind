#!/usr/bin/env python3
"""
Full interactive demo — multiple player actions + agent reactions.
Shows the full range: post, comment, like, follow, news injection.
"""

import asyncio, os, json, sqlite3, random, sys, copy
from datetime import datetime

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, 'data/social/full_demo.db')

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


def agent_step(agents, player_id, n_min=3, n_max=None):
    """Return actions dict for random non-player agents."""
    from oasis import LLMAction
    non_player = [(aid, ag) for aid, ag in agents if aid != player_id]
    n_max = n_max or len(non_player)
    n = random.randint(min(n_min, len(non_player)), min(n_max, len(non_player)))
    active = random.sample(non_player, n)
    return {ag: LLMAction() for _, ag in active}, n


def print_new_activity(conn, last_post_id, last_comment_id, last_like_id, player_id):
    """Print activity that happened since last check."""
    new_posts = conn.execute(
        'SELECT post_id, user_id, content FROM post WHERE post_id > ? ORDER BY post_id',
        (last_post_id,)).fetchall()
    new_comments = conn.execute(
        'SELECT comment_id, post_id, user_id, content FROM comment WHERE comment_id > ? ORDER BY comment_id',
        (last_comment_id,)).fetchall()
    new_likes = conn.execute(
        'SELECT like_id, user_id, post_id FROM like WHERE like_id > ? ORDER BY like_id',
        (last_like_id,)).fetchall()

    if new_posts:
        for p in new_posts:
            you = ' (你)' if p[1] == player_id else ''
            print(f'    📄 新帖 #{p[0]} agent_{p[1]}{you}: {(p[2] or "")[:120]}')
    if new_comments:
        for c in new_comments:
            you = ' (你)' if c[2] == player_id else ''
            print(f'    💬 新评论 agent_{c[2]}{you} → 帖子#{c[1]}: {(c[3] or "")[:120]}')
    if new_likes:
        for l in new_likes:
            # Check if it's on player's post
            owner = conn.execute('SELECT user_id FROM post WHERE post_id=?', (l[2],)).fetchone()
            if owner and owner[0] == player_id:
                print(f'    ❤️ agent_{l[1]} 赞了你的帖子 #{l[2]}')

    return (
        max([p[0] for p in new_posts], default=last_post_id),
        max([c[0] for c in new_comments], default=last_comment_id),
        max([l[0] for l in new_likes], default=last_like_id),
    )


async def main():
    patch_camel()

    from camel.models import ModelFactory
    from camel.types import ModelPlatformType
    import oasis
    from oasis import ActionType, LLMAction, ManualAction
    from oasis.social_agent.agents_generator import generate_twitter_agent_graph

    # Load world
    world_path = os.path.join(PROJECT_ROOT, 'worlds/cn-tech.json')
    with open(world_path) as f:
        world = json.load(f)

    print(f'\n🌍 WorldMind 完整交互演示 — {world["name"]}')
    print('═' * 55)

    # Generate profiles
    lang_suffix = f' 用{world["language"]}交流。' if world['language'] != 'English' else ''
    directive = world.get('agentDirective', '')
    lines = ['username,description,user_char']
    for arch in world['archetypes']:
        char = f'{arch["personality"]}{lang_suffix} {directive}'.replace('"', '""')
        lines.append(f'{arch["role"]},"{arch["description"]}","{char}"')
    lines.append(f'Myles,"Myles Liu","探索 AI 模拟的真人。好奇直接。{lang_suffix}"')
    csv_path = os.path.join(PROJECT_ROOT, 'data/social/full_demo_profiles.csv')
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
    print(f'  ✅ {len(agents)} 个 Agent，你是 #{player_id}\n')

    if os.path.exists(DB_PATH): os.remove(DB_PATH)
    env = oasis.make(agent_graph=agent_graph, platform=oasis.DefaultPlatformType.TWITTER, database_path=DB_PATH)
    await env.reset()
    conn = sqlite3.connect(DB_PATH)
    lp, lc, ll = 0, 0, 0  # last post/comment/like id

    # ════════════════════════════════════════════════════════════
    # ACT 1: 你发帖
    # ════════════════════════════════════════════════════════════
    print('═══ ACT 1: 你发帖 ═══\n')
    await env.step({player_agent: ManualAction(
        action_type=ActionType.CREATE_POST,
        action_args={'content': '大家好！我在做一个多 Agent 世界模拟引擎，底层用 OASIS，上层用 TypeScript。每个 Agent 都有独立人格和记忆。有人想一起搞吗？🌍'})})
    print('  📝 你: 发帖成功\n')

    # Agents react
    print('  ⏱️  Agent 反应中...')
    t1 = datetime.now()
    actions, n = agent_step(agents, player_id, 6, 10)
    await env.step(actions)
    print(f'  ✅ {n} 个 Agent 行动 ({(datetime.now()-t1).total_seconds():.0f}s)\n')
    lp, lc, ll = print_new_activity(conn, lp, lc, ll, player_id)
    print()

    # ════════════════════════════════════════════════════════════
    # ACT 2: 你评论别人的帖子
    # ════════════════════════════════════════════════════════════
    print('═══ ACT 2: 你评论 Agent 的帖子 ═══\n')
    # Find a post by an agent (not player)
    agent_post = conn.execute(
        'SELECT post_id, user_id, content FROM post WHERE user_id != ? ORDER BY post_id DESC LIMIT 1',
        (player_id,)).fetchone()
    if agent_post:
        print(f'  💬 你评论帖子 #{agent_post[0]}（agent_{agent_post[1]}）:')
        print(f'     原帖: {(agent_post[2] or "")[:100]}')
        await env.step({player_agent: ManualAction(
            action_type=ActionType.CREATE_COMMENT,
            action_args={'post_id': agent_post[0], 'content': '说得好！我觉得关键在于 Agent 的记忆系统——没有持续记忆，社交行为就不可能真实。你怎么看？'})})
        print('  ✅ 评论成功\n')

        # Agents react to your comment
        print('  ⏱️  Agent 反应中...')
        t1 = datetime.now()
        actions, n = agent_step(agents, player_id, 5, 8)
        await env.step(actions)
        print(f'  ✅ {n} 个 Agent 行动 ({(datetime.now()-t1).total_seconds():.0f}s)\n')
        lp, lc, ll = print_new_activity(conn, lp, lc, ll, player_id)
    else:
        print('  ⚠️ 没找到 Agent 帖子可评论\n')
    print()

    # ════════════════════════════════════════════════════════════
    # ACT 3: 你点赞 + 关注
    # ════════════════════════════════════════════════════════════
    print('═══ ACT 3: 你点赞 + 关注 ═══\n')
    # Like the most popular post
    popular = conn.execute(
        'SELECT post_id, user_id, num_likes FROM post WHERE user_id != ? ORDER BY num_likes DESC LIMIT 1',
        (player_id,)).fetchone()
    if popular:
        print(f'  ❤️ 你赞了帖子 #{popular[0]}（agent_{popular[1]}，当前 {popular[2]} 赞）')
        await env.step({player_agent: ManualAction(
            action_type=ActionType.LIKE_POST,
            action_args={'post_id': popular[0]})})

    # Follow the journalist (likely to amplify)
    journalist_id = None
    for aid, ag in agents:
        ui = getattr(ag, 'user_info', None)
        uname = getattr(ui, 'user_name', None) if ui else None
        if uname == 'journalist':
            journalist_id = aid
            break
    if journalist_id:
        print(f'  👤 你关注了 journalist (agent #{journalist_id})')
        await env.step({player_agent: ManualAction(
            action_type=ActionType.FOLLOW,
            action_args={'followee_id': journalist_id})})
    print('  ✅ 操作完成\n')

    # Agents react
    print('  ⏱️  Agent 反应中...')
    t1 = datetime.now()
    actions, n = agent_step(agents, player_id, 5, 8)
    await env.step(actions)
    print(f'  ✅ {n} 个 Agent 行动 ({(datetime.now()-t1).total_seconds():.0f}s)\n')
    lp, lc, ll = print_new_activity(conn, lp, lc, ll, player_id)
    print()

    # ════════════════════════════════════════════════════════════
    # ACT 4: 注入爆炸新闻（Admin 模式）
    # ════════════════════════════════════════════════════════════
    print('═══ ACT 4: 💥 注入爆炸新闻 ═══\n')
    # Use agent_0 (engineer) as the news source
    news_agent = agents[0][1]
    await env.step({news_agent: ManualAction(
        action_type=ActionType.CREATE_POST,
        action_args={'content': '📢 突发：OpenAI 刚刚宣布开源 GPT-5 全部权重！基于 Apache 2.0 协议，任何人都可以下载和部署。这将彻底改变 AI 行业格局。'})})
    print('  📢 新闻注入: "OpenAI 开源 GPT-5 全部权重"\n')

    # All agents react to breaking news
    print('  ⏱️  全体 Agent 反应中...')
    t1 = datetime.now()
    actions, n = agent_step(agents, player_id, 8, 10)
    await env.step(actions)
    print(f'  ✅ {n} 个 Agent 行动 ({(datetime.now()-t1).total_seconds():.0f}s)\n')
    lp, lc, ll = print_new_activity(conn, lp, lc, ll, player_id)
    print()

    # ════════════════════════════════════════════════════════════
    # Final stats
    # ════════════════════════════════════════════════════════════
    print('═' * 55)
    print('📊 最终世界状态\n')
    tp = conn.execute('SELECT COUNT(*) FROM post').fetchone()[0]
    tc = conn.execute('SELECT COUNT(*) FROM comment').fetchone()[0]
    tl = conn.execute('SELECT COUNT(*) FROM like').fetchone()[0]
    tf = conn.execute('SELECT COUNT(*) FROM follow').fetchone()[0]
    tt = conn.execute('SELECT COUNT(*) FROM trace').fetchone()[0]
    your_followers = conn.execute('SELECT COUNT(*) FROM follow WHERE followee_id=?', (player_id,)).fetchone()[0]
    your_likes = len(conn.execute(
        'SELECT l.like_id FROM like l JOIN post p ON l.post_id=p.post_id WHERE p.user_id=?',
        (player_id,)).fetchall())

    print(f'  世界: {tp} 帖子, {tc} 评论, {tl} 赞, {tf} 关注, {tt} 总行为')
    print(f'  你: {your_followers} 粉丝, {your_likes} 收到的赞')
    print()

    conn.close()
    await env.close()
    print('✅ 完整演示结束!\n')


if __name__ == '__main__':
    asyncio.run(main())
