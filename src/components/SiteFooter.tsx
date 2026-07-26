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
    <footer className="border-t border-white/10 bg-[#141414] px-4 py-10 text-sm sm:px-12">
      <div className="flex flex-col gap-4">
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-[#808080]">
          <Link href="/legal/terms" className="hover:text-white">
            Terms
          </Link>
          <Link href="/legal/privacy" className="hover:text-white">
            Privacy
          </Link>
          <Link href="/legal/copyright" className="hover:text-white">
            Copyright / DMCA
          </Link>
          <Link href="/legal/grievance" className="hover:text-white">
            Grievance Officer
          </Link>
        </nav>

        <p className="max-w-2xl text-xs text-[#6d6d6d]">
          Content is self-classified under the IT Rules 2021 (U, U/A 7+, U/A 13+, U/A 16+, A).
          Ratings appear on every title.
        </p>
      </div>
    </footer>
  )
}
