// In-process job runner. Polls the `jobs` table every 5s and dispatches
// pending jobs to handlers with concurrency caps + backoff retry.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { log } from '../log.js';

import { runExtract } from './extract.js';
import { runClassifyFormat } from './classify-format.js';
import { runClassifyNiche } from './classify-niche.js';

type JobKind = 'extract' | 'classify-format' | 'classify-niche';

const HANDLERS: Record<JobKind, (payload: any) => Promise<void>> = {
  extract: runExtract,
  'classify-format': runClassifyFormat,
  'classify-niche': runClassifyNiche,
};

const POLL_MS = 5_000;
const MAX_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;

let running = 0;
let stopped = false;

async function pickJob() {
  // SKIP LOCKED transactional pickup: claim a single pending job.
  const claimed = (await db.execute(sql`
    update jobs
    set status = 'running', started_at = now(), attempts = attempts + 1
    where id = (
      select id from jobs
      where status in ('pending','failed')
        and scheduled_at <= now()
        and attempts < ${MAX_ATTEMPTS}
      order by scheduled_at asc
      for update skip locked
      limit 1
    )
    returning *
  `)) as unknown as Array<{
    id: string;
    kind: JobKind;
    payload: any;
    attempts: number;
  }>;
  return claimed[0];
}

async function runOne() {
  const job = await pickJob();
  if (!job) return false;
  running++;
  try {
    const handler = HANDLERS[job.kind];
    if (!handler) throw new Error(`unknown job kind: ${job.kind}`);
    await handler(job.payload);
    await db
      .update(jobs)
      .set({ status: 'done', completedAt: new Date() })
      .where(eq(jobs.id, job.id));
    log.info({ jobId: job.id, kind: job.kind }, 'job done');
  } catch (err) {
    const msg = (err as Error).message;
    log.error({ jobId: job.id, kind: job.kind, err: msg }, 'job failed');
    const final = job.attempts >= MAX_ATTEMPTS;
    await db
      .update(jobs)
      .set({
        status: final ? 'dead' : 'failed',
        lastError: msg,
        scheduledAt: new Date(Date.now() + 30_000 * job.attempts), // backoff
      })
      .where(eq(jobs.id, job.id));
  } finally {
    running--;
  }
  return true;
}

async function tick() {
  while (!stopped && running < MAX_CONCURRENCY) {
    const ran = await runOne();
    if (!ran) break;
  }
}

export function startWorkers() {
  log.info('workers started');
  const loop = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      log.error({ err: (err as Error).message }, 'worker tick failed');
    }
    setTimeout(loop, POLL_MS);
  };
  setTimeout(loop, POLL_MS);
}

export function stopWorkers() {
  stopped = true;
}
