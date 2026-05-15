-- Phase 13: LLM call counters on the existing usage_counters row.
-- Tracks per-user, per-billing-period analyze/cover calls made through the
-- managed API (Gemini-backed /v1/llm/*). Cached calls do NOT increment;
-- only cache-miss provider round-trips do.

ALTER TABLE "usage_counters" ADD COLUMN IF NOT EXISTS "analyze_calls" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN IF NOT EXISTS "cover_calls" integer DEFAULT 0 NOT NULL;
