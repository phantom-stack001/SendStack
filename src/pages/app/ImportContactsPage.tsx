import { useState } from "react";

import { RecipientsNav } from "@/components/recipients/RecipientsNav";
import { PageMeta } from "@/components/layout/PageMeta";
import { AppPageContainer } from "@/components/shared/AppPageContainer";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { importContacts, previewCsvImport } from "@/lib/recipients-api";

type Step = 1 | 2 | 3 | 4 | 5;

export function ImportContactsPage() {
  const [step, setStep] = useState<Step>(1);
  const [csvText, setCsvText] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<string[][]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [mapping, setMapping] = useState<Record<string, string>>({ email: "" });
  const [result, setResult] = useState<Awaited<ReturnType<typeof importContacts>>["result"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    const text = await file.text();
    setCsvText(text);
    setLoading(true);
    try {
      const res = await previewCsvImport(text);
      setHeaders(res.preview.headers);
      setPreviewRows(res.preview.previewRows);
      setTotalRows(res.preview.totalDataRows);
      const emailHeader = res.preview.headers.find((h) => /email/i.test(h)) ?? res.preview.headers[0] ?? "";
      setMapping({
        email: emailHeader,
        firstName: res.preview.headers.find((h) => /first/i.test(h)) ?? "",
        lastName: res.preview.headers.find((h) => /last/i.test(h)) ?? "",
        company: res.preview.headers.find((h) => /company/i.test(h)) ?? "",
        phone: res.preview.headers.find((h) => /phone/i.test(h)) ?? "",
      });
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse CSV");
    } finally {
      setLoading(false);
    }
  };

  const runImport = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await importContacts(csvText, mapping);
      setResult(res.result);
      setStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <PageMeta title="Import contacts | SendStack" description="CSV import." canonicalPath="/app/recipients/import/" />
      <AppPageContainer>
        <PageHeader title="Import contacts" description="Upload a CSV, map columns, and import contacts with validation." />
        <RecipientsNav />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step {step} of 5</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {step === 1 ? (
              <div className="space-y-2">
                <Label htmlFor="csv-file">Upload CSV (UTF-8)</Label>
                <input id="csv-file" className="block w-full max-w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
                <p className="text-xs text-muted-foreground">Max 2MB / 10,000 rows. Imports use unknown consent unless suppressed.</p>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{totalRows} data rows detected. Preview:</p>
                <div className="overflow-x-auto rounded-md border text-xs">
                  <table className="w-full">
                    <thead><tr>{headers.map((h) => <th key={h} className="border-b px-2 py-1 text-left">{h}</th>)}</tr></thead>
                    <tbody>
                      {previewRows.map((row, i) => (
                        <tr key={i}>{row.map((cell, j) => <td key={j} className="border-b px-2 py-1">{cell}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button onClick={() => setStep(3)}>Continue to mapping</Button>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {(["email", "firstName", "lastName", "company", "phone"] as const).map((field) => (
                  <div key={field} className="space-y-1">
                    <Label>{field === "email" ? "Email (required)" : field}</Label>
                    <select
                      className="native-select"
                      value={mapping[field] ?? ""}
                      onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))}
                    >
                      <option value="">— Skip —</option>
                      {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
                <div className="sm:col-span-2 flex gap-2">
                  <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
                  <Button onClick={() => setStep(4)} disabled={!mapping.email}>Review</Button>
                </div>
              </div>
            ) : null}

            {step === 4 ? (
              <div className="space-y-3">
                <p className="text-sm">Ready to import {totalRows} rows. Duplicates will be skipped. Existing suppressions are respected.</p>
                <Button onClick={() => void runImport()} disabled={loading}>{loading ? "Importing…" : "Run import"}</Button>
              </div>
            ) : null}

            {step === 5 && result ? (
              <div className="space-y-2 text-sm">
                <p>Total rows: {result.totalRows}</p>
                <p>Valid rows: {result.validRows}</p>
                <p>Imported: {result.imported}</p>
                <p>Duplicates skipped: {result.duplicates}</p>
                <p>Invalid: {result.invalid}</p>
                <p>Matched suppressions: {result.suppressed}</p>
                {result.errors.length > 0 ? (
                  <ul className="list-disc pl-5 text-destructive">
                    {result.errors.slice(0, 10).map((e) => (
                      <li key={`${e.row}-${e.message}`}>Row {e.row}: {e.message}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </CardContent>
        </Card>
      </AppPageContainer>
    </>
  );
}
