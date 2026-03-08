import { getDefaultLLMClient } from '../src/llm/client.js';

async function main() {
  const llm = getDefaultLLMClient();
  console.log('Calling LLM...');
  const start = Date.now();
  const r = await llm.json<{test: boolean}>(
    'Return valid JSON only: {"test": true}',
    'Hello?'
  );
  console.log('LLM OK:', JSON.stringify(r), `(${Date.now() - start}ms)`);
}

main().catch(e => console.error('LLM error:', e.message));
