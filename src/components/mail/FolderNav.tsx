import { Link, useNavigate } from "react-router-dom";

import { folderHref, folderLabel } from "@/lib/mail-format";
import type { MailFolder } from "@/lib/mail-api";
import { cn } from "@/lib/utils";

export function FolderNav({
  folders,
  activePath,
}: {
  folders: MailFolder[];
  activePath: string | null;
}) {
  const navigate = useNavigate();
  const active = folders.find((folder) => folder.path === activePath) ?? folders[0];

  return (
    <nav aria-label="Mailbox folders" className="min-w-0 lg:w-44 lg:shrink-0">
      <label className="block lg:hidden">
        <span className="sr-only">Mailbox folder</span>
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={active ? folderHref(active) : ""}
          onChange={(event) => navigate(event.target.value)}
        >
          {folders.map((folder) => (
            <option key={folder.path} value={folderHref(folder)}>
              {folderLabel(folder)}
            </option>
          ))}
        </select>
      </label>
      <ul className="hidden lg:flex lg:flex-col lg:gap-0.5">
        {folders.map((folder) => {
          const selected = folder.path === activePath;
          return (
            <li key={folder.path}>
              <Link
                to={folderHref(folder)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                  selected && "bg-muted font-medium text-foreground",
                )}
              >
                <span className="truncate">{folder.name}</span>
                {folder.messages !== null ? (
                  <span className="shrink-0 text-xs tabular-nums">{folder.messages}</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
