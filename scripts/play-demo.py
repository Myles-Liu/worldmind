#!/usr/bin/env python3
"""
Player-in-the-Loop full demo.
Reads world config from worlds/*.json, generates agents, runs simulation.

Usage:
  python3 scripts/play-demo.py                    # default: cn-tech, 2 rounds
  python3 scripts/play-demo.py --world en-tech    # English tech
  python3 scripts/play-demo.py --rounds 3         # 3 rounds of agent reactions
"""

import asyncio, os, json, sqlite3, random, sys, copy

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORLDS_DIR = os.path.join(PROJECT_ROOT, 'worlds')
DB_PATH = os.path.join(PROJECT_ROOT, 'data/social/play_demo.db')


def load_env():
    env_path = os.path.join(PROJECT_ROOT, '.env')
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    os.environ.setdefault(k.strip(), v.strip())


def load_world(name_or_path):
    """Load world settings from JSON file."""
    if os.path.exists(name_or_path):
        path = name_or_path
    else:
        path = os.path.join(WORLDS_DIR, f'{name_or_path}.json')
    if not os.path.exists(path):
        available = [f[:-5] for f in os.listdir(WORLDS_DIR) if f.endswith('.json')]
        print(f'❌ World not found: {name_or_path}')
        print(f'   Available: {", ".join(available)}')
        sys.exit(1)
    with open(path) as f:
        return json.load(f)


def generate_csv(world, player_name='Myles', player_bio='探索 AI 模拟世界的真人。'):
    """Generate agent profile CSV from world config."""
    lang = world.get('language', 'English')
    lang_suffix = f' 用{lang}交流。' if lang != 'English' else ''
    directive = world.get('agentDirective', '')
    directive_suffix = f' {directive}' if directive else ''

    lines = ['username,description,user_char']
    archetypes = world.get('archetypes', [])
    count = world.get('agentCount', len(archetypes))

    for i in range(count):
        arch = archetypes[i % len(archetypes)]
        suffix = f'_{i // len(archetypes) + 1}' if i >= len(archetypes) else ''
        username = f'{arch["role"]}{suffix}'
        desc = arch['description'].replace('"', '""')
        char = f'{arch["personality"]}{lang_suffix}{directive_suffix}'.replace('"', '""')
        lines.append(f'{username},"{desc}","{char}"')

    # Player
    bio = f'{player_bio}{lang_suffix}'.replace('"', '""')
    lines.append(f'{player_name},"{player_name}","{bio}"')

    return '\n'.join(lines) + '\n'


# ─── Streaming API Patch ────────────────────────────────────────

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


# ─── Main ────────────────────────────────────────────────────────

async def main():
    # Parse args
    world_name = 'cn-tech'
    rounds = 2
    player_name = 'Myles'
    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == '--world' and i < len(sys.argv) - 1: world_name = sys.argv[i + 1]
        if arg == '--rounds' and i < len(sys.argv) - 1: rounds = int(sys.argv[i + 1])
        if arg == '--name' and i < len(sys.argv) - 1: player_name = sys.argv[i + 1]

    load_env()
    os.environ['OPENAI_API_KEY'] = os.environ.get('WORLDMIND_LLM_API_KEY', '')
    os.environ['OPENAI_API_BASE_URL'] = os.environ.get('WORLDMIND_LLM_BASE_URL', '')

    # Load world
    world = load_world(world_name)
    print(f'\n🌍 WorldMind — {world["name"]}')
    print('═' * 50)
    print(f'  语言: {world.get("language", "English")}')
    print(f'  平台: {world.get("platform", "twitter")}')
    print(f'  Agent 数: {world.get("agentCount", 10)}')
    print(f'  轮数: {rounds}')
    print()

    # Generate profiles
    csv = generate_csv(world, player_name)
    csv_path = os.path.join(PROJECT_ROOT, 'data/social/play_demo_profiles.csv')
    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    with open(csv_path, 'w') as f:
        f.write(csv)

    # Patch & import
    patch_camel()
    from camel.models import ModelFactory
    from camel.types import ModelPlatformType
    import oasis
    from oasis import ActionType, LLMAction, ManualAction
    from oasis.social_agent.agents_generator import generate_twitter_agent_graph

    model_name = os.environ.get('WORLDMIND_LLM_MODEL', 'gpt-4')
    model = ModelFactory.create(model_platform=ModelPlatformType.OPENAI, model_type=model_name)
    print(f'  LLM: {model_name}')

    actions_list = [
        ActionType.CREATE_POST, ActionType.LIKE_POST,
        ActionType.REPOST, ActionType.CREATE_COMMENT,
        ActionType.FOLLOW, ActionType.DO_NOTHING,
    ]

    print('  📋 生成 Agent...')
    agent_graph = await generate_twitter_agent_graph(
        profile_path=csv_path, model=model, available_actions=actions_list)
    agents = list(agent_graph.get_agents())
    player_id, player_agent = agents[-1]
    print(f'  ✅ {len(agents)} 个 Agent 就绪，你是 #{player_id}\n')

    if os.path.exists(DB_PATH): os.remove(DB_PATH)
    env = oasis.make(
        agent_graph=agent_graph,
        platform=oasis.DefaultPlatformType.TWITTER,
        database_path=DB_PATH)
    await env.reset()
    print('  ✅ 世界已创建\n')

    # ─── Round 1: Player posts ───
    lang = world.get('language', 'English')
    if lang == '中文':
        post_content = '大家好！我在做一个多 Agent 世界模拟引擎——类似模拟人生，但每个市民都由大模型驱动。他们会形成观点、传播信息、甚至随时间进化。有人感兴趣一起搞吗？🌍🤖'
    else:
        post_content = 'Hey everyone! Building a multi-agent world simulation — think SimCity but every citizen runs on an LLM. They form opinions, spread info, even evolve. Anyone interested? 🌍🤖'

    print('═══ Round 1: 你发帖 ═══\n')
    await env.step({
        player_agent: ManualAction(
            action_type=ActionType.CREATE_POST,
            action_args={'content': post_content})
    })
    print(f'  📝 已发布: {post_content[:60]}...\n')

    # ─── Agent reaction rounds ───
    from datetime import datetime
    for r in range(1, rounds + 1):
        print(f'═══ Round {r+1}: Agent 反应中 ═══\n')
        non_player = [(aid, ag) for aid, ag in agents if aid != player_id]
        n = random.randint(max(3, len(non_player) // 2), len(non_player))
        active = random.sample(non_player, n)
        print(f'  ⏱️  {n} 个 Agent 思考中...')

        t1 = datetime.now()
        try:
            await env.step({ag: LLMAction() for _, ag in active})
        except Exception as e:
            print(f'  ⚠️  部分 Agent 出错: {e}')
        elapsed = (datetime.now() - t1).total_seconds()
        print(f'  ✅ 完成 ({elapsed:.0f}s)\n')

    await env.close()

    # ─── Results ───
    conn = sqlite3.connect(DB_PATH)

    print('═══ 📰 信息流 ═══\n')
    for row in conn.execute('SELECT post_id, user_id, content, num_likes, num_shares FROM post ORDER BY post_id'):
        you = ' 👈 你' if row[1] == player_id else ''
        print(f'  📄 帖子 #{row[0]} by agent_{row[1]}{you} | ❤️{row[3]} 🔄{row[4]}')
        content = row[2] or ''
        print(f'     {content[:200]}')
        for c in conn.execute('SELECT user_id, content FROM comment WHERE post_id=?', (row[0],)):
            cyou = ' (你)' if c[0] == player_id else ''
            print(f'     💬 agent_{c[0]}{cyou}: {(c[1] or "")[:150]}')
        print()

    print('═══ 🔔 与你的互动 ═══\n')
    likes = conn.execute(
        'SELECT l.user_id FROM like l JOIN post p ON l.post_id=p.post_id WHERE p.user_id=?',
        (player_id,)).fetchall()
    for l in likes:
        print(f'  ❤️ agent_{l[0]} 赞了你的帖子')

    followers = conn.execute('SELECT follower_id FROM follow WHERE followee_id=?', (player_id,)).fetchall()
    for f in followers:
        print(f'  👤 agent_{f[0]} 关注了你')

    comments_on_you = conn.execute(
        'SELECT c.user_id, c.content FROM comment c JOIN post p ON c.post_id=p.post_id WHERE p.user_id=?',
        (player_id,)).fetchall()
    for c in comments_on_you:
        print(f'  💬 agent_{c[0]}: {(c[1] or "")[:100]}')
    print()

    print('═══ 📊 世界统计 ═══\n')
    tp = conn.execute('SELECT COUNT(*) FROM post').fetchone()[0]
    tc = conn.execute('SELECT COUNT(*) FROM comment').fetchone()[0]
    tl = conn.execute('SELECT COUNT(*) FROM like').fetchone()[0]
    tf = conn.execute('SELECT COUNT(*) FROM follow').fetchone()[0]
    tt = conn.execute('SELECT COUNT(*) FROM trace').fetchone()[0]
    print(f'  帖子: {tp}  评论: {tc}  点赞: {tl}  关注: {tf}  总行为: {tt}')
    yp = conn.execute('SELECT COUNT(*) FROM post WHERE user_id=?', (player_id,)).fetchone()[0]
    print(f'  你的帖子: {yp}  你的粉丝: {len(followers)}  你收到的赞: {len(likes)}')
    print()

    conn.close()
    print('✅ 模拟完成!\n')


if __name__ == '__main__':
    asyncio.run(main())
