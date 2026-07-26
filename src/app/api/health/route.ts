import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/db'

export const dynamic = 'force-dynamic'

/**
 * Liveness + dependency check for Uptime Kuma / the load balancer (plan §4).
 * Returns 503 when a hard dependency is down so an unhealthy instance is
 * actually pulled out of rotation instead of quietly serving errors.
 */
export async function GET() {
  const checks: Record<string, 'ok' | string> = {}

  try {
    await db.execute(sql`select 1`)
    checks.database = 'ok'
  } catch (error) {
    checks.database = error instanceof Error ? error.message : 'unknown error'
  }

  const healthy = Object.values(checks).every((v) => v === 'ok')

  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', checks },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
