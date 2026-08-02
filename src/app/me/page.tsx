import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { and, desc, eq } from 'drizzle-orm'

import { Row, TitleGrid } from '@/components/Row'
import { db, users, videos, watchlist } from '@/db'
import { publiclyVisible } from '@/lib/queries/visibility'
import { getSessionUser } from '@/lib/auth/session'
import {
  listContinueWatching,
  listRecentHistory,
} from '@/lib/queries/history'
import type { VideoCard } from '@/lib/queries/videos'
import { getVideoProvider } from '@/lib/video'
import { SignOutButton } from './SignOutButton'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your account',
  // Per-viewer, no public value, never indexed.
  robots: { index: false, follow: false },
}

function maskEmail(email: string | null): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at <= 0) return email
  const local = email.slice(0, at)
  const domain = email.slice(at)
  // Reveal the first char of the local part and hide the rest, so a viewer
  // can confirm "yes that is my address" without the full string sitting in
  // an HTML response. Same posture as the existing masked-PII handling.
  const head = local.slice(0, 1)
  const tail = local.length > 1 ? '•'.repeat(Math.min(local.length - 1, 6)) : ''
  return `${head}${tail}${domain}`
}

export default async function AccountPage() {
  const session = await getSessionUser()
  if (!session) redirect('/account?next=%2Fme')

  // The session carries the bare minimum for the header; the dashboard wants
  // membership date and avatar, which only the row has. One keyed read.
  const [row] = await db
    .select({
      displayName: users.displayName,
      email: users.email,
      role: users.role,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1)

  // A soft-deleted user keeps a live session row but must not see a dashboard.
  if (!row) redirect('/account?next=%2Fme')

  const [continueWatching, recent, listRows] = await Promise.all([
    listContinueWatching(session.id, 20),
    listRecentHistory(session.id, 20),
    db
      .select({
        id: videos.id,
        slug: videos.slug,
        title: videos.title,
        durationSec: videos.durationSec,
        posterUrl: videos.posterUrl,
        portraitUrl: videos.portraitUrl,
        previewUrl: videos.previewUrl,
        language: videos.language,
        ageRating: videos.ageRating,
        hasSub: videos.hasSub,
        hasDub: videos.hasDub,
        seasonLabel: videos.seasonLabel,
        score: videos.score,
        viewCount: videos.viewCount,
        publishedAt: videos.publishedAt,
      })
      .from(watchlist)
      .innerJoin(videos, eq(videos.id, watchlist.videoId))
      .where(and(eq(watchlist.userId, session.id), publiclyVisible))
      .orderBy(desc(watchlist.addedAt))
      .limit(20),
  ])

  const provider = await getVideoProvider()
  const myList: VideoCard[] = listRows.map((r) => ({
    ...r,
    posterUrl: r.posterUrl ? provider.publicUrl(r.posterUrl) : null,
    portraitUrl: r.portraitUrl ? provider.publicUrl(r.portraitUrl) : null,
    previewUrl: r.previewUrl ? provider.publicUrl(r.previewUrl) : null,
  }))

  const memberSince = row.createdAt.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
  })

  return (
    <div className="px-4 pt-[100px] pb-16 sm:px-12">
      {/* Profile header */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-secondary text-xl font-extrabold text-white shadow-lg shadow-primary/30">
          {session.displayName.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-extrabold tracking-tight sm:text-3xl">
            {session.displayName}
          </h1>
          <p className="mt-0.5 text-sm text-ink-soft">
            {maskEmail(row.email)} · member since {memberSince}
          </p>
        </div>
        <SignOutButton />
      </div>

      {/* Continue Watching */}
      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-lg font-extrabold tracking-tight">
            Continue watching
          </h2>
        </div>
        {continueWatching.length > 0 ? (
          <Row title="Continue watching" videos={continueWatching.map(toVideoCard)} />
        ) : (
          <div className="rounded-2xl bg-mist px-6 py-10 text-center text-sm text-ink-soft">
            Nothing in progress.{' '}
            <Link href="/" className="font-bold text-primary hover:underline">
              Start something
            </Link>
          </div>
        )}
      </section>

      {/* My List */}
      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-lg font-extrabold tracking-tight">
            My List
          </h2>
          <Link
            href="/my-list"
            className="text-sm font-semibold text-ink-soft transition hover:text-primary"
          >
            See all
          </Link>
        </div>
        {myList.length > 0 ? (
          <TitleGrid videos={myList} />
        ) : (
          <div className="rounded-2xl bg-mist px-6 py-10 text-center text-sm text-ink-soft">
            Your list is empty. Tap the bookmark on any title to save it here.
          </div>
        )}
      </section>

      {/* Recently watched */}
      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-lg font-extrabold tracking-tight">
            Recently watched
          </h2>
        </div>
        {recent.length > 0 ? (
          <ul className="divide-y divide-line">
            {recent.map((item) => (
              <li key={item.id} className="flex items-center gap-4 py-3">
                <Link
                  href={`/watch/${item.slug}`}
                  className="flex min-w-0 flex-1 items-center gap-4"
                >
                  <div
                    className="h-16 w-28 shrink-0 overflow-hidden rounded-lg bg-mist ring-1 ring-line"
                    style={
                      item.portraitUrl
                        ? { backgroundImage: `url(${item.portraitUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                        : undefined
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-ink">{item.title}</p>
                    <p className="mt-0.5 text-xs text-ink-soft">
                      {item.completed
                        ? 'Finished'
                        : `${Math.round(item.progress * 100)}% · ${formatPosition(item.positionSec)}`}
                    </p>
                  </div>
                </Link>
                <span className="shrink-0 text-xs text-muted">
                  {formatDate(item.watchedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-2xl bg-mist px-6 py-10 text-center text-sm text-ink-soft">
            No watch history yet.{' '}
            <Link href="/" className="font-bold text-primary hover:underline">
              Browse the catalogue
            </Link>
          </div>
        )}
      </section>
    </div>
  )
}

function formatPosition(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s in`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s > 0 ? `${m}m ${s}s in` : `${m}m in`
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Adapt a ContinueWatchingItem to the wider VideoCard shape the Row component
 * is typed against, without re-querying columns the rail never renders.
 *
 * TitleCard consumes portrait/poster art, slug/title, sub/dub flags, score,
 * season label, runtime and rating — none of language, viewCount, publishedAt
 * or previewUrl. The Continue Watching query deliberately selects only what
 * the resume rail needs (it is also returned by /api/history, so widening it
 * would bloat the player payload). The defaults below are inert values that
 * keep TitleCard rendering without branching on null.
 */
function toVideoCard(item: {
  id: string
  slug: string
  title: string
  durationSec: number | null
  posterUrl: string | null
  portraitUrl: string | null
  ageRating: string
  hasSub: boolean
  hasDub: boolean
  seasonLabel: string | null
  score: number | null
}): VideoCard {
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    durationSec: item.durationSec,
    posterUrl: item.posterUrl,
    portraitUrl: item.portraitUrl,
    previewUrl: null,
    language: '',
    ageRating: item.ageRating,
    hasSub: item.hasSub,
    hasDub: item.hasDub,
    seasonLabel: item.seasonLabel,
    score: item.score,
    viewCount: 0,
    publishedAt: null,
  }
}
