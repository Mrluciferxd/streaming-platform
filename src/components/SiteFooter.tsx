import Link from 'next/link'

/**
 * Footer.
 *
 * The legal links are not filler. IT Rules 2021 requires a publisher of online
 * curated content to publish the Grievance Redressal Officer's name and contact
 * details on the site, and the DPDP Act 2023 requires a privacy notice
 * (plan §10). These routes are stubs until a lawyer drafts the content — the
 * links exist so the requirement stays visible rather than being remembered
 * the week before launch.
 */
export function SiteFooter() {
  return (
    <footer className="mt-8 border-t border-line bg-mist px-4 py-10 text-sm sm:px-12">
      <div className="flex flex-col gap-4">
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-ink-soft">
          <Link href="/legal/terms" className="font-semibold transition hover:text-primary">
            Terms
          </Link>
          <Link href="/legal/privacy" className="font-semibold transition hover:text-primary">
            Privacy
          </Link>
          <Link href="/legal/copyright" className="font-semibold transition hover:text-primary">
            Copyright / DMCA
          </Link>
          <Link href="/legal/grievance" className="font-semibold transition hover:text-primary">
            Grievance Officer
          </Link>
        </nav>

        <p className="max-w-2xl text-xs text-muted">
          Content is self-classified under the IT Rules 2021 (U, U/A 7+, U/A 13+, U/A 16+, A).
          Ratings appear on every title. All series are licensed from their rights holders.
        </p>
      </div>
    </footer>
  )
}
