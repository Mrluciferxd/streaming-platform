import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * Schema notes
 * ------------
 * Money is stored as integer paise (bigint). Never float, never decimal-as-text.
 *
 * Analytics events are NOT in this file. `video_events` is a range-partitioned
 * table created by a hand-written migration (see src/db/schema-analytics.ts and
 * drizzle/0001_analytics.sql) because drizzle-kit cannot express PARTITION BY.
 * Keeping 18M rows/month out of the OLTP hot path is deliberate.
 */

const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
})

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum('user_role', ['viewer', 'creator', 'moderator', 'admin'])

export const videoStatus = pgEnum('video_status', [
  'draft', // metadata exists, no source uploaded
  'uploading', // TUS upload in flight
  'processing', // transcode queued or running
  'ready', // renditions exist, not yet public
  'published', // publicly visible
  'unpublished', // withdrawn by operator
  'failed', // transcode failed
  'removed', // taken down (legal/moderation) — keep the row for the audit trail
])

/**
 * IT Rules 2021 self-classification categories (plan §10). These are the exact
 * five ratings a "publisher of online curated content" must use.
 */
export const ageRating = pgEnum('age_rating', ['U', 'UA7', 'UA13', 'UA16', 'A'])

export const commentStatus = pgEnum('comment_status', ['visible', 'pending', 'hidden', 'deleted'])
export const reportStatus = pgEnum('report_status', ['open', 'reviewing', 'actioned', 'dismissed'])
export const reactionType = pgEnum('reaction_type', ['like', 'dislike'])
export const creatorStatus = pgEnum('creator_status', ['pending', 'active', 'suspended'])
export const payoutStatus = pgEnum('payout_status', ['pending', 'processing', 'paid', 'failed'])
export const storageProvider = pgEnum('storage_provider', ['r2', 'bunny'])

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 20 }),
    passwordHash: text('password_hash'),
    displayName: varchar('display_name', { length: 80 }).notNull(),
    avatarUrl: text('avatar_url'),
    role: userRole('role').notNull().default('viewer'),
    emailVerified: boolean('email_verified').notNull().default(false),
    phoneVerified: boolean('phone_verified').notNull().default(false),

    // DPDP Act 2023 (plan §10): consent must be demonstrable and withdrawable.
    consentedAt: timestamp('consented_at', { withTimezone: true }),
    consentVersion: varchar('consent_version', { length: 20 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Soft delete so a DPDP erasure request keeps referential integrity while
    // the PII columns get nulled out.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`).where(sql`${t.deletedAt} is null`),
    uniqueIndex('users_phone_key').on(t.phone).where(sql`${t.deletedAt} is null`),
    check('users_identifier_present', sql`${t.email} is not null or ${t.phone} is not null`),
  ],
)

/**
 * Server-side sessions. The cookie carries an opaque random token; only its
 * SHA-256 lives here, so a database leak does not hand over live sessions.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: varchar('ip', { length: 45 }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
)

/**
 * Creators, because plan §1 makes revenue-share the primary content strategy
 * but plan §6 has nowhere to record the split. Doing payouts in a spreadsheet
 * stops working at roughly the tenth creator.
 */
export const creators = pgTable(
  'creators',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    slug: varchar('slug', { length: 120 }).notNull(),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    bio: text('bio'),
    avatarUrl: text('avatar_url'),
    status: creatorStatus('status').notNull().default('pending'),
    // Basis points of net ad revenue. 5000 = 50%. Integer maths only.
    revenueShareBps: integer('revenue_share_bps').notNull().default(5000),
    payoutDetails: jsonb('payout_details'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('creators_user_key').on(t.userId),
    uniqueIndex('creators_slug_key').on(t.slug),
    check('creators_share_range', sql`${t.revenueShareBps} between 0 and 10000`),
  ],
)

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    slug: varchar('slug', { length: 120 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    icon: varchar('icon', { length: 60 }),
    parentId: uuid('parent_id'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('categories_slug_key').on(t.slug),
    index('categories_parent_idx').on(t.parentId, t.sortOrder),
  ],
)

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    slug: varchar('slug', { length: 120 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
  },
  (t) => [uniqueIndex('tags_slug_key').on(t.slug)],
)

export const series = pgTable(
  'series',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    slug: varchar('slug', { length: 160 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    posterUrl: text('poster_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('series_slug_key').on(t.slug)],
)

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

export const videos = pgTable(
  'videos',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    slug: varchar('slug', { length: 200 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    durationSec: integer('duration_sec'),

    posterUrl: text('poster_url'),
    // Sprite sheet + its WebVTT index drive scrub-bar previews (plan §5.5).
    spriteUrl: text('sprite_url'),
    spriteVttUrl: text('sprite_vtt_url'),
    previewUrl: text('preview_url'), // animated WebP for card hover

    status: videoStatus('status').notNull().default('draft'),
    ageRating: ageRating('age_rating').notNull().default('U'),
    // Content descriptor shown alongside the rating, mandated by IT Rules 2021.
    contentDescriptor: text('content_descriptor'),
    language: varchar('language', { length: 10 }).notNull().default('hi'),

    uploaderId: uuid('uploader_id').references(() => users.id, { onDelete: 'set null' }),
    creatorId: uuid('creator_id').references(() => creators.id, { onDelete: 'set null' }),

    // Where the media actually lives. Lets a Bunny-era library and an R2-era
    // library coexist during migration instead of forcing a big-bang cutover.
    provider: storageProvider('provider').notNull().default('r2'),
    providerAssetId: text('provider_asset_id'),
    // Path relative to the bucket/CDN root, e.g. "v/<id>/master.m3u8".
    hlsMasterPath: text('hls_master_path'),
    sourceSizeBytes: bigint('source_size_bytes', { mode: 'number' }),

    // Denormalised counter. Updated asynchronously from the events rollup —
    // never on the playback path (plan §8).
    viewCount: bigint('view_count', { mode: 'number' }).notNull().default(0),
    likeCount: integer('like_count').notNull().default(0),

    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    /**
     * 'simple' rather than 'english' on purpose: Postgres has no Hindi or
     * Gujarati stemmer, and applying English stemming to transliterated titles
     * makes results worse. Meilisearch takes over when this stops being enough.
     */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '')), 'B')`,
    ),
  },
  (t) => [
    uniqueIndex('videos_slug_key').on(t.slug),
    // The homepage/browse query. Partial so it only indexes live rows.
    index('videos_published_idx')
      .on(t.publishedAt.desc())
      .where(sql`${t.status} = 'published' and ${t.deletedAt} is null`),
    index('videos_language_idx').on(t.language, t.publishedAt.desc()),
    index('videos_creator_idx').on(t.creatorId, t.publishedAt.desc()),
    index('videos_status_idx').on(t.status),
    index('videos_search_idx').using('gin', t.searchVector),
  ],
)

export const videoVariants = pgTable(
  'video_variants',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    // "240p" … "1080p"
    resolution: varchar('resolution', { length: 12 }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bitrateKbps: integer('bitrate_kbps').notNull(),
    // Must match the ladder's real peak, not the target average — the master
    // playlist BANDWIDTH attribute is derived from this and hls.js trusts it.
    peakBitrateKbps: integer('peak_bitrate_kbps').notNull(),
    codec: varchar('codec', { length: 40 }).notNull().default('avc1.640028'),
    playlistPath: text('playlist_path').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Plan §6 omitted this; without it a re-run of the transcode job silently
    // duplicates every rendition and the master playlist lists each twice.
    uniqueIndex('video_variants_video_resolution_key').on(t.videoId, t.resolution),
    index('video_variants_video_idx').on(t.videoId),
  ],
)

export const subtitles = pgTable(
  'subtitles',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    language: varchar('language', { length: 10 }).notNull(),
    label: varchar('label', { length: 60 }).notNull(),
    vttPath: text('vtt_path').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [uniqueIndex('subtitles_video_lang_key').on(t.videoId, t.language)],
)

export const videoCategories = pgTable(
  'video_categories',
  {
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.videoId, t.categoryId] }),
    index('video_categories_category_idx').on(t.categoryId),
  ],
)

export const videoTags = pgTable(
  'video_tags',
  {
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.videoId, t.tagId] }), index('video_tags_tag_idx').on(t.tagId)],
)

export const episodes = pgTable(
  'episodes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    seasonNo: smallint('season_no').notNull().default(1),
    episodeNo: smallint('episode_no').notNull(),
  },
  (t) => [
    uniqueIndex('episodes_series_season_ep_key').on(t.seriesId, t.seasonNo, t.episodeNo),
    uniqueIndex('episodes_video_key').on(t.videoId),
  ],
)

// ---------------------------------------------------------------------------
// Viewer state
// ---------------------------------------------------------------------------

export const watchHistory = pgTable(
  'watch_history',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    positionSec: integer('position_sec').notNull().default(0),
    completed: boolean('completed').notNull().default(false),
    watchedAt: timestamp('watched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Plan §6 declared no key here. Without it, every heartbeat inserts a new
    // row instead of upserting and "Continue Watching" reads garbage.
    primaryKey({ columns: [t.userId, t.videoId] }),
    index('watch_history_user_recent_idx').on(t.userId, t.watchedAt.desc()),
  ],
)

export const watchlist = pgTable(
  'watchlist',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.videoId] }),
    index('watchlist_user_idx').on(t.userId, t.addedAt.desc()),
  ],
)

export const reactions = pgTable(
  'reactions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    type: reactionType('type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.videoId] }),
    index('reactions_video_idx').on(t.videoId, t.type),
  ],
)

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    parentId: uuid('parent_id'),
    body: text('body').notNull(),
    status: commentStatus('status').notNull().default('visible'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('comments_video_idx')
      .on(t.videoId, t.createdAt.desc())
      .where(sql`${t.status} = 'visible'`),
    index('comments_parent_idx').on(t.parentId),
    index('comments_moderation_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
  ],
)

// ---------------------------------------------------------------------------
// Monetisation
// ---------------------------------------------------------------------------

export const adPlacements = pgTable(
  'ad_placements',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: varchar('name', { length: 80 }).notNull(),
    // 'preroll' | 'midroll' | 'display' | 'overlay'
    type: varchar('type', { length: 24 }).notNull(),
    // 'header' | 'sidebar' | 'below_player' | 'in_feed' | offset seconds
    position: varchar('position', { length: 40 }),
    vastUrl: text('vast_url'),
    // Frequency cap: max impressions per session (plan §7 MVP).
    frequencyCap: smallint('frequency_cap'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ad_placements_active_idx').on(t.type).where(sql`${t.active}`)],
)

/**
 * Monthly per-creator revenue attribution. Written by a batch job from the
 * events rollup, not live. Paise as bigint — never float.
 */
export const revenueShares = pgTable(
  'revenue_shares',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'restrict' }),
    periodMonth: varchar('period_month', { length: 7 }).notNull(), // 'YYYY-MM'
    viewCount: bigint('view_count', { mode: 'number' }).notNull().default(0),
    watchSeconds: bigint('watch_seconds', { mode: 'number' }).notNull().default(0),
    grossRevenuePaise: bigint('gross_revenue_paise', { mode: 'number' }).notNull().default(0),
    shareBps: integer('share_bps').notNull(),
    payablePaise: bigint('payable_paise', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('revenue_shares_creator_period_key').on(t.creatorId, t.periodMonth)],
)

export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'restrict' }),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    status: payoutStatus('status').notNull().default('pending'),
    reference: varchar('reference', { length: 120 }),
    // TDS/GST withholding, tracked separately because ad revenue is a taxable
    // supply and creator payments attract TDS (plan §10).
    withheldPaise: bigint('withheld_paise', { mode: 'number' }).notNull().default(0),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payouts_creator_idx').on(t.creatorId, t.createdAt.desc()),
    check('payouts_amount_positive', sql`${t.amountPaise} >= 0`),
  ],
)

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    videoId: uuid('video_id').references(() => videos.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    reporterId: uuid('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    reporterEmail: varchar('reporter_email', { length: 320 }),
    reason: varchar('reason', { length: 60 }).notNull(),
    detail: text('detail'),
    status: reportStatus('status').notNull().default('open'),
    /**
     * IT Rules 2021 gives the Grievance Officer 15 days to resolve a complaint.
     * Storing the deadline explicitly means the overdue queue is a plain index
     * scan rather than something someone has to remember to compute.
     */
    dueAt: timestamp('due_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '15 days'`),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reports_open_due_idx')
      .on(t.dueAt)
      .where(sql`${t.status} in ('open', 'reviewing')`),
    index('reports_video_idx').on(t.videoId),
  ],
)

/**
 * Append-only record of privileged actions. Required in practice for the IT
 * Rules takedown trail: when a 36-hour removal order lands, you must be able to
 * show who removed what and when.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 60 }).notNull(),
    entityType: varchar('entity_type', { length: 40 }).notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: varchar('ip', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entityType, t.entityId, t.createdAt.desc()),
    index('audit_log_actor_idx').on(t.actorId, t.createdAt.desc()),
  ],
)
