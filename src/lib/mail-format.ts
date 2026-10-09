export function formatMailDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function folderHref(folder: { path: string; specialUse: string | null }) {
  if (folder.specialUse === "\\Inbox" || folder.path.toUpperCase() === "INBOX") {
    return "/app/inbox/";
  }
  if (folder.specialUse === "\\Sent") {
    return "/app/sent/";
  }
  return `/app/inbox/?folder=${encodeURIComponent(folder.path)}`;
}

export function folderLabel(folder: { name: string; messages: number | null }) {
  return folder.messages === null ? folder.name : `${folder.name} (${folder.messages})`;
}
