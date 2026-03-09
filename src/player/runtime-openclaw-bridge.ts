/**
 * OpenClaw Bridge Runtime — CLI ↔ OpenClaw Agent Bridge
 *
 * Instead of calling OpenClaw HTTP API (which may not expose session tools),
 * this runtime communicates with a "bridge process" via stdin/stdout JSON protocol.
 * The bridge process runs inside an OpenClaw agent session and has full access
 * to sessions_spawn / sessions_send tools.
 *
 * Protocol (JSON-lines over stdio):
 *   CLI → Bridge: { "cmd": "spawn", "id": 0, "persona": {...}, "worldContext": "..." }
 *   Bridge → CLI: { "id": 0, "sessionKey": "agent:main:subagent:..." }
 *
 *   CLI → Bridge: { "cmd": "send", "id": 1, "sessionKey": "...", "message": "..." }
 *   Bridge → CLI: { "id": 1, "response": "..." }
 *
 *   CLI → Bridge: { "cmd": "shutdown" }
 *   Bridge → CLI: { "id": -1, "status": "done" }
 *
 * Alternatively, the runtime can use a simple HTTP server that the OpenClaw agent
 * starts and manages. This is the recommended approach for production.
 */

// This file is a placeholder for the bridge approach.
// The actual recommended approach for Plan 3 is:
//
// 1. OpenClaw agent (main session) acts as the orchestrator
// 2. Agent uses sessions_spawn to create sub-sessions for each OASIS agent
// 3. Agent uses sessions_send to communicate with sub-sessions each round
// 4. OASIS engine runs as a child process (same as before)
//
// This means the "orchestrator" IS the OpenClaw agent, not a separate CLI script.
// See scripts/orchestrate.ts for this approach.

export {};
