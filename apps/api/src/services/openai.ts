// OpenAI embeddings wrapper. Used only for niche-cluster classification.

import { env } from '../env.js';

const OPENAI_BASE = 'https://api.openai.com/v1';
const EMBED_MODEL = 'text-embedding-3-small'; // 1536 dims

function authHeaders(): HeadersInit {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  return {
    authorization: `Bearer ${env.OPENAI_API_KEY}`,
    'content-type': 'application/json',
  };
}

export async function embedText(input: string): Promise<number[]> {
  const res = await fetch(`${OPENAI_BASE}/embeddings`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model: EMBED_MODEL, input }),
  });
  if (!res.ok) {
    throw new Error(`openai embed ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data[0].embedding;
}
