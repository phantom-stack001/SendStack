import {
  FileText,
  History,
  LayoutDashboard,
  ListOrdered,
  Mail,
  Settings,
  SquarePen,
  Users,
  type LucideIcon,
} from "lucide-react";

export type DashboardNavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
};

export type DashboardNavGroup = {
  label: string;
  items: DashboardNavItem[];
};

export const dashboardNavGroups: DashboardNavGroup[] = [
  {
    label: "Overview",
    items: [{ title: "Dashboard", url: "/app/", icon: LayoutDashboard }],
  },
  {
    label: "Email management",
    items: [
      { title: "Compose", url: "/app/compose/", icon: SquarePen },
      { title: "Campaigns", url: "/app/campaigns/", icon: Mail },
      { title: "Recipients", url: "/app/recipients/", icon: Users },
      { title: "Templates", url: "/app/templates/", icon: FileText },
    ],
  },
  {
    label: "Delivery",
    items: [
      { title: "Queue", url: "/app/queue/", icon: ListOrdered },
      { title: "Sending History", url: "/app/history/", icon: History },
    ],
  },
  {
    label: "Account",
    items: [{ title: "Settings", url: "/app/settings/", icon: Settings }],
  },
];

export function normalizeAppPath(pathname: string) {
  if (pathname === "/") {
    return pathname;
  }
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

export function findDashboardNavItem(pathname: string): DashboardNavItem | undefined {
  const currentPath = normalizeAppPath(pathname);
  for (const group of dashboardNavGroups) {
    const match = group.items.find((item) => item.url === currentPath);
    if (match) {
      return match;
    }
  }
  return undefined;
}
