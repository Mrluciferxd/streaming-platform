import { NextResponse } from 'next/server'

import { suggest } from '@/lib/queries/videos'

export const dynamic = 'force-dynamic'

/** Autocomplete for the header search box. */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q') ?? ''

  if (query.trim().length < 2) {
    return NextResponse.json({ items: [] })
  }

  const items = await suggest(query)

  return NextResponse.json(
    { items },
    {
      // Short shared cache: popular prefixes are typed constantly and the
      // result set barely moves between keystrokes.
      headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' },
    },
  )
}
