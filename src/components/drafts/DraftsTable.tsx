import { Link } from "react-router-dom";

import { DraftActions } from "@/components/drafts/DraftActions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { draftDisplaySubject } from "@/lib/email-content";
import type { Draft } from "@/lib/drafts-api";

type DraftsTableProps = {
  drafts: Draft[];
  onDelete: (draft: Draft) => void;
};

function formatDate(iso: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function senderLabel(draft: Draft) {
  const name = draft.senderName.trim();
  const email = draft.senderEmail.trim();
  if (name && email) return `${name} <${email}>`;
  return name || email || "—";
}

export function DraftsTable({ drafts, onDelete }: DraftsTableProps) {
  return (
    <>
      <ul className="divide-y md:hidden">
        {drafts.map((draft) => (
          <li key={draft.id} className="space-y-2 px-4 py-3">
            <Link to={`/app/compose/${draft.id}/`} className="block font-medium wrap-break-word hover:text-primary hover:underline">
              {draftDisplaySubject(draft.subject)}
            </Link>
            <p className="text-sm wrap-break-word text-muted-foreground">{senderLabel(draft)}</p>
            <p className="text-xs text-muted-foreground">Updated {formatDate(draft.updatedAt)}</p>
            <DraftActions draftId={draft.id} onDelete={() => onDelete(draft)} />
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Subject</TableHead>
          <TableHead className="hidden md:table-cell">Sender</TableHead>
          <TableHead>Last modified</TableHead>
          <TableHead className="hidden lg:table-cell">Created</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {drafts.map((draft) => (
          <TableRow key={draft.id}>
            <TableCell className="max-w-[220px] truncate font-medium">
              <Link
                to={`/app/compose/${draft.id}/`}
                className="hover:text-primary hover:underline"
              >
                {draftDisplaySubject(draft.subject)}
              </Link>
            </TableCell>
            <TableCell className="hidden max-w-[200px] truncate md:table-cell">
              {senderLabel(draft)}
            </TableCell>
            <TableCell>{formatDate(draft.updatedAt)}</TableCell>
            <TableCell className="hidden lg:table-cell">
              {formatDate(draft.createdAt)}
            </TableCell>
            <TableCell>
              <DraftActions draftId={draft.id} onDelete={() => onDelete(draft)} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
      </div>
    </>
  );
}
