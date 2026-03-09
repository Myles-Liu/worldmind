#!/usr/bin/env python3
"""
OASIS Bridge Runner — subprocess that runs OASIS simulation
and streams events as JSON lines to stdout.

Protocol: each line on stdout is a JSON object with a "type" field.
Types: "action", "round_end", "simulation_end", "error"

Env vars:
  OASIS_PLATFORM         twitter | reddit
  OASIS_PROFILE_PATH     path to profiles (CSV for twitter, JSON for reddit)
  OASIS_DB_PATH          path for SQLite DB
  OASIS_ROUNDS           number of rounds
  OASIS_MINUTES_PER_ROUND  simulated minutes per round
  OASIS_SEMAPHORE        max concurrent LLM requests
  OASIS_LLM_MODEL        LLM model name (default: gpt-4o-mini)
  OPENAI_API_KEY         LLM API key
  OPENAI_API_BASE_URL    LLM base URL (optional)
"""

import asyncio
import json
import os
import sys
import random
import sqlite3
from datetime import datetime

# Suppress HF warnings
os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')


def emit(event: dict):
    """Emit a JSON event to stdout."""
    print(json.dumps(event, ensure_ascii=False), flush=True)


def emit_error(msg: str):
    emit({"type": "error", "message": msg, "timestamp": datetime.now().isoformat()})


async def run_simulation():
    try:
        from camel.models import ModelFactory
        from camel.types import ModelPlatformType
        import oasis
        from oasis import ActionType, LLMAction
    except ImportError as e:
        emit_error(f"Missing dependency: {e}. Install: pip install camel-oasis camel-ai")
        sys.exit(1)

    # Read config from env
    platform = os.environ.get('OASIS_PLATFORM', 'twitter')
    profile_path = os.environ.get('OASIS_PROFILE_PATH', '')
    db_path = os.environ.get('OASIS_DB_PATH', './oasis_sim.db')
    rounds = int(os.environ.get('OASIS_ROUNDS', '10'))
    minutes_per_round = int(os.environ.get('OASIS_MINUTES_PER_ROUND', '30'))
    semaphore = int(os.environ.get('OASIS_SEMAPHORE', '10'))
    llm_model = os.environ.get('OASIS_LLM_MODEL', 'gpt-4o-mini')

    if not profile_path or not os.path.exists(profile_path):
        emit_error(f"Profile path not found: {profile_path}")
        sys.exit(1)

    # Create LLM model
    model = ModelFactory.create(
        model_platform=ModelPlatformType.OPENAI,
        model_type=llm_model,
    )

    # Generate agent graph
    if platform == 'twitter':
        from oasis import generate_twitter_agent_graph
        available_actions = [
            ActionType.CREATE_POST,
            ActionType.LIKE_POST,
            ActionType.REPOST,
            ActionType.FOLLOW,
            ActionType.DO_NOTHING,
            ActionType.QUOTE_POST,
        ]
        agent_graph = await generate_twitter_agent_graph(
            profile_path=profile_path,
            model=model,
            available_actions=available_actions,
        )
        platform_type = oasis.DefaultPlatformType.TWITTER
    else:
        from oasis import generate_reddit_agent_graph
        available_actions = [
            ActionType.CREATE_POST,
            ActionType.LIKE_POST,
            ActionType.DISLIKE_POST,
            ActionType.CREATE_COMMENT,
            ActionType.DO_NOTHING,
        ]
        agent_graph = await generate_reddit_agent_graph(
            profile_path=profile_path,
            model=model,
            available_actions=available_actions,
        )
        platform_type = oasis.DefaultPlatformType.REDDIT

    # Remove old DB if exists
    if os.path.exists(db_path):
        os.remove(db_path)

    # Create environment
    env = oasis.make(
        agent_graph=agent_graph,
        platform=platform_type,
        database_path=db_path,
        semaphore=semaphore,
    )
    await env.reset()

    emit({
        "type": "init",
        "platform": platform,
        "agent_count": len(list(agent_graph.get_agents())),
        "total_rounds": rounds,
        "timestamp": datetime.now().isoformat(),
    })

    # Run simulation rounds
    total_actions = 0
    for round_num in range(1, rounds + 1):
        current_hour = (round_num * minutes_per_round // 60) % 24

        # Activate agents based on time of day
        all_agents = list(agent_graph.get_agents())
        # Peak hours: more agents active
        if 9 <= current_hour <= 22:
            activation_rate = random.uniform(0.3, 0.7)
        else:
            activation_rate = random.uniform(0.05, 0.2)

        active = random.sample(
            all_agents,
            min(int(len(all_agents) * activation_rate), len(all_agents))
        )

        actions = {agent: LLMAction() for _, agent in active}

        try:
            await env.step(actions)
        except Exception as e:
            emit_error(f"Round {round_num} step error: {e}")
            continue

        # Read actions from DB
        round_actions = read_round_actions(db_path, round_num, platform)
        for action in round_actions:
            emit(action)
            total_actions += 1

        emit({
            "type": "round_end",
            "round": round_num,
            "total_rounds": rounds,
            "simulated_hour": current_hour,
            "actions_this_round": len(round_actions),
            "total_actions": total_actions,
            "timestamp": datetime.now().isoformat(),
        })

    await env.close()

    emit({
        "type": "simulation_end",
        "total_rounds": rounds,
        "total_actions": total_actions,
        "timestamp": datetime.now().isoformat(),
    })


def read_round_actions(db_path: str, round_num: int, platform: str) -> list:
    """Read the latest actions from OASIS SQLite DB."""
    actions = []
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        # OASIS stores actions in the 'trace' table
        cursor.execute("""
            SELECT user_id, action, info, created_at
            FROM trace
            ORDER BY created_at DESC
            LIMIT 50
        """)

        for row in cursor.fetchall():
            user_id, action_type, info_json, created_at = row
            try:
                info = json.loads(info_json) if info_json else {}
            except json.JSONDecodeError:
                info = {}

            actions.append({
                "type": "action",
                "round": round_num,
                "agent_id": user_id,
                "agent_name": f"agent_{user_id}",
                "action_type": action_type,
                "content": info.get("content", info.get("post", "")),
                "target_id": info.get("target_id"),
                "platform": platform,
                "timestamp": created_at or datetime.now().isoformat(),
            })

        conn.close()
    except Exception as e:
        emit_error(f"DB read error: {e}")

    return actions


if __name__ == '__main__':
    asyncio.run(run_simulation())
