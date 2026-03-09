/**
 * WorldMind Multiplayer — Public API
 *
 * Import from here for all multiplayer types and classes.
 */

export type {
  Persona,
  FeedItem,
  Notification,
  ActionType,
  Decision,
  WorldState,
  ClientMessage,
  ServerMessage,
  PlatformAdapter,
  NpcRuntime,
} from './types.js';

export { WorldServer, type ServerConfig } from './server.js';
export { WorldClient, type ClientConfig } from './client.js';
export { OasisPlatformAdapter } from './oasis-adapter.js';
