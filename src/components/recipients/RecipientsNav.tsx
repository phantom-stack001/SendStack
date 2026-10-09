import { Link, useLocation } from "react-router-dom";

import { cn } from "@/lib/utils";
import { normalizeAppPath } from "@/lib/dashboard-nav";

const links = [
  { href: "/app/recipients/", label: "All contacts" },
  { href: "/app/recipients/lists/", label: "Lists" },
  { href: "/app/recipients/import/", label: "Import" },
  { href: "/app/recipients/suppressions/", label: "Suppressions" },
];

export function RecipientsNav() {
  const { pathname } = useLocation();
  const current = normalizeAppPath(pathname);

  return (
    <nav className="flex flex-wrap gap-2 border-b border-border pb-3" aria-label="Recipients">
      {links.map((link) => {
        const active =
          current === link.href ||
          (link.href === "/app/recipients/lists/" && current.startsWith("/app/recipients/lists/"));
        return (
          <Link
            key={link.href}
            to={link.href}
            className={cn(
              "inline-flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
