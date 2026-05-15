// Format classifier worker.
//
// Inputs: post.cover_url (image) + speech-density signal from the transcript
// (chars-per-second of spoken text).
// Output: format ∈ { talking-head, voiceover-broll, skit, tutorial, pov,
//   text-overlay, unknown }.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { posts, transcripts } from '../db/schema.js';
import { chatVision } from '../services/groq.js';
import { log } from '../log.js';

const FORMATS = [
  'talking-head',
  'voiceover-broll',
  'skit',
  'tutorial',
  'pov',
  'text-overlay',
  'unknown',
] as const;

const SYSTEM = `You classify a short-form video by visual format from a single cover frame
plus a "speech density" signal (chars of speech per second).

Return ONLY a JSON object: { "format": one of ${FORMATS.map((f) => `"${f}"`).join(', ')} }`;

function speechDensity(transcript: { fullText: string | null; durationS: number | null }): number {
  const len = transcript.fullText?.length ?? 0;
  const dur = transcript.durationS ?? 30;
  return dur > 0 ? len / dur : 0;
}

export async function runClassifyFormat(payload: { postId: string }): Promise<void> {
  const { postId } = payload;

  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post?.coverUrl) {
    log.warn({ postId }, 'classify-format: no cover');
    return;
  }
  const [transcript] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.postId, postId))
    .limit(1);

  const density = transcript ? speechDensity(transcript) : 0;
  const user = `Speech density: ${density.toFixed(1)} chars/sec.\nClassify the format. Return JSON only.`;

  let format: string = 'unknown';
  try {
    const text = await chatVision({
      system: SYSTEM,
      user,
      imageUrl: post.coverUrl,
      maxTokens: 64,
    });
    const match = text.match(/"format"\s*:\s*"([^"]+)"/);
    const candidate = match?.[1];
    if (candidate && (FORMATS as readonly string[]).includes(candidate)) {
      format = candidate;
    }
  } catch (err) {
    log.warn({ err: (err as Error).message, postId }, 'classify-format: vision failed');
  }

  await db.update(posts).set({ format, updatedAt: new Date() }).where(eq(posts.id, postId));
}
