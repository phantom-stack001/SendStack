import type { EligibilitySummary } from "@/lib/campaigns-api";
import type { RecipientEligibilityExclusion } from "@/lib/campaigns-api";
import { exclusionCategoryRows, exclusionStatusLabel } from "@/lib/campaign-eligibility-ui";

type RecipientEligibilitySummaryProps = {
  summary: EligibilitySummary;
  exclusions?: RecipientEligibilityExclusion[];
  compact?: boolean;
};

export function RecipientEligibilitySummary({
  summary,
  exclusions = [],
  compact = false,
}: RecipientEligibilitySummaryProps) {
  const categories = exclusionCategoryRows(summary);

  return (
    <div className="rounded-md border p-3" role="region" aria-label="Recipient eligibility">
      <p className="font-medium">Recipient eligibility</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Selected contacts (raw)</dt>
          <dd className="font-medium tabular-nums">{summary.selectedRaw}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Unique addresses</dt>
          <dd className="font-medium tabular-nums">{summary.uniqueEmails}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Eligible</dt>
          <dd className="font-medium tabular-nums text-primary">{summary.eligible}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Excluded</dt>
          <dd className="font-medium tabular-nums">{summary.excludedTotal}</dd>
        </div>
        {summary.duplicates > 0 && (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">Duplicates removed</dt>
            <dd className="font-medium tabular-nums">{summary.duplicates}</dd>
          </div>
        )}
      </dl>

      {categories.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Exclusion categories
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {categories.map((row) => (
              <li key={row.key} className="flex justify-between gap-4">
                <span>{row.label}</span>
                <span className="tabular-nums text-muted-foreground">{row.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!compact && exclusions.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Excluded addresses
          </p>
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm">
            {exclusions.map((row) => (
              <li key={`${row.email}-${row.eligibilityStatus}`} className="flex flex-wrap gap-x-2">
                <span>{row.email}</span>
                <span className="text-muted-foreground">
                  — {exclusionStatusLabel(row.eligibilityStatus)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.selectedRaw > 0 && summary.eligible === 0 && (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          Selected contacts must have valid permission and must not be unsubscribed or suppressed.
        </p>
      )}
    </div>
  );
}
