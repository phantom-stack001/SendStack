# CTN workspace UI changes

The signed-in app is the static shell in `web/public/` (`index.html`, `app.js`, `styles.css`), served by the Next.js rewrite `/app` → `/index.html`. The public site stays in `web/app/`.

No API route, request or response shape, permission check, or database schema was changed. Outbound mail was not sent.

Asset size before → after:

| File | Before | After |
| --- | --- | --- |
| `web/public/app.js` | 121,066 bytes | 147,946 bytes |
| `web/public/styles.css` | 40,891 bytes | 33,175 bytes |

## What changed

**Brand and tokens.** Light is the main theme, using the public site’s teal, canvas, serif titles, and sans UI face. Dark is a full theme. The account menu can follow the system, or force light or dark. The mark is the same square “C” wordmark. Focus rings are 2px and no longer removed on inputs. Primary buttons are solid teal with text that clears 4.5:1. Ratios are in `DESIGN-TOKENS.md`.

**Shell.** Each section has a hash URL (`/app#/contacts`, `/app#/campaigns/:id`, and the same for a contact, delivery, or user). Back, forward, and refresh keep the section. The document title is “Contacts · CTN” and so on. Nav items are links with `aria-current="page"`. There is a skip link. The mobile drawer has a backdrop, a close button, Escape, and a focus trap. One `<main>` is visible: the other view uses the `hidden` attribute.

**Status.** The sidebar pill, the header queue line, and the two overview banners are one header control. It opens a popover with preview or live, queue depth, and today’s remaining allowance. Summary polling waits 20 seconds when nothing is queued, 5 seconds while the queue is non-zero, and stops while the tab is hidden.

**Speed.** Revisiting a section paints the last response immediately, then refreshes. A small “Updating” label shows during that refresh. Modals and the composer render their form before dependent lists finish loading. Buttons that submit show a busy state immediately.

**Language.** A campaign is what you compose and launch. A delivery is one email to one recipient. “New campaign” is the header action, not repeated in empty states. “View deliveries” goes to Deliveries. Everyday copy says “sending service” or “Preview”. The provider name stays inside Sending setup’s collapsed technical details, because that is where the API text still includes it.

**Roles.** Missing sections stay in the nav and open an explanation instead of an empty table. Marketers see “Ask an administrator” where launch and test would be. Analysts still do not receive recipient rows.

## Screen notes

**Sign-in.** Serif headline reads as one sentence (“Plan, deliver, and learn from every campaign.”). Password can be shown, Caps Lock is announced, autocomplete is `username` and `current-password`, and the button shows a busy state. “Invalid email or password” from the API is shown as “Email or password is incorrect.” Help links to `/#contact` on the public site.

**Overview.** Four stat cards use tabular figures, a context line, and a link when the role can open the destination. Corner glows are gone. With zero contacts, a getting-started list replaces a premature “new campaign” empty state.

**Contacts.** One header with the count, Import, and Add contact. Lists are a rail (tabs on a narrow screen) with counts and New list. “Shown” is gone. The add form fills the dialog, marks required fields, validates email on blur, and offers Create a list when none exist. Consent source is a labelled list; an optional note is stored in the existing consent-source string. Import is upload, column mapping, then a consent confirmation and the existing import call. The table sorts the loaded rows, can select and delete via the existing delete call, and opens a drawer with the consent record the API returns.

**Campaigns.** The list shows status, audience, sent/total, and created time, with a status filter. The composer is a full page at `#/campaigns/new` or `#/campaigns/:id`, with preview width, light/dark frame, and a sample contact. Starter copy is inserted only if you ask for it. The toolbar can add a link and `{{first_name}}`, `{{last_name}}`, `{{email}}`, or optional `{{unsubscribe_url}}`. There is no attachment upload. A before-you-send list mirrors the checks the server already enforces. Drafts autosave when subject, list, and sender are present, and leaving warns about unsaved changes. Live launch asks for a checkbox and the word SEND, and shows eligible count, From, Reply-To, and a rough time from today’s remaining allowance and the 500-per-hour cap already stated in the product.

**Deliveries.** One status list covers the eight filters the API accepts, plus a note that Delayed can appear but cannot be filtered. Filters hide when there is nothing to filter. A row opens a drawer with the rendered message and the timestamps on that record. Analysts get the role explanation.

**Suppressions.** Several addresses can be pasted; each is sent with the existing manual reason. Search and reason filters run on the loaded rows. Removing a manual suppression asks for a re-consent note and calls the existing delete. Bounce, complaint, and unsubscribe rows stay in place, which matches the server.

**Users.** Role cards show the name once. The permission table is grouped and the header sticks. Manage opens a drawer. The name field asks for a real name.

**Audit.** Filters sit on one row and collapse. “Role: admin” displays as Administrator. `::1` and `127.0.0.1` display as “Local / server”; other IPs are monospaced. Rows are grouped by day, relative times have an exact-time tooltip, and a row can expand. Export CSV uses the events already loaded for the active filters.

**Sending setup.** The page leads with “Ready to send” or not, then one checklist, delivery health, and today’s volume. Host, database, scheduler, and provider names sit under Technical details.

## Deliberately not changed

These need a backend or product change. The UI does not pretend they exist.

- **API latency.** Summary and section calls are still slow on the server. The UI only avoids blanking the page when it already has data.
- **Static caching.** `web/middleware.ts` and `web/next.config.ts` send `Cache-Control: no-store` for `/app`, `/app.js`, and `/styles.css`. The HTML still uses `?v=dev` until those headers can be replaced with a hashed filename and a long cache lifetime.
- **Setup payload.** `/api/production-readiness` still returns host, database, SMTP, and `CRON_SECRET` wording. The page hides that block. The API can stop returning it.
- **Authentication status.** SPF, DKIM, and DMARC are not in the setup payload. The public site talks about DNS authentication; the workspace does not show it.
- **Campaign owner and last updated.** `GET /api/campaigns` does not return `created_by` or `updated_at`. The table shows Created.
- **Audit actor email.** The audit payload has `actor_name` only.
- **Who suppressed an address.** `GET /api/suppressions` returns email, reason, source, and created time.
- **A free-text suppression reason.** `POST /api/suppressions` accepts only `reason: "manual"`.
- **Full consent history, server-side sort, and pages past 500 contacts.** The contacts API returns the latest 500 rows.
- **A suppressed tally on import.** The import response reports imported, updated, duplicates, and invalid. Suppressed addresses are still imported with a suppressed status, and the UI says so.
- **A real delivery event log.** The message payload is one row (status, created time, delivered time, error). The drawer shows those fields.
- **A stored hourly limit.** The “about 500 an hour” line is the cap already described in the product, not a value from the API.
- **“Request launch” as a workflow.** Marketers see an explanation. There is no request object to create.

## QA

Checked in the browser against the static shell (sign-in, component reference at `#/_ui`, keyboard order, and widths 360, 390, 768, 1024, 1280, and 1440). Toolbars use grid, so filter controls do not stretch into tall columns. Signed-in flows were not exercised here: local `web/.env` points at a remote database, and this pass did not create, import, launch, or test-send anything. Those flows still call the same endpoints as before.

An automated axe or Lighthouse run and a VoiceOver pass were not completed in this session. Keyboard order was checked on sign-in and the component page. Contrast ratios are the calculated token pairs above, not a full-page sampler of every rendered string.
