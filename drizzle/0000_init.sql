CREATE TYPE "public"."age_rating" AS ENUM('U', 'UA7', 'UA13', 'UA16', 'A');--> statement-breakpoint
CREATE TYPE "public"."comment_status" AS ENUM('visible', 'pending', 'hidden', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."creator_status" AS ENUM('pending', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'processing', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reaction_type" AS ENUM('like', 'dislike');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'reviewing', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."storage_provider" AS ENUM('r2', 'bunny');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('viewer', 'creator', 'moderator', 'admin');--> statement-breakpoint
CREATE TYPE "public"."video_status" AS ENUM('draft', 'uploading', 'processing', 'ready', 'published', 'unpublished', 'failed', 'removed');--> statement-breakpoint
CREATE TABLE "ad_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"type" varchar(24) NOT NULL,
	"position" varchar(40),
	"vast_url" text,
	"frequency_cap" smallint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" uuid,
	"action" varchar(60) NOT NULL,
	"entity_type" varchar(40) NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"ip" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(120) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"icon" varchar(60),
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"user_id" uuid,
	"parent_id" uuid,
	"body" text NOT NULL,
	"status" "comment_status" DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slug" varchar(120) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"bio" text,
	"avatar_url" text,
	"status" "creator_status" DEFAULT 'pending' NOT NULL,
	"revenue_share_bps" integer DEFAULT 5000 NOT NULL,
	"payout_details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creators_share_range" CHECK ("creators"."revenue_share_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"season_no" smallint DEFAULT 1 NOT NULL,
	"episode_no" smallint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"reference" varchar(120),
	"withheld_paise" bigint DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_amount_positive" CHECK ("payouts"."amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"type" "reaction_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reactions_user_id_video_id_pk" PRIMARY KEY("user_id","video_id")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid,
	"comment_id" uuid,
	"reporter_id" uuid,
	"reporter_email" varchar(320),
	"reason" varchar(60) NOT NULL,
	"detail" text,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() + interval '15 days' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"period_month" varchar(7) NOT NULL,
	"view_count" bigint DEFAULT 0 NOT NULL,
	"watch_seconds" bigint DEFAULT 0 NOT NULL,
	"gross_revenue_paise" bigint DEFAULT 0 NOT NULL,
	"share_bps" integer NOT NULL,
	"payable_paise" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(160) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"poster_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subtitles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"language" varchar(10) NOT NULL,
	"label" varchar(60) NOT NULL,
	"vtt_path" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(120) NOT NULL,
	"name" varchar(120) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320),
	"phone" varchar(20),
	"password_hash" text,
	"display_name" varchar(80) NOT NULL,
	"avatar_url" text,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"consented_at" timestamp with time zone,
	"consent_version" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_identifier_present" CHECK ("users"."email" is not null or "users"."phone" is not null)
);
--> statement-breakpoint
CREATE TABLE "video_categories" (
	"video_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "video_categories_video_id_category_id_pk" PRIMARY KEY("video_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "video_tags" (
	"video_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "video_tags_video_id_tag_id_pk" PRIMARY KEY("video_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "video_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"resolution" varchar(12) NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bitrate_kbps" integer NOT NULL,
	"peak_bitrate_kbps" integer NOT NULL,
	"codec" varchar(40) DEFAULT 'avc1.640028' NOT NULL,
	"playlist_path" text NOT NULL,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(200) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"duration_sec" integer,
	"poster_url" text,
	"sprite_url" text,
	"sprite_vtt_url" text,
	"preview_url" text,
	"status" "video_status" DEFAULT 'draft' NOT NULL,
	"age_rating" "age_rating" DEFAULT 'U' NOT NULL,
	"content_descriptor" text,
	"language" varchar(10) DEFAULT 'hi' NOT NULL,
	"uploader_id" uuid,
	"creator_id" uuid,
	"provider" "storage_provider" DEFAULT 'r2' NOT NULL,
	"provider_asset_id" text,
	"hls_master_path" text,
	"source_size_bytes" bigint,
	"view_count" bigint DEFAULT 0 NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '')), 'B')) STORED
);
--> statement-breakpoint
CREATE TABLE "watch_history" (
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"position_sec" integer DEFAULT 0 NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"watched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_history_user_id_video_id_pk" PRIMARY KEY("user_id","video_id")
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_user_id_video_id_pk" PRIMARY KEY("user_id","video_id")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creators" ADD CONSTRAINT "creators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_shares" ADD CONSTRAINT "revenue_shares_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitles" ADD CONSTRAINT "subtitles_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_categories" ADD CONSTRAINT "video_categories_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_categories" ADD CONSTRAINT "video_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_tags" ADD CONSTRAINT "video_tags_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_tags" ADD CONSTRAINT "video_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_variants" ADD CONSTRAINT "video_variants_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_history" ADD CONSTRAINT "watch_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_history" ADD CONSTRAINT "watch_history_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_placements_active_idx" ON "ad_placements" USING btree ("type") WHERE "ad_placements"."active";--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_key" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "comments_video_idx" ON "comments" USING btree ("video_id","created_at" DESC NULLS LAST) WHERE "comments"."status" = 'visible';--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "comments_moderation_idx" ON "comments" USING btree ("created_at") WHERE "comments"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "creators_user_key" ON "creators" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creators_slug_key" ON "creators" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_series_season_ep_key" ON "episodes" USING btree ("series_id","season_no","episode_no");--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_video_key" ON "episodes" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "payouts_creator_idx" ON "payouts" USING btree ("creator_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reactions_video_idx" ON "reactions" USING btree ("video_id","type");--> statement-breakpoint
CREATE INDEX "reports_open_due_idx" ON "reports" USING btree ("due_at") WHERE "reports"."status" in ('open', 'reviewing');--> statement-breakpoint
CREATE INDEX "reports_video_idx" ON "reports" USING btree ("video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_shares_creator_period_key" ON "revenue_shares" USING btree ("creator_id","period_month");--> statement-breakpoint
CREATE UNIQUE INDEX "series_slug_key" ON "series" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subtitles_video_lang_key" ON "subtitles" USING btree ("video_id","language");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_slug_key" ON "tags" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email")) WHERE "users"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_key" ON "users" USING btree ("phone") WHERE "users"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "video_categories_category_idx" ON "video_categories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "video_tags_tag_idx" ON "video_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_variants_video_resolution_key" ON "video_variants" USING btree ("video_id","resolution");--> statement-breakpoint
CREATE INDEX "video_variants_video_idx" ON "video_variants" USING btree ("video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "videos_slug_key" ON "videos" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "videos_published_idx" ON "videos" USING btree ("published_at" DESC NULLS LAST) WHERE "videos"."status" = 'published' and "videos"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "videos_language_idx" ON "videos" USING btree ("language","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "videos_creator_idx" ON "videos" USING btree ("creator_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "videos_status_idx" ON "videos" USING btree ("status");--> statement-breakpoint
CREATE INDEX "videos_search_idx" ON "videos" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "watch_history_user_recent_idx" ON "watch_history" USING btree ("user_id","watched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "watchlist_user_idx" ON "watchlist" USING btree ("user_id","added_at" DESC NULLS LAST);