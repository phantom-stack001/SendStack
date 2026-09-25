const ADMIN_PERMISSIONS = [
  "overview.view",
  "sending.view",
  "lists.view",
  "lists.manage",
  "contacts.view",
  "contacts.manage",
  "contacts.edit",
  "campaigns.view",
  "campaigns.manage",
  "campaigns.send",
  "deliveries.view",
  "deliveries.feedback",
  "suppressions.view",
  "suppressions.manage",
  "audit.view",
  "users.view",
  "users.manage",
] as const;

export const ROLE_DEFINITIONS = {
  admin: {
    id: "admin",
    label: "Administrator",
    description: "Full system control, including access management and audit history.",
    permissions: [...ADMIN_PERMISSIONS],
  },
  marketer: {
    id: "marketer",
    label: "Marketer",
    description: "Manages audiences, campaigns, sends, and suppressions.",
    permissions: [
      "overview.view",
      "lists.view",
      "lists.manage",
      "contacts.view",
      "contacts.manage",
      "campaigns.view",
      "campaigns.manage",
      "campaigns.send",
      "deliveries.view",
      "suppressions.view",
      "suppressions.manage",
    ],
  },
  analyst: {
    id: "analyst",
    label: "Analyst",
    description: "Read-only campaign reporting without recipient-level personal data.",
    permissions: ["overview.view", "lists.view", "campaigns.view"],
  },
} as const;

export type RoleId = keyof typeof ROLE_DEFINITIONS;

export const PERMISSION_DEFINITIONS = [
  { id: "overview.view", label: "Overview", description: "View operational totals and campaign reporting" },
  { id: "sending.view", label: "Sending setup", description: "View delivery setup and go-live checklist (administrators only)" },
  { id: "lists.view", label: "List reporting", description: "View list names and audience totals" },
  { id: "lists.manage", label: "Manage lists", description: "Create audience lists" },
  { id: "contacts.view", label: "Recipient data", description: "View contact identities and consent records" },
  { id: "contacts.manage", label: "Manage contacts", description: "Create and import contacts" },
  { id: "contacts.edit", label: "Edit contacts", description: "Edit or delete existing contacts" },
  { id: "campaigns.view", label: "Campaign reporting", description: "View campaigns, content, and totals" },
  { id: "campaigns.manage", label: "Manage campaigns", description: "Create and edit campaign drafts" },
  { id: "campaigns.send", label: "Send campaigns", description: "Send previews and launch campaigns" },
  { id: "deliveries.view", label: "Delivery records", description: "View message records" },
  { id: "deliveries.feedback", label: "Delivery feedback", description: "Process delivery events" },
  { id: "suppressions.view", label: "Suppression data", description: "View suppressed addresses" },
  { id: "suppressions.manage", label: "Manage suppressions", description: "Add manual suppressions" },
  { id: "audit.view", label: "Audit log", description: "View administrative activity" },
  { id: "users.view", label: "User directory", description: "View users and roles" },
  { id: "users.manage", label: "Manage access", description: "Create and update users" },
];

export function permissionsForRole(role: string): Set<string> {
  const definition = ROLE_DEFINITIONS[role as RoleId];
  return new Set(definition?.permissions ?? []);
}

export function roleDefinitionsPayload() {
  return Object.values(ROLE_DEFINITIONS).map((role) => ({
    id: role.id,
    label: role.label,
    description: role.description,
    permissions: [...role.permissions],
  }));
}

export function requiredPermission(method: string, path: string): string | null {
  const normalized = path.startsWith("/api") ? path : `/api${path.startsWith("/") ? path : `/${path}`}`;
  const exact: Record<string, string> = {
    "GET /api/summary": "overview.view",
    "GET /api/production-readiness": "sending.view",
    "GET /api/lists": "lists.view",
    "POST /api/lists": "lists.manage",
    "GET /api/contacts": "contacts.view",
    "POST /api/contacts": "contacts.manage",
    "POST /api/contacts/import": "contacts.manage",
    "GET /api/suppressions": "suppressions.view",
    "POST /api/suppressions": "suppressions.manage",
    "GET /api/campaigns": "campaigns.view",
    "POST /api/campaigns": "campaigns.manage",
    "GET /api/messages": "deliveries.view",
    "GET /api/audit": "audit.view",
    "GET /api/users": "users.view",
    "POST /api/users": "users.manage",
  };
  const exactHit = exact[`${method} ${normalized}`];
  if (exactHit) return exactHit;

  if (/^\/api\/campaigns\/[^/]+$/.test(normalized)) {
    if (method === "GET") return "campaigns.view";
    if (method === "PATCH" || method === "DELETE") return "campaigns.manage";
    return null;
  }
  if (/^\/api\/campaigns\/[^/]+\/attachments(?:\/[^/]+)?$/.test(normalized)) {
    if (method === "GET") return "campaigns.view";
    if (method === "POST" || method === "DELETE") return "campaigns.manage";
    return null;
  }
  if (/^\/api\/campaigns\/[^/]+\/(launch|pause|resume|test-send)$/.test(normalized)) {
    return method === "POST" ? "campaigns.send" : null;
  }
  if (/^\/api\/contacts\/[^/]+$/.test(normalized)) {
    if (method === "GET") return "contacts.view";
    if (method === "PATCH" || method === "DELETE") return "contacts.edit";
    return null;
  }
  if (/^\/api\/messages\/[^/]+$/.test(normalized)) {
    return method === "GET" ? "deliveries.view" : null;
  }
  if (/^\/api\/messages\/[^/]+\/event$/.test(normalized)) {
    return method === "POST" ? "deliveries.feedback" : null;
  }
  if (/^\/api\/users\/[^/]+$/.test(normalized)) {
    return method === "PATCH" ? "users.manage" : null;
  }
  if (/^\/api\/users\/[^/]+\/reset-password$/.test(normalized)) {
    return method === "POST" ? "users.manage" : null;
  }
  return null;
}
