CREATE TABLE IF NOT EXISTS "analyses" (
	"hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"provider" text,
	"model" text,
	"result" jsonb NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	"hit_count" integer DEFAULT 0,
	"last_hit_at" timestamp with time zone,
	CONSTRAINT "analyses_kind_check" CHECK ("kind" IN ('analyze','cover','transcribe'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analyses_kind_created_idx" ON "analyses" USING btree ("kind","created_at" DESC NULLS LAST);