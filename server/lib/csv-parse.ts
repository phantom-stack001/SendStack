import { parse } from "csv-parse/sync";

export type ParsedCsv = {
  headers: string[];
  rows: string[][];
};

export function parseCsvText(csvText: string, maxRows: number): ParsedCsv {
  const records = parse(csvText, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }) as string[][];

  if (records.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = records[0].map((cell) => String(cell ?? ""));
  const dataRows = records.slice(1, maxRows + 1);
  return { headers, rows: dataRows };
}

export function getCell(row: string[], headers: string[], columnName: string): string {
  const index = headers.indexOf(columnName);
  if (index < 0) return "";
  return String(row[index] ?? "").trim();
}
