import { Menu } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const sectionLinks = [
  { href: "#services", label: "Services" },
  { href: "#about", label: "About" },
  { href: "#contact", label: "Contact" },
];

function sectionHref(pathname: string, hash: string) {
  return pathname === "/" ? hash : `/${hash}`;
}

export function Header() {
  const { pathname } = useLocation();

  const navLinks = sectionLinks.map((link) => ({
    ...link,
    href: sectionHref(pathname, link.href),
  }));

  return (
    <header className="site-header">
      <div className="shell">
        <div className="header-row">
          <Link className="brand" to="/">
            <span className="brand-mark" aria-hidden="true">C</span>
            <span className="brand-name">CTN</span>
          </Link>

          <Sheet>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="nav-toggle max-[720px]:inline-flex min-[721px]:hidden border-[var(--line)] bg-[rgba(255,255,255,0.65)]"
                aria-label="Open menu"
              >
                <span className="nav-toggle-label">Menu</span>
                <Menu className="size-4" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="bg-[rgba(232,236,239,0.98)]">
              <SheetHeader>
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col gap-1 px-4 pb-4" aria-label="Primary mobile">
                {navLinks.map((link) => (
                  <a
                    key={link.label}
                    className="rounded-md px-3 py-2 text-[0.92rem] font-medium text-[var(--muted)] hover:bg-white/60 hover:text-[var(--ink)]"
                    href={link.href}
                  >
                    {link.label}
                  </a>
                ))}
                <Button asChild variant="secondary" className="mt-2 w-full">
                  <Link to="/app/">Sign in</Link>
                </Button>
              </nav>
            </SheetContent>
          </Sheet>

          <nav className="nav max-[720px]:hidden min-[721px]:flex" aria-label="Primary">
            {navLinks.map((link) => (
              <a key={link.label} href={link.href}>{link.label}</a>
            ))}
            <Link className="nav-cta" to="/app/">Sign in</Link>
          </nav>
        </div>
      </div>
    </header>
  );
}
