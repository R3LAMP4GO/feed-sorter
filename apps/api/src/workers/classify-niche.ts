// Niche-cluster worker: embed the niche label + topics, do pgvector cosine NN
// over `niche_clusters`. If best similarity < 0.85, create a new cluster.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { posts, nicheClusters } from '../db/schema.js';
import { embedText } from '../services/openai.js';
import { log } from '../log.js';

const SIMILARITY_THRESHOLD = 0.85;

export async function runClassifyNiche(payload: {
  postId: string;
  nicheLabel: string;
  topics: string[];
}): Promise<void> {
  const { postId, nicheLabel, topics } = payload;
  const docText = [nicheLabel, ...(topics ?? [])].join(' • ');
  const embedding = await embedText(docText);

  // Cosine similarity = 1 - cosine_distance. pgvector's `<=>` is cosine distance.
  // Format embedding as a pgvector literal: '[0.1,0.2,...]'.
  const vectorLit = `[${embedding.join(',')}]`;

  const nn = (await db.execute(sql`
    select id, label, 1 - (embedding <=> ${vectorLit}::vector) as similarity
    from niche_clusters
    where embedding is not null
    order by embedding <=> ${vectorLit}::vector
    limit 1
  `)) as unknown as Array<{ id: string; label: string; similarity: number }>;
  const best = nn[0];

  let clusterId: string;
  if (best && best.similarity >= SIMILARITY_THRESHOLD) {
    clusterId = best.id;
    await db
      .update(nicheClusters)
      .set({ postCount: sql`${nicheClusters.postCount} + 1` })
      .where(eq(nicheClusters.id, clusterId));
  } else {
    const [created] = await db
      .insert(nicheClusters)
      .values({
        label: nicheLabel,
        embedding: embedding,
        postCount: 1,
      })
      .returning({ id: nicheClusters.id });
    clusterId = created.id;
    log.info({ clusterId, label: nicheLabel }, 'created niche cluster');
  }

  await db
    .update(posts)
    .set({ nicheClusterId: clusterId, updatedAt: new Date() })
    .where(eq(posts.id, postId));
}
