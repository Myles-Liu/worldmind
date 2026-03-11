#!/usr/bin/env python3
"""
WorldMind Interactive Engine — OASIS subprocess.

Protocol:
  - Reads JSON commands from stdin (one per line)
  - Writes JSON responses to stdout (one per line)
  - stderr for logs

Commands:
  {"type": "step", "rounds": 1}           — advance N rounds
  {"type": "player_action", "action": ..., "playerId": N}
  {"type": "inject_post", "agentId": N, "content": "..."}
  {"type": "interview", "agentId": N, "question": "..."}
  {"type": "shutdown"}
"""

import asyncio
import json
import os
import sys
import random
import sqlite3
from datetime import datetime

# Add project root to path for imports
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, 'src', 'player'))

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def log(msg: str):
    print(msg, file=sys.stderr, flush=True)


def emit(data: dict):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def load_env():
    env_path = os.path.join(PROJECT_ROOT, ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    os.environ.setdefault(k.strip(), v.strip())


# ─── Streaming API Patch ────────────────────────────────────────

def patch_camel_for_streaming_api():
    """Patch CAMEL to handle APIs that always return SSE streams."""
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

        content_parts = []
        tool_calls_map = {}
        finish_reason = None
        model_name = self.model_type
        comp_id = ""
        usage_info = None

        async for chunk in stream:
            if chunk.id: comp_id = chunk.id
            if chunk.model: model_name = chunk.model
            if chunk.usage: usage_info = chunk.usage
            for choice in (chunk.choices or []):
                delta = choice.delta
                if delta.content: content_parts.append(delta.content)
                if choice.finish_reason: finish_reason = choice.finish_reason
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in tool_calls_map:
                            tool_calls_map[idx] = {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
                        if tc.id: tool_calls_map[idx]["id"] = tc.id
                        if tc.function:
                            if tc.function.name: tool_calls_map[idx]["function"]["name"] = tc.function.name
                            if tc.function.arguments: tool_calls_map[idx]["function"]["arguments"] += tc.function.arguments

        tc_list = None
        if tool_calls_map:
            tc_list = [tool_calls_map[i] for i in sorted(tool_calls_map)]

        from openai.types.chat import ChatCompletion, ChatCompletionMessage
        from openai.types.chat.chat_completion import Choice
        from openai.types.completion_usage import CompletionUsage

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
        return ChatCompletion.model_construct(
            id=comp_id or "chatcmpl-patched",
            choices=[Choice.model_construct(finish_reason=finish_reason or "stop", index=0, message=msg)],
            created=int(__import__('time').time()),
            model=model_name,
            object="chat.completion",
            usage=usage,
        )

    OpenAIModel._arequest_chat_completion = _patched
    log("[engine] Patched CAMEL for streaming API")


def patch_oasis_step_resilience():
    """Patch OasisEnv.step to use return_exceptions=True so one agent error doesn't kill the whole round."""
    from oasis.environment.env import OasisEnv

    _original_step = OasisEnv.step

    async def _resilient_step(self, actions):
        try:
            return await _original_step(self, actions)
        except Exception as e:
            log(f"[engine] Step failed with gather error, retrying with individual agents: {e}")
            # Fallback: run each agent individually
            for agent, action in actions.items():
                try:
                    if hasattr(action, 'action_type'):
                        await agent.perform_action_by_data(action.action_type, **action.action_args)
                    else:
                        async with self.llm_semaphore:
                            await agent.perform_action_by_llm()
                except Exception as agent_err:
                    log(f"[engine] Agent {getattr(agent, 'agent_id', '?')} error (skipped): {agent_err}")

    OasisEnv.step = _resilient_step
    log("[engine] Patched OASIS step for resilience")


# ─── Main ────────────────────────────────────────────────────────

async def main():
    load_env()

    platform = os.environ.get('WORLDMIND_PLATFORM', 'twitter')
    profile_path = os.environ.get('WORLDMIND_PROFILE_PATH', '')
    db_path = os.environ.get('WORLDMIND_DB_PATH', './data/social/world.db')
    agent_count = int(os.environ.get('WORLDMIND_AGENT_COUNT', '10'))
    model_name = os.environ.get('WORLDMIND_LLM_MODEL',
                                os.environ.get('WORLDMIND_LLM_MODEL', 'gpt-4o-mini'))
    player_username = os.environ.get('WORLDMIND_PLAYER_USERNAME', '')

    api_key = os.environ.get('OPENAI_API_KEY',
                             os.environ.get('WORLDMIND_LLM_API_KEY', ''))
    base_url = os.environ.get('OPENAI_API_BASE_URL',
                              os.environ.get('WORLDMIND_LLM_BASE_URL', ''))

    if not api_key:
        emit({"type": "error", "message": "No API key"})
        sys.exit(1)

    os.environ["OPENAI_API_KEY"] = api_key
    if base_url:
        os.environ["OPENAI_API_BASE_URL"] = base_url

    # Patch for streaming-only API
    patch_camel_for_streaming_api()
    patch_oasis_step_resilience()

    from camel.models import ModelFactory
    from camel.types import ModelPlatformType
    import oasis
    from oasis import ActionType, LLMAction, ManualAction

    model = ModelFactory.create(
        model_platform=ModelPlatformType.OPENAI,
        model_type=model_name,
    )

    available_actions = [
        ActionType.CREATE_POST,
        ActionType.LIKE_POST,
        ActionType.REPOST,
        ActionType.QUOTE_POST,
        ActionType.CREATE_COMMENT,
        ActionType.FOLLOW,
        ActionType.UNFOLLOW,
        ActionType.CREATE_GROUP,
        ActionType.JOIN_GROUP,
        ActionType.LEAVE_GROUP,
        ActionType.SEND_TO_GROUP,
        ActionType.LISTEN_FROM_GROUP,
        ActionType.DO_NOTHING,
    ]

    log(f"[engine] Generating agent graph ({profile_path})...")
    from oasis.social_agent.agents_generator import generate_twitter_agent_graph
    agent_graph = await generate_twitter_agent_graph(
        profile_path=profile_path,
        model=model,
        available_actions=available_actions,
    )

    agents_list = list(agent_graph.get_agents())
    log(f"[engine] {len(agents_list)} agents created")

    # Fix field mapping: OASIS generate_twitter_agent_graph reads CSV as:
    #   CSV "username" → UserInfo.name (WRONG: should be user_name)
    #   CSV "name"     → (not read by OASIS)
    # We need:
    #   UserInfo.user_name = CSV username (handle: @thor)
    #   UserInfo.name      = CSV name     (display: 雷神索尔)
    #
    # Since OASIS puts CSV "username" into UserInfo.name, we:
    #   1. Copy name → user_name (that's the handle)
    #   2. Read CSV "name" column and set it as the display name
    import csv as _csv
    display_names = {}
    try:
        with open(profile_path) as f:
            reader = _csv.DictReader(f)
            for i, row in enumerate(reader):
                if "name" in row:
                    display_names[i] = row["name"]
    except Exception as e:
        log(f"[engine] Warning: could not read display names from CSV: {e}")

    for agent_id, agent in agents_list:
        ui = agent.user_info
        if ui:
            # user_name = handle (@thor), currently in ui.name from OASIS
            if not ui.user_name and ui.name:
                ui.user_name = ui.name
            # name = display name (雷神索尔), from CSV "name" column
            if agent_id in display_names:
                ui.name = display_names[agent_id]

    # Inject world-level context (language, culture, directives) into system prompt
    world_context = os.environ.get('WORLDMIND_WORLD_CONTEXT', '')
    if world_context:
        log(f"[engine] Injecting world context into {len(agents_list)} agent system prompts")
        for _, agent in agents_list:
            original = agent.system_message.content
            agent.system_message.content = f"{world_context}\n\n{original}"

    # Find player agent
    player_id = None
    if player_username:
        for aid, agent in agents_list:
            ui = getattr(agent, 'user_info', None)
            uname = getattr(ui, 'user_name', None) if ui else None
            if uname == player_username:
                player_id = aid
                break
        if player_id is None:
            # Player is the last agent (appended to CSV)
            player_id = agents_list[-1][0]
    log(f"[engine] Player ID: {player_id}")

    # Remove old DB
    if os.path.exists(db_path):
        os.remove(db_path)

    log("[engine] Creating environment...")
    # Create custom Platform with tuned parameters:
    #  - recsys_type="twitter" (cosine similarity on bio, better than random)
    #  - refresh_rec_post_count=5 (more posts recommended per refresh)
    #  - max_rec_post_len=5 (each agent sees up to 5 recommended posts)
    #  - following_post_count=5 (see more posts from followed users)
    from oasis.social_platform.channel import Channel as OasisChannel
    from oasis.social_platform.platform import Platform as OasisPlatform
    custom_channel = OasisChannel()
    custom_platform = OasisPlatform(
        db_path=db_path,
        channel=custom_channel,
        recsys_type="twitter",
        refresh_rec_post_count=5,
        max_rec_post_len=5,
        following_post_count=5,
    )
    env = oasis.make(
        agent_graph=agent_graph,
        platform=custom_platform,
        database_path=db_path,
    )
    await env.reset()
    log("[engine] Environment ready")

    # Seed initial follow relationships — everyone follows everyone (small communities)
    # This ensures agents see each other's posts via following_post_count
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        agent_ids = [aid for aid, _ in agents_list]
        count = 0
        for follower in agent_ids:
            for followee in agent_ids:
                if follower != followee:
                    cursor.execute(
                        "INSERT OR IGNORE INTO follow (follower_id, followee_id, created_at) VALUES (?, ?, 0)",
                        (follower, followee)
                    )
                    # Update follower/following counts
                    count += 1
        # Update user stats
        for aid in agent_ids:
            cursor.execute(
                "UPDATE user SET num_followers = (SELECT COUNT(*) FROM follow WHERE followee_id = ?), "
                "num_followings = (SELECT COUNT(*) FROM follow WHERE follower_id = ?) WHERE user_id = ?",
                (aid, aid, aid)
            )
        conn.commit()
        conn.close()
        log(f"[engine] Seeded {count} initial follow relationships")
    except Exception as e:
        log(f"[engine] Failed to seed follows: {e}")

    # Emit ready
    emit({"type": "ready", "player_id": player_id, "agents": len(agents_list)})

    # ─── Command loop ────────────────────────────────────────

    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_event_loop().connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=3600)
            if not line:
                break
            cmd = json.loads(line.decode().strip())
        except asyncio.TimeoutError:
            continue
        except (json.JSONDecodeError, Exception) as e:
            emit({"type": "error", "message": str(e)})
            continue

        cmd_type = cmd.get("type", "")
        log(f"[engine] Command: {cmd_type}")

        if cmd_type == "shutdown":
            emit({"type": "shutdown_ack"})
            break

        elif cmd_type == "step":
            rounds = cmd.get("rounds", 1)
            for _ in range(rounds):
                # Activate random agents (not the player)
                n_active = random.randint(
                    max(1, len(agents_list) // 3),
                    max(2, len(agents_list) * 2 // 3),
                )
                non_player = [(aid, ag) for aid, ag in agents_list if aid != player_id]
                active = random.sample(non_player, min(n_active, len(non_player)))
                actions = {agent: LLMAction() for _, agent in active}

                try:
                    await env.step(actions)
                except Exception as e:
                    log(f"[engine] Step error (non-fatal, continuing): {e}")

            emit({"type": "step_done", "rounds": rounds})

        elif cmd_type in ("player_action", "player_action_and_step"):
            action = cmd.get("action", {})
            pid = cmd.get("playerId", player_id)
            if pid is None:
                emit({"type": "error", "message": "No player ID"})
                continue

            player_agent = None
            for aid, ag in agents_list:
                if aid == pid:
                    player_agent = ag
                    break

            if not player_agent:
                emit({"type": "error", "message": f"Player agent {pid} not found"})
                continue

            atype = action.get("type", "")
            try:
                # Execute player action
                if atype == "post":
                    step_actions = {
                        player_agent: ManualAction(
                            action_type=ActionType.CREATE_POST,
                            action_args={"content": action["content"]},
                        )
                    }
                    await env.step(step_actions)
                elif atype == "like":
                    step_actions = {
                        player_agent: ManualAction(
                            action_type=ActionType.LIKE_POST,
                            action_args={"post_id": action["postId"]},
                        )
                    }
                    await env.step(step_actions)
                elif atype == "comment":
                    step_actions = {
                        player_agent: ManualAction(
                            action_type=ActionType.CREATE_COMMENT,
                            action_args={
                                "post_id": action["postId"],
                                "content": action["content"],
                            },
                        )
                    }
                    await env.step(step_actions)
                elif atype == "follow":
                    step_actions = {
                        player_agent: ManualAction(
                            action_type=ActionType.FOLLOW,
                            action_args={"followee_id": action["userId"]},
                        )
                    }
                    await env.step(step_actions)
                else:
                    log(f"[engine] Unknown player action: {atype}")

                # If combined command, also let agents react
                if cmd_type == "player_action_and_step":
                    n_active = random.randint(
                        max(1, len(agents_list) // 3),
                        max(2, len(agents_list) * 2 // 3),
                    )
                    non_player = [(aid, ag) for aid, ag in agents_list if aid != pid]
                    active = random.sample(non_player, min(n_active, len(non_player)))
                    actions = {agent: LLMAction() for _, agent in active}
                    try:
                        await env.step(actions)
                    except Exception as e:
                        log(f"[engine] Agent step error: {e}")

                emit({"type": "player_action_done", "action": atype})
            except Exception as e:
                emit({"type": "error", "message": f"Player action failed: {e}"})

        elif cmd_type == "inject_post":
            agent_id = cmd.get("agentId", 0)
            content = cmd.get("content", "")
            target_agent = None
            for aid, ag in agents_list:
                if aid == agent_id:
                    target_agent = ag
                    break
            if target_agent:
                try:
                    step_actions = {
                        target_agent: ManualAction(
                            action_type=ActionType.CREATE_POST,
                            action_args={"content": content},
                        )
                    }
                    await env.step(step_actions)
                    emit({"type": "inject_done", "agentId": agent_id})
                except Exception as e:
                    emit({"type": "error", "message": f"Inject failed: {e}"})
            else:
                emit({"type": "error", "message": f"Agent {agent_id} not found"})

        elif cmd_type == "directed_step":
            # AgentDirector mode: receive pre-decided actions from TypeScript
            decisions = cmd.get("decisions", [])
            step_actions = {}
            skipped = 0
            for d in decisions:
                action_type = d.get("action", "do_nothing")
                if action_type == "do_nothing":
                    skipped += 1
                    continue
                agent_id = d.get("agentId")
                target_agent = None
                for aid, ag in agents_list:
                    if aid == agent_id:
                        target_agent = ag
                        break
                if not target_agent:
                    log(f"[engine] directed_step: agent {agent_id} not found, skipping")
                    continue
                try:
                    if action_type == "post":
                        step_actions[target_agent] = ManualAction(
                            action_type=ActionType.CREATE_POST,
                            action_args={"content": d.get("content", "")},
                        )
                    elif action_type == "comment":
                        step_actions[target_agent] = ManualAction(
                            action_type=ActionType.CREATE_COMMENT,
                            action_args={
                                "post_id": d.get("targetPostId", 1),
                                "content": d.get("content", ""),
                            },
                        )
                    elif action_type == "like":
                        step_actions[target_agent] = ManualAction(
                            action_type=ActionType.LIKE_POST,
                            action_args={"post_id": d.get("targetPostId", 1)},
                        )
                    elif action_type == "follow":
                        step_actions[target_agent] = ManualAction(
                            action_type=ActionType.FOLLOW,
                            action_args={"followee_id": d.get("targetUserId", 0)},
                        )
                    elif action_type == "repost":
                        step_actions[target_agent] = ManualAction(
                            action_type=ActionType.REPOST,
                            action_args={"post_id": d.get("targetPostId", 1)},
                        )
                    elif action_type == "quote":
                        step_actions[target_agent] = ManualAction(
                            action_type=ActionType.QUOTE_POST,
                            action_args={
                                "post_id": d.get("targetPostId", 1),
                                "content": d.get("content", ""),
                            },
                        )
                    elif action_type == "create_group":
                        step_actions[target_agent] = ManualAction(
                            action_type=ActionType.CREATE_GROUP,
                            action_args={"group_name": d.get("groupName", "group")},
                        )
                    elif action_type == "join_group":
                        step_actions[target_agent] = ManualAction(
                            action_type=ActionType.JOIN_GROUP,
                            action_args={"group_id": d.get("groupId", 1)},
                        )
                    elif action_type == "leave_group":
                        step_actions[target_agent] = ManualAction(
                            action_type=ActionType.LEAVE_GROUP,
                            action_args={"group_id": d.get("groupId", 1)},
                        )
                    elif action_type == "send_to_group":
                        step_actions[target_agent] = ManualAction(
                            action_type=ActionType.SEND_TO_GROUP,
                            action_args={
                                "group_id": d.get("groupId", 1),
                                "content": d.get("content", ""),
                            },
                        )
                    else:
                        log(f"[engine] directed_step: unknown action {action_type}")
                except Exception as e:
                    log(f"[engine] directed_step: error building action for agent {agent_id}: {e}")

            if step_actions:
                try:
                    await env.step(step_actions)
                except Exception as e:
                    log(f"[engine] directed_step error: {e}")

            log(f"[engine] directed_step: {len(step_actions)} actions executed, {skipped} skipped")
            emit({"type": "directed_step_done", "executed": len(step_actions), "skipped": skipped})

        elif cmd_type == "query_feed":
            # Query agent's feed from DB for director mode
            agent_id = cmd.get("agentId", 0)
            limit = cmd.get("limit", 10)
            try:
                conn = sqlite3.connect(db_path)
                conn.row_factory = sqlite3.Row
                cursor = conn.execute(
                    """SELECT p.post_id, p.user_id, p.content, p.num_likes, p.created_at,
                              p.num_reposts,
                              COALESCE(NULLIF(u.name, ''), u.user_name, 'agent_' || u.user_id) as author_name,
                              (SELECT COUNT(*) FROM comment c WHERE c.post_id = p.post_id) as num_comments
                       FROM post p
                       JOIN user u ON p.user_id = u.user_id
                       ORDER BY p.created_at DESC
                       LIMIT ?""",
                    (limit,),
                )
                feed = []
                for row in cursor.fetchall():
                    item = dict(row)
                    # Fetch comments for this post
                    comments_cursor = conn.execute(
                        """SELECT c.comment_id, c.user_id as commenter_id, c.content, c.created_at,
                                  COALESCE(NULLIF(u2.name, ''), u2.user_name, 'agent_' || u2.user_id) as author_name
                           FROM comment c
                           JOIN user u2 ON c.user_id = u2.user_id
                           WHERE c.post_id = ?
                           ORDER BY c.created_at ASC
                           LIMIT 10""",
                        (item["post_id"],),
                    )
                    item["commentList"] = [dict(c) for c in comments_cursor.fetchall()]
                    feed.append(item)
                conn.close()
                emit({"type": "feed_result", "agentId": agent_id, "feed": feed})
            except Exception as e:
                emit({"type": "error", "message": f"query_feed failed: {e}"})

        elif cmd_type == "query_notifications":
            # Query notifications for an agent
            agent_id = cmd.get("agentId", 0)
            limit = cmd.get("limit", 10)
            try:
                conn = sqlite3.connect(db_path)
                conn.row_factory = sqlite3.Row
                notifs = []
                # Recent comments on agent's posts
                cursor = conn.execute(
                    """SELECT 'comment' as type, COALESCE(NULLIF(u.name, ''), u.user_name, 'agent_' || u.user_id) as from_agent, c.content
                       FROM comment c
                       JOIN post p ON c.post_id = p.post_id
                       JOIN user u ON c.user_id = u.user_id
                       WHERE p.user_id = ? AND c.user_id != ?
                       ORDER BY c.created_at DESC LIMIT ?""",
                    (agent_id, agent_id, limit),
                )
                notifs.extend([dict(row) for row in cursor.fetchall()])
                # Recent follows
                cursor = conn.execute(
                    """SELECT 'follow' as type, COALESCE(NULLIF(u.name, ''), u.user_name, 'agent_' || u.user_id) as from_agent, '' as content
                       FROM follow f
                       JOIN user u ON f.follower_id = u.user_id
                       WHERE f.followee_id = ?
                       ORDER BY f.created_at DESC LIMIT ?""",
                    (agent_id, limit),
                )
                notifs.extend([dict(row) for row in cursor.fetchall()])
                conn.close()
                emit({"type": "notifications_result", "agentId": agent_id, "notifications": notifs})
            except Exception as e:
                emit({"type": "error", "message": f"query_notifications failed: {e}"})

        elif cmd_type == "query_groups":
            # List all groups and agent's membership
            agent_id = cmd.get("agentId", 0)
            try:
                conn = sqlite3.connect(db_path)
                conn.row_factory = sqlite3.Row
                # All groups
                cursor = conn.execute("SELECT group_id, name FROM chat_group")
                all_groups = [{"groupId": row["group_id"], "name": row["name"]} for row in cursor.fetchall()]
                # Agent's memberships
                cursor = conn.execute(
                    "SELECT group_id FROM group_members WHERE agent_id = ?", (agent_id,)
                )
                joined_ids = [row["group_id"] for row in cursor.fetchall()]
                conn.close()
                emit({"type": "groups_result", "agentId": agent_id, "groups": all_groups, "joined": joined_ids})
            except Exception as e:
                emit({"type": "error", "message": f"query_groups failed: {e}"})

        elif cmd_type == "query_group_messages":
            # Get messages from a specific group
            group_id = cmd.get("groupId", 1)
            limit = cmd.get("limit", 20)
            try:
                conn = sqlite3.connect(db_path)
                conn.row_factory = sqlite3.Row
                cursor = conn.execute(
                    """SELECT m.message_id, m.sender_id, m.content, m.sent_at,
                              COALESCE(NULLIF(u.name, ''), u.user_name, 'agent_' || u.user_id) as sender_name
                       FROM group_messages m
                       JOIN user u ON m.sender_id = u.user_id
                       WHERE m.group_id = ?
                       ORDER BY m.sent_at DESC LIMIT ?""",
                    (group_id, limit),
                )
                messages = [dict(row) for row in cursor.fetchall()]
                conn.close()
                emit({"type": "group_messages_result", "groupId": group_id, "messages": messages})
            except Exception as e:
                emit({"type": "error", "message": f"query_group_messages failed: {e}"})

        elif cmd_type == "update_agent_name":
            # Update user_name and name in DB for a specific agent
            agent_id = cmd.get("agentId", 0)
            user_name = cmd.get("userName", "")
            display_name = cmd.get("displayName", "")
            try:
                conn = sqlite3.connect(db_path)
                conn.execute(
                    "UPDATE user SET user_name = ?, name = ? WHERE user_id = ?",
                    (user_name, display_name, agent_id)
                )
                conn.commit()
                conn.close()
                emit({"type": "agent_name_updated", "agentId": agent_id})
            except Exception as e:
                emit({"type": "error", "message": f"update_agent_name failed: {e}"})

        elif cmd_type == "export_state":
            # Export social graph state for migration
            export_path = cmd.get("path", db_path + ".export.json")
            try:
                conn = sqlite3.connect(db_path)
                conn.row_factory = sqlite3.Row
                export_data = {
                    "exported_at": datetime.now().isoformat(),
                    "db_path": db_path,
                    "tables": {}
                }
                # Export all relevant tables
                for table in ["user", "post", "comment", "like", "follow", "chat_group", "group_members", "group_messages"]:
                    try:
                        cursor = conn.execute(f"SELECT * FROM {table}")
                        export_data["tables"][table] = [dict(row) for row in cursor.fetchall()]
                    except Exception as e:
                        log(f"[engine] export_state: skipping {table}: {e}")
                conn.close()
                with open(export_path, "w") as f:
                    json.dump(export_data, f, ensure_ascii=False, indent=2, default=str)
                emit({"type": "export_done", "path": export_path, "tables": list(export_data["tables"].keys())})
            except Exception as e:
                emit({"type": "error", "message": f"export_state failed: {e}"})

        elif cmd_type == "import_state":
            # Import social graph from a previous export (posts, comments, likes, follows)
            # User table is NOT imported — agents are re-created from CSV
            import_path = cmd.get("path")
            if not import_path or not os.path.exists(import_path):
                emit({"type": "error", "message": f"import file not found: {import_path}"})
                continue
            try:
                with open(import_path) as f:
                    import_data = json.load(f)
                conn = sqlite3.connect(db_path)
                cursor = conn.cursor()
                imported = {}
                # Import posts (skip if post_id already exists)
                if "post" in import_data.get("tables", {}):
                    count = 0
                    for row in import_data["tables"]["post"]:
                        try:
                            cursor.execute(
                                "INSERT OR IGNORE INTO post (post_id, user_id, content, num_likes, num_shares, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                                (row.get("post_id"), row.get("user_id"), row.get("content"), row.get("num_likes", 0), row.get("num_shares", 0), row.get("created_at"))
                            )
                            count += cursor.rowcount
                        except: pass
                    imported["post"] = count
                # Import comments
                if "comment" in import_data.get("tables", {}):
                    count = 0
                    for row in import_data["tables"]["comment"]:
                        try:
                            cursor.execute(
                                "INSERT OR IGNORE INTO comment (comment_id, post_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
                                (row.get("comment_id"), row.get("post_id"), row.get("user_id"), row.get("content"), row.get("created_at"))
                            )
                            count += cursor.rowcount
                        except: pass
                    imported["comment"] = count
                # Import likes
                if "like" in import_data.get("tables", {}):
                    count = 0
                    for row in import_data["tables"]["like"]:
                        try:
                            cursor.execute(
                                "INSERT OR IGNORE INTO `like` (user_id, post_id, created_at) VALUES (?, ?, ?)",
                                (row.get("user_id"), row.get("post_id"), row.get("created_at"))
                            )
                            count += cursor.rowcount
                        except: pass
                    imported["like"] = count
                # Import follows
                if "follow" in import_data.get("tables", {}):
                    count = 0
                    for row in import_data["tables"]["follow"]:
                        try:
                            cursor.execute(
                                "INSERT OR IGNORE INTO follow (follower_id, followee_id, created_at) VALUES (?, ?, ?)",
                                (row.get("follower_id"), row.get("followee_id"), row.get("created_at"))
                            )
                            count += cursor.rowcount
                        except: pass
                    imported["follow"] = count
                # Import groups
                if "chat_group" in import_data.get("tables", {}):
                    count = 0
                    for row in import_data["tables"]["chat_group"]:
                        try:
                            cursor.execute(
                                "INSERT OR IGNORE INTO chat_group (group_id, name, created_at) VALUES (?, ?, ?)",
                                (row.get("group_id"), row.get("name"), row.get("created_at"))
                            )
                            count += cursor.rowcount
                        except: pass
                    imported["chat_group"] = count
                # Import group members
                if "group_members" in import_data.get("tables", {}):
                    count = 0
                    for row in import_data["tables"]["group_members"]:
                        try:
                            cursor.execute(
                                "INSERT OR IGNORE INTO group_members (group_id, agent_id, joined_at) VALUES (?, ?, ?)",
                                (row.get("group_id"), row.get("agent_id"), row.get("joined_at"))
                            )
                            count += cursor.rowcount
                        except: pass
                    imported["group_members"] = count
                # Import group messages
                if "group_messages" in import_data.get("tables", {}):
                    count = 0
                    for row in import_data["tables"]["group_messages"]:
                        try:
                            cursor.execute(
                                "INSERT OR IGNORE INTO group_messages (message_id, group_id, sender_id, content, sent_at) VALUES (?, ?, ?, ?, ?)",
                                (row.get("message_id"), row.get("group_id"), row.get("sender_id"), row.get("content"), row.get("sent_at"))
                            )
                            count += cursor.rowcount
                        except: pass
                    imported["group_messages"] = count
                conn.commit()
                conn.close()
                emit({"type": "import_done", "path": import_path, "imported": imported})
            except Exception as e:
                emit({"type": "error", "message": f"import_state failed: {e}"})

        elif cmd_type == "interview":
            # Interview: ask an agent a question
            agent_id = cmd.get("agentId", 0)
            question = cmd.get("question", "What do you think?")
            target_agent = None
            for aid, ag in agents_list:
                if aid == agent_id:
                    target_agent = ag
                    break
            if target_agent:
                try:
                    # Use CREATE_COMMENT as interview (agent responds to a prompt)
                    # Better: use agent's internal LLM to answer directly
                    response = await target_agent.astep(
                        f"Someone asks you: {question}\nRespond in character."
                    )
                    answer = response.msg.content if response.msg else "..."
                    emit({"type": "interview_response", "agentId": agent_id, "answer": answer})
                except Exception as e:
                    emit({"type": "error", "message": f"Interview failed: {e}"})
            else:
                emit({"type": "error", "message": f"Agent {agent_id} not found"})

        else:
            emit({"type": "error", "message": f"Unknown command: {cmd_type}"})

    await env.close()
    log("[engine] Shutdown complete")


if __name__ == "__main__":
    asyncio.run(main())
