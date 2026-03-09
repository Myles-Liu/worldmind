#!/usr/bin/env python3
"""
Player-in-the-Loop demo — validates the full interactive experience.
Myles joins, posts, agents react, then we read the results.
"""

import asyncio, os, json, sqlite3, random, sys, copy

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, 'data/social/play_demo.db')
PROFILE = os.path.join(PROJECT_ROOT, 'data/social/twitter_agents_10.csv')

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
    _orig = OpenAIModel._arequest_chat_completion
    async def _patched(self, messages, tools=None):
        cfg = copy.deepcopy(self.model_config_dict)
        if tools: cfg["tools"] = tools
        cfg = self._sanitize_config(cfg)
        cfg["stream"] = True
        stream = await self._async_client.chat.completions.create(
            messages=messages, model=self.model_type, **cfg)
        parts, tc_map, finish, cid, model_name = [], {}, None, "", self.model_type
        async for chunk in stream:
            if chunk.id: cid = chunk.id
            if chunk.model: model_name = chunk.model
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
            model=model_name, usage=CompletionUsage.model_construct(prompt_tokens=0,completion_tokens=0,total_tokens=0),
            choices=[Choice.model_construct(finish_reason=finish or "stop", index=0, message=msg)])
    OpenAIModel._arequest_chat_completion = _patched
    print("🔧 CAMEL patched")


async def main():
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 2

    print(f"\n🌍 WorldMind Player-in-the-Loop Demo")
    print("═" * 50)

    patch_camel()

    from camel.models import ModelFactory
    from camel.types import ModelPlatformType
    import oasis
    from oasis import ActionType, LLMAction, ManualAction
    from oasis.social_agent.agents_generator import generate_twitter_agent_graph

    model_name = os.environ.get('WORLDMIND_LLM_MODEL', 'gpt-4')
    model = ModelFactory.create(model_platform=ModelPlatformType.OPENAI, model_type=model_name)
    print(f"  LLM: {model_name}")

    actions_list = [
        ActionType.CREATE_POST, ActionType.LIKE_POST,
        ActionType.REPOST, ActionType.CREATE_COMMENT,
        ActionType.FOLLOW, ActionType.DO_NOTHING,
    ]

    # Add player to profiles
    with open(PROFILE) as f:
        content = f.read()
    player_csv = PROFILE.replace('.csv', '_player.csv')
    with open(player_csv, 'w') as f:
        f.write(content.strip() + '\nMyles,"Myles Liu","A real human exploring AI simulations. Direct, curious, no bullshit."\n')

    print("  📋 Generating agents...")
    agent_graph = await generate_twitter_agent_graph(
        profile_path=player_csv, model=model, available_actions=actions_list)
    agents = list(agent_graph.get_agents())
    player_id, player_agent = agents[-1]
    print(f"  ✅ {len(agents)} agents. Player = #{player_id}\n")

    if os.path.exists(DB_PATH): os.remove(DB_PATH)
    env = oasis.make(agent_graph=agent_graph, platform=oasis.DefaultPlatformType.TWITTER, database_path=DB_PATH)
    await env.reset()
    print("  ✅ World ready\n")

    # ─── Round 1: Player posts ───
    print("═══ Round 1: You post ═══\n")
    await env.step({
        player_agent: ManualAction(
            action_type=ActionType.CREATE_POST,
            action_args={'content': 'Hey everyone! Building a multi-agent world simulation — think SimCity but every citizen runs on an LLM. They form opinions, spread info, even evolve over time. Looking for collaborators who want to push this further. 🌍🤖'},
        )
    })
    print("  📝 Posted!\n")

    # ─── Rounds 2+: Agents react ───
    for r in range(1, rounds + 1):
        print(f"═══ Round {r+1}: Agents react ═══\n")
        non_player = [(aid, ag) for aid, ag in agents if aid != player_id]
        n = random.randint(max(3, len(non_player) // 2), len(non_player))
        active = random.sample(non_player, n)
        print(f"  ⏱️  {n} agents thinking...")

        from datetime import datetime
        t1 = datetime.now()
        await env.step({ag: LLMAction() for _, ag in active})
        elapsed = (datetime.now() - t1).total_seconds()
        print(f"  ✅ Done in {elapsed:.0f}s\n")

    # ─── Read results ───
    conn = sqlite3.connect(DB_PATH)

    print("═══ 📰 FEED ═══\n")
    for row in conn.execute('SELECT post_id, user_id, content, num_likes, num_shares FROM post ORDER BY post_id'):
        you = " 👈 YOU" if row[1] == player_id else ""
        print(f"  📄 Post #{row[0]} by agent_{row[1]}{you} | ❤️{row[3]} 🔄{row[4]}")
        print(f"     {row[2][:200]}")
        for c in conn.execute('SELECT user_id, content FROM comment WHERE post_id=?', (row[0],)):
            cyou = " (YOU)" if c[0] == player_id else ""
            print(f"     💬 agent_{c[0]}{cyou}: {c[1][:150]}")
        print()

    print("═══ 🔔 YOUR INTERACTIONS ═══\n")
    likes_on_you = conn.execute(
        'SELECT l.user_id FROM like l JOIN post p ON l.post_id=p.post_id WHERE p.user_id=?',
        (player_id,)).fetchall()
    for l in likes_on_you:
        print(f"  ❤️ agent_{l[0]} liked your post")

    followers = conn.execute('SELECT follower_id FROM follow WHERE followee_id=?', (player_id,)).fetchall()
    for f in followers:
        print(f"  👤 agent_{f[0]} followed you")
    print()

    print("═══ 📊 WORLD STATS ═══\n")
    tp = conn.execute('SELECT COUNT(*) FROM post').fetchone()[0]
    tc = conn.execute('SELECT COUNT(*) FROM comment').fetchone()[0]
    tl = conn.execute('SELECT COUNT(*) FROM like').fetchone()[0]
    tf = conn.execute('SELECT COUNT(*) FROM follow').fetchone()[0]
    tt = conn.execute('SELECT COUNT(*) FROM trace').fetchone()[0]
    print(f"  Posts: {tp}  Comments: {tc}  Likes: {tl}  Follows: {tf}  Total traces: {tt}")
    print(f"  Your posts: {conn.execute('SELECT COUNT(*) FROM post WHERE user_id=?',(player_id,)).fetchone()[0]}")
    print(f"  Your followers: {len(followers)}")
    print(f"  Likes on your posts: {len(likes_on_you)}")
    print()

    conn.close()
    await env.close()
    print("✅ Simulation complete!\n")


if __name__ == '__main__':
    asyncio.run(main())
