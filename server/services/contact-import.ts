import { and, eq } from "drizzle-orm";

import type { Database } from "../db/index.js";
import { contacts, emailSuppressions } from "../db/schema.js";
import { getCell, parseCsvText } from "../lib/csv-parse.js";
import { isValidEmail, normalizeEmail } from "../lib/email-normalization.js";
import { IMPORT_LIMITS } from "../validation/contact-import.js";
import { CONTACT_LIMITS } from "../validation/contacts.js";

export type ColumnMapping = {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  phone?: string;
};

export function previewCsvImport(csvText: string) {
  const parsed = parseCsvText(csvText, IMPORT_LIMITS.previewRows);
  return {
    headers: parsed.headers,
    previewRows: parsed.rows,
    totalDataRows: parseCsvText(csvText, IMPORT_LIMITS.maxRows).rows.length,
  };
}

export async function executeCsvImport(
  db: Database,
  userId: string,
  csvText: string,
  mapping: ColumnMapping,
) {
  const parsed = parseCsvText(csvText, IMPORT_LIMITS.maxRows);
  const results = {
    totalRows: parsed.rows.length,
    validRows: 0,
    imported: 0,
    duplicates: 0,
    invalid: 0,
    suppressed: 0,
    errors: [] as { row: number; message: string }[],
  };

  const seenInFile = new Set<string>();

  for (let index = 0; index < parsed.rows.length; index += 1) {
    const row = parsed.rows[index];
    const rowNumber = index + 2;
    const rawEmail = getCell(row, parsed.headers, mapping.email);

    if (!rawEmail) {
      results.invalid += 1;
      results.errors.push({ row: rowNumber, message: "Missing email" });
      continue;
    }

    const email = normalizeEmail(rawEmail);
    if (!isValidEmail(email)) {
      results.invalid += 1;
      results.errors.push({ row: rowNumber, message: "Invalid email" });
      continue;
    }

    if (seenInFile.has(email)) {
      results.duplicates += 1;
      continue;
    }
    seenInFile.add(email);

    const [existing] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.email, email)))
      .limit(1);

    if (existing) {
      results.duplicates += 1;
      continue;
    }

    results.validRows += 1;

    const [suppressed] = await db
      .select({ id: emailSuppressions.id })
      .from(emailSuppressions)
      .where(and(eq(emailSuppressions.userId, userId), eq(emailSuppressions.email, email)))
      .limit(1);

    const firstName = mapping.firstName
      ? getCell(row, parsed.headers, mapping.firstName).slice(0, CONTACT_LIMITS.firstNameMax)
      : "";
    const lastName = mapping.lastName
      ? getCell(row, parsed.headers, mapping.lastName).slice(0, CONTACT_LIMITS.lastNameMax)
      : "";
    const company = mapping.company
      ? getCell(row, parsed.headers, mapping.company).slice(0, CONTACT_LIMITS.companyMax)
      : "";
    const phone = mapping.phone
      ? getCell(row, parsed.headers, mapping.phone).slice(0, CONTACT_LIMITS.phoneMax)
      : "";

    const status = suppressed ? "unsubscribed" : "unknown";
    if (suppressed) {
      results.suppressed += 1;
    }

    try {
      await db.insert(contacts).values({
        id: crypto.randomUUID(),
        userId,
        email,
        firstName,
        lastName,
        company,
        phone,
        subscriptionStatus: status,
      });
      results.imported += 1;
    } catch (error) {
      const pgCode = (error as { code?: string }).code;
      if (pgCode === "23505") {
        results.duplicates += 1;
      } else {
        results.invalid += 1;
        results.errors.push({ row: rowNumber, message: "Could not import row" });
      }
    }
  }

  return results;
}
