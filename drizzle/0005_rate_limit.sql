-- Hand-written, like 0001_analytics.sql: src/db/schema-ops.ts is deliberately
-- outside drizzle.config.ts, so drizzle-kit does not manage this table.
--
-- One row per (bucket, identity). The upsert in src/lib/rate-limit.ts rolls the
-- window in place, so this table is sized by active callers, not by traffic.

CREATE TABLE IF NOT EXISTS "rate_limits" (
  "bucket" varchar(40) NOT NULL,
  "identity" varchar(64) NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("bucket", "identity")
);
--> statement-breakpoint
-- Read only by the sweeper. Without it, cleaning up a table that is written on
-- every request costs a sequential scan of it.
CREATE INDEX IF NOT EXISTS "rate_limits_expiry_idx" ON "rate_limits" USING btree ("expires_at");
