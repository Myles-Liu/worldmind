/**
 * WorldMind LAN Discovery
 *
 * Server side: GET /api/discover returns server metadata.
 * Client side: scanForServers() probes the local subnet for WorldMind instances.
 *
 * Designed for K8s pod-to-pod networking where all pods share a subnet.
 */

import { createConnection } from 'net';
import http from 'http';
import os from 'os';
import type { IncomingMessage, ServerResponse } from 'http';

// ─── Server: Discovery Endpoint ─────────────────────────────────

export interface DiscoveryInfo {
  name: string;          // world name
  host: string;          // this server's IP
  port: number;
  round: number;
  players: number;
  maxPlayers: number;
  npcs: number;
  uptime: number;        // seconds
  version: string;
}

export interface DiscoveryConfig {
  worldName: string;
  port: number;
  getNpcs: () => number;
  getPlayers: () => number;
  getMaxPlayers: () => number;
  getRound: () => number;
}

/**
 * Handle GET /api/discover — returns server info for LAN scanning.
 */
export function handleDiscover(
  _req: IncomingMessage,
  res: ServerResponse,
  config: DiscoveryConfig,
  startTime: number,
): void {
  const info: DiscoveryInfo = {
    name: config.worldName,
    host: getLocalIP(),
    port: config.port,
    round: config.getRound(),
    players: config.getPlayers(),
    maxPlayers: config.getMaxPlayers(),
    npcs: config.getNpcs(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: '1.0.0',
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(info));
}

// ─── Client: Subnet Scanner ────────────────────────────────────

export interface ScanOptions {
  /** Target port (default 3000) */
  port?: number;
  /** Subnet base, e.g. "33.229.115" */
  subnet?: string;
  /** IP range start (default 1) */
  rangeStart?: number;
  /** IP range end (default 254) */
  rangeEnd?: number;
  /** Per-probe timeout in ms (default 500) */
  timeout?: number;
  /** Max concurrent probes (default 50) */
  concurrency?: number;
  /** Log callback */
  onLog?: (msg: string) => void;
}

export interface DiscoveredServer {
  ip: string;
  port: number;
  info: DiscoveryInfo;
}

/**
 * Scan the local subnet for WorldMind servers.
 * 1. TCP probe port on each IP (fast, parallel)
 * 2. HTTP GET /api/discover on open ports
 */
export async function scanForServers(opts: ScanOptions = {}): Promise<DiscoveredServer[]> {
  const port = opts.port ?? 3000;
  const subnet = opts.subnet ?? detectSubnet();
  const start = opts.rangeStart ?? 1;
  const end = opts.rangeEnd ?? 254;
  const timeout = opts.timeout ?? 500;
  const concurrency = opts.concurrency ?? 50;
  const log = opts.onLog ?? (() => {});

  log(`Scanning ${subnet}.${start}-${end}:${port}...`);

  // Phase 1: TCP probe to find open ports
  const openIPs: string[] = [];
  const ips = Array.from({ length: end - start + 1 }, (_, i) => `${subnet}.${start + i}`);

  // Process in chunks
  for (let i = 0; i < ips.length; i += concurrency) {
    const chunk = ips.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map(ip => tcpProbe(ip, port, timeout)));
    for (let j = 0; j < chunk.length; j++) {
      if (results[j]) openIPs.push(chunk[j]!);
    }
  }

  log(`Found ${openIPs.length} open ports, checking for WorldMind...`);

  // Phase 2: HTTP check /api/discover
  const servers: DiscoveredServer[] = [];
  const httpChecks = openIPs.map(async (ip) => {
    try {
      const info = await httpGet<DiscoveryInfo>(`http://${ip}:${port}/api/discover`, timeout * 2);
      if (info && info.name && info.version) {
        servers.push({ ip, port, info });
        log(`  ✓ ${ip}:${port} — "${info.name}" (Round ${info.round}, ${info.players}/${info.maxPlayers} players)`);
      }
    } catch {}
  });
  await Promise.all(httpChecks);

  return servers.sort((a, b) => a.ip.localeCompare(b.ip));
}

// ─── Utilities ──────────────────────────────────────────────────

/** TCP connect probe — returns true if port is open */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
  });
}

/** Simple HTTP GET returning parsed JSON */
function httpGet<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get({
      hostname: u.hostname,
      port: parseInt(u.port || '80'),
      path: u.pathname + u.search,
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer | string) => { data += c.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('invalid json')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', (e: Error) => reject(e));
  });
}

/** Detect local subnet from primary interface IP */
function detectSubnet(): string {
  const ip = getLocalIP();
  if (ip !== '127.0.0.1') {
    return ip.split('.').slice(0, 3).join('.');
  }
  return '33.229.115';
}

/** Get local IP (prefer eth0 / en0, skip loopback and docker bridges) */
function getLocalIP(): string {
  try {
    const nets = os.networkInterfaces();
    // Prefer eth0 / en0 first
    for (const prefer of ['eth0', 'en0', 'ens0', 'wlan0']) {
      for (const net of nets[prefer] ?? []) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
    // Fallback: any non-internal IPv4
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
  } catch {}
  return '127.0.0.1';
}
