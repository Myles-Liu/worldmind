import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOULS_DIR = path.join(__dirname, 'souls');

export class SoulLoader {
  private cache: Map<string, string> = new Map();

  async load(agentName: string): Promise<string> {
    if (this.cache.has(agentName)) {
      return this.cache.get(agentName)!;
    }
    
    const filePath = path.join(SOULS_DIR, `${agentName}.md`);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.cache.set(agentName, content);
      return content;
    } catch {
      return `You are the ${agentName} agent.`;
    }
  }
}

// Singleton
let _loader: SoulLoader | null = null;
export function getSoulLoader(): SoulLoader {
  if (!_loader) _loader = new SoulLoader();
  return _loader;
}
