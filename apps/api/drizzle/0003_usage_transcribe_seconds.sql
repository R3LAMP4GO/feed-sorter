-- Whisper transcription seconds counter on usage_counters.
--
-- Tracks per-user, per-billing-period transcription seconds billed against
-- Groq Whisper (or the WhisperX sidecar fallback). Free tier is hard-gated
-- by the requireTier('pro') middleware ahead of the route. Paid tiers have
-- per-tier hard caps (pro=7200s/mo, studio=72000s/mo) enforced in the
-- transcribe handler.
--
-- `double precision` (not integer) because whisper returns fractional
-- second durations; we keep them at full precision to avoid drift.

ALTER TABLE "usage_counters"
  ADD COLUMN IF NOT EXISTS "transcribe_seconds" double precision DEFAULT 0 NOT NULL;
