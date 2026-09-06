/**
 * /audit/[runId]/binder — the workpaper binder for one run.
 *
 * A printable document, not a dashboard: cover sheet, one workpaper section
 * per sample in sample order, the fix list ranked by amount, and the tickmark
 * legend. Everything on it is assembled by src/lib/binder from rows that
 * already exist; this file only lays it out.
 *
 * The print rules at the bottom exist because the app shell is a fixed-height,
 * overflow-hidden screen layout. Without them the browser prints one page and
 * clips the rest.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { memoryResolvedIds } from "@/lib/accountant/memory";
import { buildBinder, loadRunInputs, TICKMARKS, type BinderSection, type BinderView, type FixItem } from "@/lib/binder";
import { formatMoney, getRun, type MessageView } from "@/lib/referee/data";
import type { Citation } from "@/lib/referee/evidence-types";
import { PrintButton } from "./_components/print-button";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  auditor: "Auditor",
  accountant: "Accountant",
  referee: "Controller",
};

export default async function BinderPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;

  let run;
  try {
    run = await getRun(runId);
  } catch (error) {
    console.error("[binder] loading run failed", { runId, error });
    return <Unavailable runId={runId} />;
  }
  if (!run) notFound();

  const extras = await loadRunInputs(run.id).catch(() => ({}));
  const memoryResolved = await memoryResolvedIds(run.id);
  const binder = buildBinder(run, { ...extras, memoryResolved });

  return (
    <main className="h-full overflow-y-auto bg-paper-2 print:h-auto print:overflow-visible print:bg-paper">
      <PrintRules />

      <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-line bg-paper/95 py-2.5 pl-[var(--shell-header-left,1rem)] pr-4 backdrop-blur print:hidden">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">Binder · {binder.run.name}</div>
          <div className="font-mono text-[11px] text-ink-3 num">
            {binder.sections.length} workpapers · {binder.counts.exceptions} exceptions ·{" "}
            {binder.counts.awaiting} awaiting a ruling
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link className="btn" href={`/audit/${encodeURIComponent(binder.run.id)}`}>
            Back to run
          </Link>
          <PrintButton />
        </div>
      </div>

      <div className="mx-auto w-full max-w-[54rem] space-y-3 px-6 py-6 print:max-w-none print:space-y-0 print:px-0 print:py-0">
        <Cover binder={binder} />
        {binder.sections.map((section) => (
          <Workpaper key={section.sampleId} section={section} />
        ))}
        <FixList binder={binder} />
        <Legend />
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- cover sheet

function Cover({ binder }: { binder: BinderView }) {
  const { run } = binder;
  return (
    <Sheet>
      <div className="border-b border-line pb-4">
        <div className="text-[11px] tracking-[0.04em] text-ink-3">Audit binder</div>
        <h1 className="mt-1 text-[19px] font-semibold tracking-tight">{binder.company}</h1>
        <div className="text-[13px] text-ink-2">{binder.period}</div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2.5 text-[12.5px] sm:grid-cols-3">
        <Field label="Run" value={`${run.name}`} />
        <Field label="Run id" value={run.kind === "real" ? `#${run.id}` : "walkthrough"} mono />
        <Field label="Started" value={run.startedAt ? formatDate(run.startedAt) : "—"} />
        <Field label="Seed" value={run.seed === undefined ? "—" : String(run.seed)} mono />
        <Field
          label="Materiality"
          value={run.materiality === undefined ? "—" : formatMoney(run.materiality / 100)}
          mono
        />
        <Field label="Sample size" value={run.sampleSize === undefined ? "—" : String(run.sampleSize)} mono />
        <Field label="Cycles" value={run.cycles?.join(", ") ?? "—"} />
        <Field label="Prepared by" value="Crossfire — auditor and accountant agents" />
        <Field label="Reviewed by" value={binder.controller} />
        <Field label="Printed" value={formatDate(new Date())} />
      </dl>

      <div className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 sm:grid-cols-4">
        <Stat label="Samples" value={String(binder.coverage.total)} />
        <Stat label="Coverage" value={`${binder.coverage.percent}%`} hint={`${binder.coverage.defended} defended`} />
        <Stat
          label="Exceptions"
          value={String(binder.counts.exceptions)}
          hint={binder.totals.fixListCents ? formatCents(binder.totals.fixListCents) : undefined}
        />
        <Stat
          label="Awaiting a ruling"
          value={String(binder.counts.awaiting)}
          hint={binder.totals.awaitingCents ? formatCents(binder.totals.awaitingCents) : undefined}
        />
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-ink-2">
        Each workpaper below records one sampled transaction: the procedure it was tested under, the
        assertion that procedure supports, the auditor&apos;s question, the accountant&apos;s answer with
        every row it cites, and how the item was disposed of. Nothing on this page is written by a
        model: the transcript is quoted, the citations are rows, and the proposed entries come from a
        fixed table keyed by the kind of gap found.
      </p>
    </Sheet>
  );
}

// ----------------------------------------------------------------- workpapers

function Workpaper({ section }: { section: BinderSection }) {
  return (
    <Sheet newPage>
      <header className="flex items-baseline justify-between gap-4 border-b border-line pb-2.5 print:break-inside-avoid">
        <div className="min-w-0">
          <div className="font-mono text-[11px] text-ink-3 num">
            {section.ref}
            <span className="mx-2 text-line-2">|</span>
            {section.sampleId}
            <span className="mx-2 text-line-2">|</span>
            {section.date || "no date"}
          </div>
          <h2 className="truncate text-[14px] font-medium">{section.label}</h2>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[14px] num">{section.amount}</div>
          <div className="font-mono text-[13px]" aria-hidden>
            {section.tickmark}
          </div>
        </div>
      </header>

      <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 text-[12.5px] sm:grid-cols-2">
        <Field label="Procedure" value={section.procedure} />
        <Field label="Assertion tested" value={section.assertion} />
      </dl>

      <Section title="Exchange">
        <ol className="space-y-3">
          {section.thread.map((message, i) => (
            <li key={`${message.turn}-${message.role}-${i}`}>
              <Turn message={message} />
            </li>
          ))}
          {section.thread.length === 0 ? (
            <li className="text-[12.5px] text-ink-3">Nothing was asked about this sample.</li>
          ) : null}
        </ol>
      </Section>

      <Section title={`Evidence cited (${section.citations.length})`}>
        {section.citations.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">The accountant cited nothing.</p>
        ) : (
          <ol className="space-y-1.5 text-[12.5px]">
            {section.citations.map((citation, i) => (
              <li key={`${citation.table}-${citation.id}-${citation.field}-${i}`} className="grid grid-cols-[1.6rem_minmax(0,1fr)]">
                <span className="font-mono text-[11.5px] text-ink-3 num">{i + 1}.</span>
                <CitationLine citation={citation} />
              </li>
            ))}
          </ol>
        )}
      </Section>

      {section.gaps.length > 0 ? (
        <Section title="Gaps">
          <ul className="space-y-1.5 text-[12.5px]">
            {section.gaps.map((gap, i) => (
              <li key={`${gap.kind}-${i}`} className="grid grid-cols-[1.6rem_minmax(0,1fr)]">
                <span className="font-mono" aria-hidden>
                  △
                </span>
                <span>
                  <span className="font-mono text-[11.5px] text-ink-2">{gap.kind}</span>
                  <span className="ml-2">{gap.description}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Disposition">
        <p className="text-[12.5px] leading-relaxed">
          <span className="mr-2 font-mono" aria-hidden>
            {section.tickmark}
          </span>
          {section.disposition}
        </p>
        {section.ruling?.note ? (
          <p className="mt-2 border-l-2 border-line pl-3 text-[12.5px] leading-relaxed text-ink-2">
            Controller&apos;s note: {section.ruling.note}
          </p>
        ) : null}
      </Section>

      {section.entry ? (
        <Section title="Proposed adjusting entry">
          <Entry entry={section.entry} />
        </Section>
      ) : null}
    </Sheet>
  );
}

function Turn({ message }: { message: MessageView }) {
  return (
    <article className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3">
      <div>
        <div className="text-[12px] font-medium">{ROLE_LABEL[message.role] ?? message.role}</div>
        <div className="font-mono text-[11px] text-ink-3 num">turn {message.turn}</div>
      </div>
      <div>
        <p className="text-[12.5px] leading-relaxed">{message.content}</p>
        {message.role === "accountant" ? <Provenance message={message} /> : null}
      </div>
    </article>
  );
}

/**
 * Where the accountant's paragraph came from. A workpaper that quotes an agent
 * has to say whether a model wrote the sentence or the app assembled it from
 * the rows, because a reviewer's confidence in the prose is not the same in
 * both cases. The citations underneath are identical either way.
 */
function Provenance({ message }: { message: MessageView }) {
  const source = message.evidence?.defenseSource;
  if (!source) return null;
  return (
    <p className="mt-1 text-[11px] text-ink-3">
      {source.source === "model"
        ? "Written by the model over the rows cited below."
        : `Assembled from the gathered rows${source.reason ? ` — ${source.reason}` : ""}.`}
    </p>
  );
}

function CitationLine({ citation }: { citation: Citation }) {
  return (
    <span>
      <span className="font-mono text-[11.5px] num">
        [{citation.table}#{citation.id}]
      </span>{" "}
      <span className="font-mono text-[11.5px] text-ink-2">{citation.field}</span>
      {" = "}
      <span className="font-mono num">{citation.value === "" ? "(empty)" : citation.value}</span>
      <span className="text-ink-2"> — {citation.reason}</span>
      {citation.filePath ? (
        <>
          {" "}
          <a
            href={fileUrl(citation.filePath)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] underline underline-offset-2"
          >
            {citation.filePath.split("/").pop()}
          </a>
        </>
      ) : null}
    </span>
  );
}

function Entry({ entry }: { entry: NonNullable<BinderSection["entry"]> }) {
  // The basis often cites the same row three times over — amount, reference,
  // counterparty. A reader needs the row, once.
  const basis = [...new Set(entry.basis.map((c) => `[${c.table}#${c.id}]`))];
  return (
    <div className="rounded-lg border border-line print:break-inside-avoid print:rounded-none">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-line text-left text-[11px] tracking-[0.04em] text-ink-3">
            <th className="px-3 py-1.5 font-normal">Account</th>
            <th className="px-3 py-1.5 text-right font-normal">Debit</th>
            <th className="px-3 py-1.5 text-right font-normal">Credit</th>
          </tr>
        </thead>
        <tbody className="num">
          <tr className="border-b border-line">
            <td className="px-3 py-1.5">{entry.debit}</td>
            <td className="px-3 py-1.5 text-right font-mono">{entry.amount}</td>
            <td className="px-3 py-1.5 text-right font-mono text-ink-3">—</td>
          </tr>
          <tr>
            <td className="px-3 py-1.5 pl-6">{entry.credit}</td>
            <td className="px-3 py-1.5 text-right font-mono text-ink-3">—</td>
            <td className="px-3 py-1.5 text-right font-mono">{entry.amount}</td>
          </tr>
        </tbody>
      </table>
      <div className="border-t border-line px-3 py-2 text-[12px] text-ink-2">
        <p>{entry.memo}</p>
        <p className="mt-1">
          Amount is {entry.amountSource}
          {entry.fellBack
            ? ", taken from the sampled row because the citations this rule needs were not on the bundle"
            : ""}
          .
        </p>
        {basis.length > 0 ? (
          <p className="mt-1 font-mono text-[11px]">Basis: {basis.join(" ")}</p>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ fix list

function FixList({ binder }: { binder: BinderView }) {
  return (
    <Sheet newPage>
      <h2 className="text-[15px] font-semibold tracking-tight">Fix list</h2>
      <p className="mt-1 text-[12.5px] text-ink-2">
        Every exception the controller ruled on, largest first, with the remedy and the entry that
        corrects it. Gaps the controller has not ruled on are listed separately: they are outstanding
        work, not findings.
      </p>

      <h3 className="mt-4 text-[12.5px] font-medium">
        Exceptions ({binder.fixList.length})
        {binder.totals.fixListCents ? (
          <span className="ml-2 font-mono text-[12px] text-ink-2 num">
            {formatCents(binder.totals.fixListCents)}
          </span>
        ) : null}
      </h3>
      <FixTable items={binder.fixList} empty="The controller has not recorded an exception on this run." />

      <h3 className="mt-5 text-[12.5px] font-medium">
        Gaps awaiting a ruling ({binder.awaiting.length})
        {binder.totals.awaitingCents ? (
          <span className="ml-2 font-mono text-[12px] text-ink-2 num">
            {formatCents(binder.totals.awaitingCents)}
          </span>
        ) : null}
      </h3>
      <FixTable items={binder.awaiting} empty="Every gap on this run has been ruled on." />
    </Sheet>
  );
}

function FixTable({ items, empty }: { items: FixItem[]; empty: string }) {
  if (items.length === 0) return <p className="mt-2 text-[12.5px] text-ink-3">{empty}</p>;
  return (
    <table className="mt-2 w-full text-[12.5px]">
      <thead>
        <tr className="border-b border-line text-left text-[11px] tracking-[0.04em] text-ink-3">
          <th className="py-1.5 pr-3 font-normal">Ref</th>
          <th className="py-1.5 pr-3 font-normal">Item</th>
          <th className="py-1.5 pr-3 font-normal">Finding</th>
          <th className="py-1.5 pr-3 font-normal">Remedy</th>
          <th className="py-1.5 text-right font-normal">Amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.sampleId} className="border-b border-line align-top last:border-0">
            <td className="py-2 pr-3 font-mono text-[11.5px] num">{item.ref}</td>
            <td className="py-2 pr-3">
              <div>{item.label}</div>
              <div className="font-mono text-[11px] text-ink-3 num">{item.sampleId}</div>
            </td>
            <td className="py-2 pr-3">
              <div className="font-mono text-[11.5px]">{item.gapKind}</div>
              <div className="text-ink-2">{item.entry.memo}</div>
              {item.note ? <div className="mt-1 text-ink-2">Note: {item.note}</div> : null}
            </td>
            <td className="py-2 pr-3">{item.remedyLabel ?? "Not yet ruled"}</td>
            <td className="py-2 text-right font-mono num">{item.amount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// -------------------------------------------------------------------- legend

function Legend() {
  return (
    <Sheet newPage>
      <h2 className="text-[13px] font-medium">Tickmark legend</h2>
      <dl className="mt-2 space-y-1.5 text-[12.5px]">
        {TICKMARKS.map((t) => (
          <div key={t.mark} className="grid grid-cols-[1.6rem_minmax(0,1fr)]">
            <dt className="font-mono" aria-hidden>
              {t.mark}
            </dt>
            <dd className="text-ink-2">{t.meaning}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[12px] text-ink-3">
        Bracketed references such as [invoices#15] are table names and row ids in the books this run
        was drawn from. Documents are served from the same rows at /api/files.
      </p>
    </Sheet>
  );
}

// ------------------------------------------------------------------ plumbing

/**
 * One panel on screen, one sheet of paper in print.
 *
 * `newPage` starts the sheet on a fresh page rather than trying to keep it
 * whole: a workpaper with a long transcript is taller than a page, and
 * break-inside-avoid on something that cannot fit pushes it wholesale and
 * leaves the page before it half empty. The blocks inside are what get kept
 * together, since those really do fit.
 */
function Sheet({ children, newPage }: { children: React.ReactNode; newPage?: boolean }) {
  return (
    <section
      className={`rounded-xl border border-line bg-paper px-7 py-6 shadow-[0_5px_18px_rgba(0,0,0,0.045)] print:rounded-none print:border-0 print:px-0 print:py-0 print:shadow-none ${
        newPage ? "print:break-before-page" : ""
      }`}
    >
      {children}
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 print:mt-3">
      <h3 className="mb-1.5 text-[11px] tracking-[0.04em] text-ink-3">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd className={mono ? "font-mono num" : undefined}>{value}</dd>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="font-mono text-[16px] num">{value}</div>
      {hint ? <div className="font-mono text-[11px] text-ink-3 num">{hint}</div> : null}
    </div>
  );
}

function Unavailable({ runId }: { runId: string }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-8 py-10">
      <h1 className="text-[15px] font-semibold">Binder {runId} could not be loaded</h1>
      <p className="mt-2 text-[13px] text-ink-2">
        Reading the run failed. The details are in the server log.
      </p>
    </main>
  );
}

function formatCents(cents: number): string {
  return formatMoney(cents / 100);
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(date);
}

// file_path values are repo-relative, e.g. "data/invoices/STR-2025-05.pdf".
function fileUrl(filePath: string): string {
  const relative = filePath.replace(/^\/?data\//, "");
  return `/api/files/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Print rules, scoped to this route by living in its markup.
 *
 * The app shell is `h-screen overflow-hidden` with a fixed sidebar, which
 * prints as a single clipped page. These rules unwind that for print only:
 * the shell scrolls the binder on screen and lets it flow across pages on
 * paper. print-color-adjust keeps the tickmarks and rules from being dropped
 * by the browser's "background graphics off" default.
 */
function PrintRules() {
  return (
    <style>{`
      @media print {
        @page { size: letter; margin: 12mm; }
        html, body { background: #fff !important; }
        body > div,
        body > div > div {
          height: auto !important;
          max-height: none !important;
          overflow: visible !important;
          padding-left: 0 !important;
        }
        #primary-sidebar,
        button[aria-controls="primary-sidebar"] { display: none !important; }
        * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        a[href^="/api/files"]::after { content: " (" attr(href) ")"; font-size: 9px; color: #89948d; }
      }
    `}</style>
  );
}
