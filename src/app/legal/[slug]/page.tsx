import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { ReportForm } from '@/components/ReportForm'

/**
 * Legal pages.
 *
 * These are placeholders with the required *structure* and the operator details
 * left as `[…]` blanks — not finished policies. Plan §10 budgets ₹25,000–50,000
 * for a lawyer to draft them properly, and that is the right call: a copied
 * privacy policy is worse than none under the DPDP Act, because it documents
 * commitments the operator has not actually implemented.
 *
 * What matters today is that the routes exist and the obligations are written
 * down where whoever fills them in will see them. The footer linked here from
 * the start and every link 404'd.
 */

type Section = { heading: string; body: string[] }
type Doc = { title: string; updated: string; intro: string; sections: Section[] }

const OPERATOR = '[Registered business name]'

const DOCS: Record<string, Doc> = {
  terms: {
    title: 'Terms of Service',
    updated: 'Draft — not yet reviewed by counsel',
    intro: `These terms govern use of this service, operated by ${OPERATOR}. They are a working draft and must be reviewed by a lawyer before launch.`,
    sections: [
      {
        heading: '1. Eligibility and accounts',
        body: [
          'You must be old enough to consent under the Digital Personal Data Protection Act 2023 to hold an account. Viewers below that age require verifiable parental consent.',
          'You are responsible for activity on your account and for keeping your credentials secure.',
        ],
      },
      {
        heading: '2. Content and licensing',
        body: [
          `All titles on this service are licensed from their rights holders or owned by ${OPERATOR}. Nothing here may be downloaded, redistributed, publicly performed, or re-uploaded elsewhere.`,
          'Circumventing access controls, scraping the catalogue, or capturing streams is a breach of these terms and of the Copyright Act 1957.',
        ],
      },
      {
        heading: '3. Content classification',
        body: [
          'Every title is self-classified under the Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules 2021 into one of five categories: U, U/A 7+, U/A 13+, U/A 16+, and A.',
          'The rating and any content descriptor are displayed before playback. Titles rated U/A 13+ and above are subject to parental controls; A-rated titles require age verification.',
        ],
      },
      {
        heading: '4. Advertising',
        body: [
          'This service is funded by advertising. Ads may appear before and during playback and alongside the catalogue.',
        ],
      },
      {
        heading: '5. Termination',
        body: [
          'Accounts may be suspended for breach of these terms, including piracy, circumvention, and abuse of other viewers.',
        ],
      },
      {
        heading: '6. Governing law',
        body: ['These terms are governed by the laws of India. [Jurisdiction — city].'],
      },
    ],
  },

  privacy: {
    title: 'Privacy Policy',
    updated: 'Draft — not yet reviewed by counsel',
    intro:
      'This notice explains what personal data is collected and why, as required by the Digital Personal Data Protection Act 2023.',
    sections: [
      {
        heading: 'What is collected',
        body: [
          'Account data: email address, and phone number where provided.',
          'Playback data: what was watched, for how long, and at what quality. This is used to power Continue Watching, recommendations, and aggregate reporting.',
          'Technical data: IP address, device and browser type, needed to deliver video and to detect fraud and invalid traffic.',
        ],
      },
      {
        heading: 'Why it is collected',
        body: [
          'To deliver the service, remember your place in a title, keep your list, measure what is watched, and sell advertising against aggregate audience data.',
          'Playback telemetry is aggregated into daily totals; raw event records are retained for 35 days and then deleted.',
        ],
      },
      {
        heading: 'Your rights under the DPDP Act 2023',
        body: [
          'You may request access to your personal data, correction of it, and its erasure.',
          'You may withdraw consent at any time. Withdrawal does not affect processing already carried out.',
          'You may nominate another individual to exercise these rights on your behalf.',
          'Requests: [privacy contact email]. Responses within the statutory period.',
        ],
      },
      {
        heading: 'Sharing',
        body: [
          'Advertising partners receive aggregate audience data, not your identity.',
          'Infrastructure providers process data on our instruction: [hosting], [CDN and storage], [analytics].',
        ],
      },
      {
        heading: 'Cookies',
        body: [
          'Strictly necessary cookies hold your session and your playback authorisation. Non-essential cookies are set only with consent.',
        ],
      },
    ],
  },

  copyright: {
    title: 'Copyright and Takedown',
    updated: 'Draft — not yet reviewed by counsel',
    intro:
      'How to report content on this service that infringes your copyright, under the Copyright Act 1957 and the IT Rules 2021.',
    sections: [
      {
        heading: 'Filing a notice',
        body: [
          'Send a written notice to the designated agent below including: identification of the work, the URL of the material complained of, your contact details, a statement that you hold the rights or are authorised to act, and a statement that the notice is accurate.',
          'Designated agent: [name] · [email] · [postal address].',
        ],
      },
      {
        heading: 'What happens next',
        body: [
          'Valid notices are actioned and the material is disabled. The uploader is notified and may file a counter-notice.',
          'Content subject to a valid court order or government direction is removed within 36 hours, as required by the IT Rules 2021.',
        ],
      },
      {
        heading: 'Repeat infringers',
        body: ['Accounts that repeatedly infringe are terminated.'],
      },
    ],
  },

  grievance: {
    title: 'Grievance Redressal',
    updated: 'Draft — officer not yet appointed',
    intro:
      'As a publisher of online curated content, this service operates the three-tier grievance mechanism required by the IT Rules 2021.',
    sections: [
      {
        heading: 'Level I — Grievance Officer',
        body: [
          'Name: [Grievance Officer name — must be resident in India]',
          'Email: [grievance email] · Phone: [contact number]',
          'Address: [Indian postal address]',
          'Complaints are acknowledged within 24 hours and resolved within 15 days, as the Rules require.',
        ],
      },
      {
        heading: 'Level II — Self-regulatory body',
        body: [
          'If you are not satisfied with the Level I outcome, you may escalate to the self-regulatory body this service is a member of: [industry body name and contact].',
        ],
      },
      {
        heading: 'Level III — Oversight mechanism',
        body: [
          'Beyond Level II, the Inter-Departmental Committee constituted by the Ministry of Information and Broadcasting provides oversight.',
        ],
      },
      {
        heading: 'What you can raise here',
        body: [
          'Content classification you believe is wrong, content that breaches the Code of Ethics, accessibility problems, and any complaint about how your personal data has been handled.',
        ],
      },
    ],
  },
}

type Props = { params: Promise<{ slug: string }> }

export function generateStaticParams() {
  return Object.keys(DOCS).map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = DOCS[(await params).slug]
  if (!doc) return { title: 'Not found' }

  return {
    title: doc.title,
    // Placeholder policies must not be indexed — a search result promising a
    // privacy policy that turns out to be a template is worse than no result.
    robots: { index: false, follow: false },
  }
}

export default async function LegalPage({ params }: Props) {
  const { slug } = await params
  const doc = DOCS[slug]
  if (!doc) notFound()

  return (
    <article className="mx-auto max-w-3xl px-4 pt-28 pb-16 sm:px-8">
      <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
        {doc.title}
      </h1>

      <p className="mt-2 inline-block rounded-full bg-primary-soft px-3 py-1 text-xs font-bold text-primary">
        {doc.updated}
      </p>

      <p className="mt-5 text-sm leading-relaxed text-ink-soft">{doc.intro}</p>

      {doc.sections.map((section) => (
        <section key={section.heading} className="mt-8">
          <h2 className="font-display text-lg font-bold tracking-tight">{section.heading}</h2>
          {section.body.map((paragraph) => (
            <p key={paragraph} className="mt-2 text-sm leading-relaxed text-ink-soft">
              {paragraph}
            </p>
          ))}
        </section>
      ))}

      {/* The grievance page carries the public intake form — the Rules require
          a way to file, not just a contact address. */}
      {slug === 'grievance' ? <ReportForm /> : null}

      <p className="mt-12 rounded-2xl bg-mist p-4 text-xs leading-relaxed text-muted">
        Every <code className="font-semibold">[bracketed]</code> value above is a blank that must be
        filled before launch, and the whole document needs review by a lawyer qualified in Indian
        media and data-protection law. Publishing it as-is would be a compliance risk, not a
        compliance measure.
      </p>
    </article>
  )
}

