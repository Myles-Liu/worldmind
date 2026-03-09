"""
Memory Injector — patches OASIS SocialAgent to use persistent memory.

Call inject_memory_into_agents(agents, memories_json) before env.step()
to patch each agent's system prompt with their memory summary.
"""

import json
from oasis.social_agent.agent import SocialAgent


# Store original method
_original_perform_action = None


def inject_memory_into_agents(agents_list, memories: dict):
    """
    Patch each agent's system prompt to include their memory.
    
    Args:
        agents_list: list of (agent_id, agent) tuples
        memories: dict of agent_id (str) -> memory summary text
    """
    global _original_perform_action
    
    # Save original method once
    if _original_perform_action is None:
        _original_perform_action = SocialAgent.perform_action_by_llm
    
    # Store memories on each agent instance
    for aid, agent in agents_list:
        memory_text = memories.get(str(aid), '')
        agent._worldmind_memory = memory_text


def patch_agent_prompts():
    """
    Monkey-patch SocialAgent to inject memory into the system prompt.
    Call once at startup.
    """
    global _original_perform_action
    
    if _original_perform_action is not None:
        return  # Already patched
    
    _original_perform_action = SocialAgent.perform_action_by_llm
    
    async def patched_perform_action(self):
        # Inject memory into system_content if available
        memory = getattr(self, '_worldmind_memory', '')
        if memory:
            # Prepend memory to the agent's system message
            original_sys = self.system_message.content if self.system_message else ''
            memory_block = f"\n\n=== YOUR MEMORY ===\n{memory}\n=== END MEMORY ===\n"
            
            # Temporarily modify system message
            if self.system_message:
                self.system_message.content = original_sys + memory_block
            
            try:
                result = await _original_perform_action(self)
            finally:
                # Restore original
                if self.system_message:
                    self.system_message.content = original_sys
            
            return result
        else:
            return await _original_perform_action(self)
    
    SocialAgent.perform_action_by_llm = patched_perform_action
