import { Outlet } from "react-router-dom";

import { AppSidebar } from "@/components/app-sidebar";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export function DashboardLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <DashboardHeader />
        <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 pt-0 pb-[max(1rem,env(safe-area-inset-bottom))] md:gap-6 md:px-6 md:pb-6">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
