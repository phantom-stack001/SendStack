import { Link, useLocation } from "react-router-dom";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { findDashboardNavItem } from "@/lib/dashboard-nav";

export function DashboardHeader() {
  const { pathname } = useLocation();
  const current = findDashboardNavItem(pathname);
  const pageTitle = current?.title ?? "SendStack";

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 md:h-16">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 md:px-4">
        <SidebarTrigger className="size-11 shrink-0 md:size-8" />
        <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem className="hidden md:block">
              <BreadcrumbLink asChild>
                <Link to="/app/">SendStack</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="block max-w-[46vw] truncate sm:max-w-xs md:max-w-md" title={pageTitle}>
                {pageTitle}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </header>
  );
}
