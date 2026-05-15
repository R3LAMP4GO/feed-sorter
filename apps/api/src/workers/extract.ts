// Extraction worker: transcript → { hook, middle, CTA, topics, niche_label }.
//
// Uses Groq Llama-3.3-70b-versatile in JSON mode. Prompt enforces enums for
// hook_type and cta_type. After completing extraction, enqueues
// `classify-format` and `classify-niche` follow-ups.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { posts, transcripts, extractions, jobs } from '../db/schema.js';
import { chatJson } from '../services/groq.js';
import { log } from '../log.js';

const HOOK_TYPES = [
  'question',
  'stat',
  'controversial-claim',
  'list-promise',
  'story-open',
  'pattern-interrupt',
  'direct-address',
  'other',
] as const;

const CTA_TYPES = [
  'follow',
  'comment',
  'save',
  'share',
  'link-in-bio',
  'visit-profile',
  'none',
] as const;

const SYSTEM_PROMPT = `You are an expert short-form video analyst. Given a transcript of a viral
Instagram Reel / TikTok / YouTube Short, extract the structural pieces.

Return ONLY a JSON object with this exact shape:
{
  "hook_text": string,         // first 1-3 sentences that grab attention
  "hook_type": one of [${HOOK_TYPES.map((s) => `"${s}"`).join(', ')}],
  "hook_start_s": number,      // start time of the hook in seconds
  "hook_end_s": number,        // end time of the hook in seconds
  "middle_summary": string,    // 1-2 sentence summary of the middle section
  "cta_text": string | null,   // the call-to-action sentence (or null if absent)
  "cta_type": one of [${CTA_TYPES.map((s) => `"${s}"`).join(', ')}],
  "cta_start_s": number | null,
  "topics": string[],          // 3-7 short topic tags (lowercase)
  "niche_label": string        // a 2-4 word niche label, e.g. "morning fitness routines"
}

Hook guidelines: it is the literal opening that pattern-interrupts a scroller.
Pick the type that best matches the rhetorical move. If unclear use "other".

CTA guidelines: pick the closest type. Use "none" only if there is genuinely
no call-to-action.`;

interface ExtractionJson {
  hook_text: string;
  hook_type: string;
  hook_start_s: number;
  hook_end_s: number;
  middle_summary: string;
  cta_text: string | null;
  cta_type: string;
  cta_start_s: number | null;
  topics: string[];
  niche_label: string;
}

function clampEnum<T extends readonly string[]>(value: string, allowed: T, fallback: T[number]): T[number] {
  return (allowed as readonly string[]).includes(value) ? (value as T[number]) : fallback;
}

export async function runExtract(payload: { postId: string }): Promise<void> {
  const { postId } = payload;
  const [transcript] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.postId, postId))
    .limit(1);
  if (!transcript || !transcript.fullText) {
    log.warn({ postId }, 'extract: no transcript');
    return;
  }

  const userPrompt = `Transcript:\n\n${transcript.fullText}\n\nReturn JSON only.`;

  const raw = (await chatJson({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 1200,
  })) as Partial<ExtractionJson>;

  const safe: ExtractionJson = {
    hook_text: String(raw.hook_text ?? '').slice(0, 1000),
    hook_type: clampEnum(String(raw.hook_type ?? 'other'), HOOK_TYPES, 'other'),
    hook_start_s: Number(raw.hook_start_s ?? 0) || 0,
    hook_end_s: Number(raw.hook_end_s ?? 0) || 0,
    middle_summary: String(raw.middle_summary ?? '').slice(0, 2000),
    cta_text: raw.cta_text ? String(raw.cta_text).slice(0, 500) : null,
    cta_type: clampEnum(String(raw.cta_type ?? 'none'), CTA_TYPES, 'none'),
    cta_start_s: raw.cta_start_s != null ? Number(raw.cta_start_s) : null,
    topics: Array.isArray(raw.topics)
      ? raw.topics.map((s) => String(s).toLowerCase()).slice(0, 10)
      : [],
    niche_label: String(raw.niche_label ?? 'misc').slice(0, 80),
  };

  await db
    .insert(extractions)
    .values({
      postId,
      hookText: safe.hook_text,
      hookType: safe.hook_type,
      hookStartS: safe.hook_start_s,
      hookEndS: safe.hook_end_s,
      middleSummary: safe.middle_summary,
      ctaText: safe.cta_text,
      ctaType: safe.cta_type,
      ctaStartS: safe.cta_start_s,
      topics: safe.topics,
      llmModel: 'llama-3.3-70b-versatile',
    })
    .onConflictDoUpdate({
      target: extractions.postId,
      set: {
        hookText: safe.hook_text,
        hookType: safe.hook_type,
        hookStartS: safe.hook_start_s,
        hookEndS: safe.hook_end_s,
        middleSummary: safe.middle_summary,
        ctaText: safe.cta_text,
        ctaType: safe.cta_type,
        ctaStartS: safe.cta_start_s,
        topics: safe.topics,
        llmModel: 'llama-3.3-70b-versatile',
      },
    });

  // Enqueue follow-up classification jobs
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (post?.coverUrl && !post.format) {
    await db.insert(jobs).values({ kind: 'classify-format', payload: { postId } });
  }
  if (!post?.nicheClusterId) {
    await db.insert(jobs).values({
      kind: 'classify-niche',
      payload: { postId, nicheLabel: safe.niche_label, topics: safe.topics },
    });
  }
}
