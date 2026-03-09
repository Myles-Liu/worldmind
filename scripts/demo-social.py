#!/usr/bin/env python3
"""
Minimal OASIS social simulation demo.
Runs 10 agents for a few rounds on a Twitter-like platform.
"""

import asyncio
import json
import os
import sys
import sqlite3
from datetime import datetime

# Point to project root
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILE_PATH = os.path.join(PROJECT_ROOT, "data/social/twitter_agents_10.csv")
DB_PATH = os.path.join(PROJECT_ROOT, "data/social/demo_sim.db")

# LLM config from .env
def load_env():
    env_path = os.path.join(PROJECT_ROOT, ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    os.environ.setdefault(k.strip(), v.strip())

load_env()


def patch_camel_for_streaming_api():
    """
    Patch CAMEL's OpenAI model to handle APIs that always return SSE streams.
    Our internal proxy always returns streaming responses regardless of the
    `stream` parameter. This patch forces stream=True and collects chunks
    into a standard ChatCompletion object.
    """
    from camel.models.openai_model import OpenAIModel
    import copy

    _original = OpenAIModel._arequest_chat_completion

    async def _patched(self, messages, tools=None):
        request_config = copy.deepcopy(self.model_config_dict)
        if tools:
            request_config["tools"] = tools
        request_config = self._sanitize_config(request_config)
        request_config["stream"] = True

        stream = await self._async_client.chat.completions.create(
            messages=messages,
            model=self.model_type,
            **request_config,
        )

        # Collect chunks into a single response
        content_parts = []
        tool_calls_map = {}  # index -> {id, type, function: {name, arguments}}
        finish_reason = None
        model_name = self.model_type
        comp_id = ""
        usage_info = None

        async for chunk in stream:
            if chunk.id:
                comp_id = chunk.id
            if chunk.model:
                model_name = chunk.model
            if chunk.usage:
                usage_info = chunk.usage

            for choice in (chunk.choices or []):
                delta = choice.delta
                if delta.content:
                    content_parts.append(delta.content)
                if choice.finish_reason:
                    finish_reason = choice.finish_reason

                # Handle tool calls in streaming
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in tool_calls_map:
                            tool_calls_map[idx] = {
                                "id": tc.id or "",
                                "type": "function",
                                "function": {"name": "", "arguments": ""},
                            }
                        if tc.id:
                            tool_calls_map[idx]["id"] = tc.id
                        if tc.function:
                            if tc.function.name:
                                tool_calls_map[idx]["function"]["name"] = tc.function.name
                            if tc.function.arguments:
                                tool_calls_map[idx]["function"]["arguments"] += tc.function.arguments

        # Build tool_calls list (use raw dicts for SDK compatibility)
        tc_list = None
        if tool_calls_map:
            tc_list = []
            for idx in sorted(tool_calls_map.keys()):
                tc = tool_calls_map[idx]
                tc_list.append({
                    "id": tc["id"],
                    "type": "function",
                    "function": {
                        "name": tc["function"]["name"],
                        "arguments": tc["function"]["arguments"],
                    },
                })

        # Build a ChatCompletion-compatible object using the SDK's construct methods
        from openai.types.chat import ChatCompletion, ChatCompletionMessage
        from openai.types.chat.chat_completion import Choice
        from openai.types.completion_usage import CompletionUsage

        # Use model_construct to bypass validation (works across openai SDK versions)
        msg = ChatCompletionMessage.model_construct(
            role="assistant",
            content="".join(content_parts) or None,
            tool_calls=tc_list,
        )

        usage = CompletionUsage.model_construct(
            prompt_tokens=getattr(usage_info, 'prompt_tokens', 0) or 0,
            completion_tokens=getattr(usage_info, 'completion_tokens', 0) or 0,
            total_tokens=getattr(usage_info, 'total_tokens', 0) or 0,
        )

        choice = Choice.model_construct(
            finish_reason=finish_reason or "stop",
            index=0,
            message=msg,
        )

        return ChatCompletion.model_construct(
            id=comp_id or "chatcmpl-patched",
            choices=[choice],
            created=int(__import__('time').time()),
            model=model_name,
            object="chat.completion",
            usage=usage,
        )

    OpenAIModel._arequest_chat_completion = _patched
    print("  🔧 Patched CAMEL for streaming API compatibility")


async def main():
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 3

    print(f"\n🐦 WorldMind Social Simulation Demo")
    print(f"{'═' * 50}")
    print(f"  Platform: Twitter (OASIS)")
    print(f"  Agents: 10")
    print(f"  Rounds: {rounds}")
    print(f"  Profile: {PROFILE_PATH}")
    print()

    # Import OASIS
    from camel.models import ModelFactory
    from camel.types import ModelPlatformType, ModelType
    import oasis
    from oasis import ActionType, LLMAction, ManualAction

    # Create LLM model
    api_key = os.environ.get("WORLDMIND_LLM_API_KEY", os.environ.get("OPENAI_API_KEY", ""))
    base_url = os.environ.get("WORLDMIND_LLM_BASE_URL", os.environ.get("OPENAI_API_BASE", ""))
    model_name = os.environ.get("WORLDMIND_LLM_MODEL", "gpt-4o-mini")

    if not api_key:
        print("❌ No API key found. Set WORLDMIND_LLM_API_KEY or OPENAI_API_KEY in .env")
        sys.exit(1)

    print(f"  LLM: {model_name}")
    print(f"  Base URL: {base_url[:50]}..." if len(base_url) > 50 else f"  Base URL: {base_url}")
    print()

    # CAMEL ModelFactory needs specific env vars
    os.environ["OPENAI_API_KEY"] = api_key
    if base_url:
        os.environ["OPENAI_API_BASE_URL"] = base_url

    # Patch CAMEL to handle our streaming-only API
    patch_camel_for_streaming_api()

    model = ModelFactory.create(
        model_platform=ModelPlatformType.OPENAI,
        model_type=model_name,
    )

    # Available actions
    available_actions = [
        ActionType.CREATE_POST,
        ActionType.LIKE_POST,
        ActionType.REPOST,
        ActionType.CREATE_COMMENT,
        ActionType.FOLLOW,
        ActionType.DO_NOTHING,
    ]

    # Generate agent graph
    print("  📋 Generating agent graph from profiles...")
    from oasis.social_agent.agents_generator import generate_twitter_agent_graph
    agent_graph = await generate_twitter_agent_graph(
        profile_path=PROFILE_PATH,
        model=model,
        available_actions=available_actions,
    )
    print(f"     ✅ {len(list(agent_graph.get_agents()))} agents created")

    # Remove old DB
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    # Create environment
    print("  🌐 Creating Twitter environment...")
    env = oasis.make(
        agent_graph=agent_graph,
        platform=oasis.DefaultPlatformType.TWITTER,
        database_path=DB_PATH,
    )
    await env.reset()
    print("     ✅ Environment ready")
    print()

    # Seed: have alice_dev post something to kick off the simulation
    agents_list = list(agent_graph.get_agents())
    alice = agents_list[0][1]  # (id, agent) tuple

    seed_action = {
        alice: ManualAction(
            action_type=ActionType.CREATE_POST,
            action_args={"content": "Just discovered WorldMind — a multi-agent engine that builds world models and makes verifiable predictions. The architecture is wild: 5 specialized agents debate each other before finalizing any prediction. Open source too. Thoughts? 🧠🌍"}
        )
    }

    print("  📝 Seeding: alice_dev posts about WorldMind...")
    await env.step(seed_action)
    print("     ✅ Seed post created")
    print()

    # Run simulation rounds
    import random
    total_actions = 0

    for round_num in range(1, rounds + 1):
        print(f"  ⏱️  Round {round_num}/{rounds}")

        # Activate 50-80% of agents randomly
        n_active = random.randint(5, 8)
        active = random.sample(agents_list, n_active)
        actions = {agent: LLMAction() for _, agent in active}

        t1 = datetime.now()
        await env.step(actions)
        elapsed = (datetime.now() - t1).total_seconds()

        # Read what happened from DB
        round_actions = read_actions(DB_PATH)
        new_actions = round_actions[total_actions:]
        total_actions = len(round_actions)

        print(f"     {len(new_actions)} actions in {elapsed:.1f}s")
        for a in new_actions[:5]:  # show first 5
            print(f"     • [{a['action']}] agent_{a['user_id']}: {a['info'][:80] if a['info'] else '(no content)'}")
        if len(new_actions) > 5:
            print(f"     ... and {len(new_actions) - 5} more")
        print()

    await env.close()

    # Final summary
    print(f"{'═' * 50}")
    print(f"  📊 Simulation Complete!")
    print(f"     Total actions: {total_actions}")
    print(f"     Rounds: {rounds}")

    # Show posts
    posts = read_posts(DB_PATH)
    print(f"     Posts created: {len(posts)}")
    print()
    for p in posts[:10]:
        print(f"     📄 [{p['user_id']}] {p['content'][:100]}")
        print(f"        ❤️ {p['num_likes']} likes | 💬 {p['num_comments']} comments | 🔄 {p['num_reposts']} reposts")
        print()

    print(f"  💾 DB saved: {DB_PATH}")
    print()


def read_actions(db_path):
    """Read all actions from trace table."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT user_id, action, info, created_at FROM trace ORDER BY id")
        rows = cursor.fetchall()
        return [{"user_id": r[0], "action": r[1], "info": r[2] or "", "created_at": r[3]} for r in rows]
    except:
        return []
    finally:
        conn.close()


def read_posts(db_path):
    """Read all posts."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT user_id, content, num_likes, num_comments, num_reposts, created_at FROM post ORDER BY created_at")
        rows = cursor.fetchall()
        return [{"user_id": r[0], "content": r[1] or "", "num_likes": r[2], "num_comments": r[3], "num_reposts": r[4], "created_at": r[5]} for r in rows]
    except:
        return []
    finally:
        conn.close()


if __name__ == "__main__":
    asyncio.run(main())
