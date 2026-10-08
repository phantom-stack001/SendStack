# SendStack documentation

Living project docs for the current architecture. Run instructions live in the root [`README.md`](../README.md) and [`web/README.md`](../web/README.md).

| Document | Purpose |
| --- | --- |
| [Product](product.md) | Goals, roles, modules, and MVP boundaries |
| [Architecture](architecture.md) | Production and local test stacks, delivery contract |
| [Deployment](deployment.md) | Vercel + PostgreSQL + Spacemail SMTP handover, gates, and env vars |
| [Production runbook](production-runbook.md) | Ordered operator activation for `ctn-sk.com` (backup → migrate → canary → warm-up) |
| [Post-remediation](post-remediation.md) | Operator-only checklist after deliverability hardening |
