import {
  FileText,
  History,
  Inbox,
  LayoutDashboard,
  LayoutTemplate,
  ListOrdered,
  Mail,
  Send,
  Settings,
  SquarePen,
  Users,
  type LucideIcon,
} from "lucide-react";

const NAV_PREFIX_MATCHES: Record<string, string> = {
  "/app/compose/": "/app/compose/",
  "/app/inbox/": "/app/inbox/",
  "/app/sent/": "/app/sent/",
  "/app/drafts/": "/app/drafts/",
  "/app/campaigns/": "/app/campaigns/",
  "/app/recipients/": "/app/recipients/",
};

export type DashboardNavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  superAdminOnly?: boolean;
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
    label: "Mail",
    items: [
      { title: "Compose", url: "/app/compose/", icon: SquarePen },
      { title: "Inbox", url: "/app/inbox/", icon: Inbox, superAdminOnly: true },
      { title: "Sent", url: "/app/sent/", icon: Send, superAdminOnly: true },
      { title: "Drafts", url: "/app/drafts/", icon: FileText },
    ],
  },
  {
    label: "Campaigns",
    items: [
      { title: "Campaigns", url: "/app/campaigns/", icon: Mail },
      { title: "Recipients", url: "/app/recipients/", icon: Users },
      { title: "Templates", url: "/app/templates/", icon: LayoutTemplate },
    ],
  },
  {
    label: "System",
    items: [
      { title: "Queue", url: "/app/queue/", icon: ListOrdered },
      { title: "History", url: "/app/history/", icon: History },
      { title: "Settings", url: "/app/settings/", icon: Settings },
    ],
  },
];

export function visibleDashboardNavGroups(isSuperAdmin: boolean): DashboardNavGroup[] {
  return dashboardNavGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => isSuperAdmin || !item.superAdminOnly),
    }))
    .filter((group) => group.items.length > 0);
}

export function normalizeAppPath(pathname: string) {
  if (pathname === "/") {
    return pathname;
  }
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

export function isDashboardNavItemActive(itemUrl: string, pathname: string) {
  const currentPath = normalizeAppPath(pathname);
  if (currentPath === itemUrl) {
    return true;
  }
  const prefix = NAV_PREFIX_MATCHES[itemUrl];
  return prefix ? currentPath.startsWith(prefix) : false;
}

export function findDashboardNavItem(pathname: string): DashboardNavItem | undefined {
  const currentPath = normalizeAppPath(pathname);
  for (const group of dashboardNavGroups) {
    const match = group.items.find((item) => isDashboardNavItemActive(item.url, currentPath));
    if (match) {
      return match;
    }
  }
  return undefined;
}
