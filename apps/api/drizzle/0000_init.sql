CREATE TABLE IF NOT EXISTS "captures" (
	"user_id" uuid NOT NULL,
	"post_id" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now(),
	"scope" text,
	CONSTRAINT "captures_user_id_post_id_pk" PRIMARY KEY("user_id","post_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"username" "citext" NOT NULL,
	"display_name" text,
	"follower_count" bigint,
	"median_views" bigint,
	"niche_cluster_id" uuid,
	"last_scraped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "extractions" (
	"post_id" text PRIMARY KEY NOT NULL,
	"hook_text" text,
	"hook_type" text,
	"hook_start_s" double precision,
	"hook_end_s" double precision,
	"middle_summary" text,
	"cta_text" text,
	"cta_type" text,
	"cta_start_s" double precision,
	"topics" text[],
	"llm_model" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0,
	"last_error" text,
	"scheduled_at" timestamp with time zone DEFAULT now(),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "magic_link_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "niche_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"embedding" vector(1536),
	"parent_id" uuid,
	"post_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"native_id" text NOT NULL,
	"creator_id" uuid,
	"posted_at" timestamp with time zone,
	"views" bigint,
	"likes" bigint,
	"comments" bigint,
	"shares" bigint,
	"outlier_score" double precision,
	"velocity" double precision,
	"cover_url" text,
	"duration_s" integer,
	"caption" text,
	"raw_metadata" jsonb,
	"niche_cluster_id" uuid,
	"format" text,
	"captured_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"jwt_jti" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	CONSTRAINT "sessions_jwt_jti_unique" UNIQUE("jwt_jti")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transcripts" (
	"post_id" text PRIMARY KEY NOT NULL,
	"full_text" text,
	"language" text,
	"source" text,
	"segments" jsonb,
	"duration_s" double precision,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_counters" (
	"user_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"transcriptions" integer DEFAULT 0 NOT NULL,
	"extractions" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_counters_user_id_period_start_pk" PRIMARY KEY("user_id","period_start")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"stripe_customer_id" text,
	"tier" text DEFAULT 'free' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filter_json" jsonb NOT NULL,
	"sort_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "captures" ADD CONSTRAINT "captures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "captures" ADD CONSTRAINT "captures_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creators" ADD CONSTRAINT "creators_niche_cluster_id_niche_clusters_id_fk" FOREIGN KEY ("niche_cluster_id") REFERENCES "public"."niche_clusters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "extractions" ADD CONSTRAINT "extractions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "posts" ADD CONSTRAINT "posts_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "posts" ADD CONSTRAINT "posts_niche_cluster_id_niche_clusters_id_fk" FOREIGN KEY ("niche_cluster_id") REFERENCES "public"."niche_clusters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "views" ADD CONSTRAINT "views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "captures_user_captured_idx" ON "captures" USING btree ("user_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creators_platform_username_uq" ON "creators" USING btree ("platform","username");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extractions_hook_type_idx" ON "extractions" USING btree ("hook_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extractions_cta_type_idx" ON "extractions" USING btree ("cta_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extractions_topics_gin_idx" ON "extractions" USING gin ("topics");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_pending_idx" ON "jobs" USING btree ("status","scheduled_at") WHERE status in ('pending','failed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "niche_cluster_cosine_idx" ON "niche_clusters" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_platform_niche_posted_idx" ON "posts" USING btree ("platform","niche_cluster_id","posted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_platform_format_posted_idx" ON "posts" USING btree ("platform","format","posted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_creator_posted_idx" ON "posts" USING btree ("creator_id","posted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_velocity_idx" ON "posts" USING btree ("velocity" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_outlier_idx" ON "posts" USING btree ("outlier_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_views_idx" ON "posts" USING btree ("views" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_likes_idx" ON "posts" USING btree ("likes" DESC NULLS LAST);