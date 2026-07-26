CREATE TYPE "public"."series_status" AS ENUM('announced', 'airing', 'hiatus', 'completed', 'cancelled');--> statement-breakpoint
ALTER TABLE "series" RENAME COLUMN "description" TO "synopsis";--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "title" varchar(200);--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "synopsis" text;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "thumbnail_url" text;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "aired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "portrait_url" text;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "banner_url" text;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "status" "series_status" DEFAULT 'airing' NOT NULL;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "total_episodes" smallint;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "studio" varchar(120);--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "release_year" smallint;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "season_label" varchar(24);--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "series_airing_idx" ON "series" USING btree ("updated_at" DESC NULLS LAST) WHERE "series"."status" = 'airing';--> statement-breakpoint
CREATE INDEX "series_season_idx" ON "series" USING btree ("season_label");--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_episode_no_positive" CHECK ("episodes"."episode_no" > 0);--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_total_episodes_positive" CHECK ("series"."total_episodes" is null or "series"."total_episodes" > 0);--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_release_year_range" CHECK ("series"."release_year" is null or "series"."release_year" between 1900 and 2200);