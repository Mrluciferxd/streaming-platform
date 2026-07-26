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
    <footer className="mt-12 border-t border-neutral-200 py-8 text-sm dark:border-neutral-800">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 sm:px-6">
        <nav className="flex flex-wrap gap-x-5 gap-y-2 text-neutral-500">
          <Link href="/legal/terms" className="hover:text-red-600">
            Terms
          </Link>
          <Link href="/legal/privacy" className="hover:text-red-600">
            Privacy
          </Link>
          <Link href="/legal/copyright" className="hover:text-red-600">
            Copyright / DMCA
          </Link>
          <Link href="/legal/grievance" className="hover:text-red-600">
            Grievance Officer
          </Link>
        </nav>

        <p className="text-xs text-neutral-400">
          Content is self-classified under the IT Rules 2021 (U, U/A 7+, U/A 13+, U/A 16+, A).
          Ratings appear on every title.
        </p>
      </div>
    </footer>
  )
}
