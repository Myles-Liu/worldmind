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
        ActionType.CREATE_COMMENT,
        ActionType.FOLLOW,
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
    env = oasis.make(
        agent_graph=agent_graph,
        platform=oasis.DefaultPlatformType.TWITTER,
        database_path=db_path,
    )
    await env.reset()
    log("[engine] Environment ready")

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
                    log(f"[engine] Step error: {e}")

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
