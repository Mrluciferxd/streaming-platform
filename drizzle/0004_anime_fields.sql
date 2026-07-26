ALTER TABLE "videos" ADD COLUMN "portrait_url" text;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "has_sub" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "has_dub" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "season_label" varchar(24);--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "score" smallint;--> statement-breakpoint
CREATE INDEX "videos_season_idx" ON "videos" USING btree ("season_label");--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_score_range" CHECK ("videos"."score" is null or "videos"."score" between 0 and 100);