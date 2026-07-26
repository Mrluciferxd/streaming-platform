-- Analytics tables.
--
-- Hand-written because drizzle-kit cannot express PARTITION BY. See
-- src/db/schema-analytics.ts for the matching query-time definitions.
--
-- Plan §6 puts playback events in a plain table. At the §13 growth scenario
-- (10k DAU) that is roughly 18M rows/month arriving in the same database that
-- serves the homepage — it becomes the largest table within weeks, dominates
-- autovacuum and backups, and pruning it means a DELETE over hundreds of
-- millions of rows.
--
-- Monthly range partitions fix all three: pruning is DROP TABLE (instant, no
-- bloat), vacuum works per-partition, and every dashboard query filters on
-- created_at so the planner prunes to one or two partitions.
--
-- Raw events are retained 35 days. Everything the product reads long-term comes
-- from the rollups at the bottom of this file.

CREATE TABLE video_events (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  video_id     uuid        NOT NULL,
  user_id      uuid,
  session_id   uuid        NOT NULL,
  event_type   varchar(24) NOT NULL,
  position_sec integer,
  watched_sec  integer,
  variant      varchar(12),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
--> statement-breakpoint

-- No foreign key to videos: FK checks on a high-volume insert path cost a
-- lookup per row. Orphaned events are harmless — the rollup joins and discards
-- them.
CREATE INDEX video_events_video_idx ON video_events (video_id, created_at);
--> statement-breakpoint
CREATE INDEX video_events_session_idx ON video_events (session_id, created_at);
--> statement-breakpoint

-- A default partition catches rows that arrive before the next month's
-- partition is created, so a missed maintenance run degrades to slow rather
-- than to failed inserts.
CREATE TABLE video_events_default PARTITION OF video_events DEFAULT;
--> statement-breakpoint

-- Creates the partition covering `month` if it does not exist. Call from a
-- monthly job, several months ahead.
CREATE OR REPLACE FUNCTION ensure_video_events_partition(month date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  start_at date := date_trunc('month', month)::date;
  end_at   date := (date_trunc('month', month) + interval '1 month')::date;
  part     text := 'video_events_' || to_char(start_at, 'YYYY_MM');
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF video_events FOR VALUES FROM (%L) TO (%L)',
      part, start_at, end_at
    );
  END IF;
END;
$$;
--> statement-breakpoint

-- Drops partitions entirely older than the retention window.
CREATE OR REPLACE FUNCTION prune_video_events(retain_days integer DEFAULT 35)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff  date := (now() - make_interval(days => retain_days))::date;
  part    record;
  dropped integer := 0;
BEGIN
  FOR part IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    WHERE i.inhparent = 'video_events'::regclass
      AND c.relname ~ '^video_events_[0-9]{4}_[0-9]{2}$'
      AND to_date(right(c.relname, 7), 'YYYY_MM') + interval '1 month' <= cutoff
  LOOP
    EXECUTE format('DROP TABLE %I', part.relname);
    dropped := dropped + 1;
  END LOOP;

  RETURN dropped;
END;
$$;
--> statement-breakpoint

-- Bootstrap: current month plus three ahead.
SELECT ensure_video_events_partition((date_trunc('month', now()) + make_interval(months => n))::date)
FROM generate_series(0, 3) AS n;
--> statement-breakpoint

-- Daily rollup. This is what the admin dashboard, the trending rail,
-- videos.view_count and creator revenue attribution all read.
CREATE TABLE video_stats_daily (
  video_id        uuid   NOT NULL,
  day             date   NOT NULL,
  views           bigint NOT NULL DEFAULT 0,
  unique_sessions bigint NOT NULL DEFAULT 0,
  watch_seconds   bigint NOT NULL DEFAULT 0,
  completions     bigint NOT NULL DEFAULT 0,
  rebuffer_events bigint NOT NULL DEFAULT 0,
  ad_impressions  bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, day)
);
--> statement-breakpoint
CREATE INDEX video_stats_daily_day_idx ON video_stats_daily (day DESC);
--> statement-breakpoint

-- Retention curve in 5% buckets (0..20), powering the drop-off chart in §7.
CREATE TABLE video_retention (
  video_id uuid    NOT NULL,
  day      date    NOT NULL,
  bucket   integer NOT NULL,
  sessions bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (video_id, day, bucket),
  CONSTRAINT video_retention_bucket_range CHECK (bucket BETWEEN 0 AND 20)
);
--> statement-breakpoint

-- Idempotent rollup for a single day. Safe to re-run — it recomputes rather
-- than accumulating, so a retried job cannot double-count.
CREATE OR REPLACE FUNCTION rollup_video_stats(target_day date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  INSERT INTO video_stats_daily AS s (
    video_id, day, views, unique_sessions, watch_seconds,
    completions, rebuffer_events, ad_impressions, updated_at
  )
  SELECT
    e.video_id,
    target_day,
    count(*) FILTER (WHERE e.event_type = 'play'),
    count(DISTINCT e.session_id),
    coalesce(sum(e.watched_sec), 0),
    count(*) FILTER (WHERE e.event_type = 'complete'),
    count(*) FILTER (WHERE e.event_type = 'rebuffer'),
    count(*) FILTER (WHERE e.event_type = 'ad_impression'),
    now()
  FROM video_events e
  WHERE e.created_at >= target_day
    AND e.created_at <  target_day + 1
  GROUP BY e.video_id
  ON CONFLICT (video_id, day) DO UPDATE SET
    views           = excluded.views,
    unique_sessions = excluded.unique_sessions,
    watch_seconds   = excluded.watch_seconds,
    completions     = excluded.completions,
    rebuffer_events = excluded.rebuffer_events,
    ad_impressions  = excluded.ad_impressions,
    updated_at      = now();

  GET DIAGNOSTICS affected = ROW_COUNT;

  -- Sync the denormalised counter from the rollup rather than writing to the
  -- videos table on every play (plan §8).
  UPDATE videos v
  SET view_count = t.total
  FROM (
    SELECT video_id, sum(views) AS total
    FROM video_stats_daily
    GROUP BY video_id
  ) t
  WHERE t.video_id = v.id
    AND v.view_count IS DISTINCT FROM t.total;

  RETURN affected;
END;
$$;
