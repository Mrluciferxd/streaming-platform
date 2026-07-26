import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * Analytics tables.
 *
 * NOT included in drizzle.config.ts, and deliberately so: `video_events` is
 * range-partitioned by month, which drizzle-kit cannot express. The real DDL
 * lives in drizzle/0001_analytics.sql. These definitions exist only to give
 * queries type safety.
 *
 * Why partitioning matters here: plan §6 puts playback events in a plain table.
 * At 10k DAU that is roughly 18M rows/month landing in the same database that
 * serves the homepage. Dropping a partition is instant; DELETE on 200M rows is
 * an outage. Raw events are kept 35 days, and everything the product actually
 * reads comes from the daily rollup below.
 */

export const videoEvents = pgTable(
  'video_events',
  {
    id: bigint('id', { mode: 'number' }).notNull(),
    videoId: uuid('video_id').notNull(),
    userId: uuid('user_id'),
    sessionId: uuid('session_id').notNull(),
    // 'play' | 'pause' | 'progress' | 'complete' | 'seek' | 'error'
    // | 'quality_change' | 'rebuffer' | 'ad_impression' | 'ad_complete'
    eventType: varchar('event_type', { length: 24 }).notNull(),
    positionSec: integer('position_sec'),
    // Seconds of actual playback since the previous event. Summing this is what
    // gives real watch time; counting 'play' events does not.
    watchedSec: integer('watched_sec'),
    variant: varchar('variant', { length: 12 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partition key must be part of the primary key on a partitioned table.
    primaryKey({ columns: [t.id, t.createdAt] }),
    index('video_events_video_idx').on(t.videoId, t.createdAt),
  ],
)

/**
 * Daily per-video rollup. This is what the admin dashboard, the trending rail,
 * `videos.view_count`, and creator revenue attribution all read. Small enough
 * to keep forever.
 */
export const videoStatsDaily = pgTable(
  'video_stats_daily',
  {
    videoId: uuid('video_id').notNull(),
    day: date('day').notNull(),
    views: bigint('views', { mode: 'number' }).notNull().default(0),
    uniqueSessions: bigint('unique_sessions', { mode: 'number' }).notNull().default(0),
    watchSeconds: bigint('watch_seconds', { mode: 'number' }).notNull().default(0),
    completions: bigint('completions', { mode: 'number' }).notNull().default(0),
    rebufferEvents: bigint('rebuffer_events', { mode: 'number' }).notNull().default(0),
    adImpressions: bigint('ad_impressions', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.videoId, t.day] }),
    index('video_stats_daily_day_idx').on(t.day.desc()),
  ],
)

/**
 * Retention curve buckets — powers the drop-off chart in the admin dashboard
 * (plan §7). Bucket is percent-of-duration in 5% steps, 0..20.
 */
export const videoRetention = pgTable(
  'video_retention',
  {
    videoId: uuid('video_id').notNull(),
    day: date('day').notNull(),
    bucket: integer('bucket').notNull(),
    sessions: bigint('sessions', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.videoId, t.day, t.bucket] })],
)

export const RAW_EVENT_RETENTION_DAYS = 35

export const eventTypes = [
  'play',
  'pause',
  'progress',
  'complete',
  'seek',
  'error',
  'quality_change',
  'rebuffer',
  'ad_impression',
  'ad_complete',
] as const

export type EventType = (typeof eventTypes)[number]
