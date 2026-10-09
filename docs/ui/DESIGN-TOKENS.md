# CTN workspace design tokens

The signed-in workspace (`web/public/styles.css`) uses the same brand as the public site (`web/app/page.module.css`). There is no separate brand guide in the repo. Light is the default. Dark follows `prefers-color-scheme` until the account menu stores a choice in `localStorage` (`ctn-theme`: `system`, `light`, or `dark`).

Terracotta (`#c45c26`) is reserved for small non-text highlights. It is not a status or error colour. White on terracotta is about **4.3:1**, so it is not used for text.

Ratios below were calculated from the token hex values (WCAG relative luminance). Body text needs **4.5:1**. Non-text boundaries (borders, focus rings) need **3:1**.

## Colour

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `canvas` | `#e8ecef` | `#101816` | Page background |
| `surface` | `#ffffff` | `#182220` | Cards, dialogs, sidebar |
| `surface-2` | `#f4f7f8` | `#1f2c29` | Headers, quiet fills |
| `surface-3` | `#e7eeef` | `#273632` | Pressed fills, meters |
| `border` | `#748490` | `#5d736c` | Cards, dividers, inputs |
| `border-strong` | `#5c6c76` | `#7f968f` | Emphasis |
| `text` | `#141821` | `#f3f7f6` | Primary text |
| `text-muted` | `#3d4a5c` | `#c5d2ce` | Secondary text |
| `text-subtle` | `#4a596c` | `#a8b8b3` | Eyebrows, placeholders |
| `accent` | `#0f7a72` | `#7dcec6` | Primary actions, links, selection |
| `accent-hover` | `#0c6861` | `#69c4bb` | Hover |
| `accent-pressed` | `#0a5f59` | `#8ed9d0` | Pressed |
| `accent-subtle` | `#e5f3f1` | `#1a3330` | Selected nav, highlights |
| `on-accent` | `#ffffff` | `#08211e` | Text on accent fill |
| `success` / `success-subtle` | `#0d6b3d` / `#e5f4ec` | `#8ed7b0` / `#163228` | Ready, granted |
| `warning` / `warning-subtle` | `#8a4b08` / `#f8efdf` | `#f0c27a` / `#332616` | Caution |
| `danger` / `danger-subtle` | `#9f1d2a` / `#f8e6e8` | `#ffb3b8` / `#3a1c22` | Errors, suppress |
| `info` / `info-subtle` | `#0e4d6e` / `#e6f1f6` | `#9fd4ea` / `#16303a` | Notes |
| `focus` | `#0a5f59` | `#9ee6de` | 2px focus ring |
| `highlight` | `#c45c26` | `#e09a72` | Non-text accent only |

### Text contrast

| Pair | Light | Dark |
| --- | --- | --- |
| Text on surface | 17.8:1 | 15.1:1 |
| Text on canvas | 15.0:1 | 16.7:1 |
| Muted on surface | 9.0:1 | 10.5:1 |
| Subtle on surface | 7.2:1 | 7.9:1 |
| On-accent on accent | 5.2:1 (`#ffffff` on `#0f7a72`) | 9.2:1 (`#08211e` on `#7dcec6`) |
| On-accent on hover | 6.6:1 | — |
| On-accent on pressed | 7.5:1 | — |
| Accent as text on surface | 5.2:1 | 8.9:1 |
| Danger on surface | 7.8:1 | 9.6:1 |
| Danger on danger-subtle | 6.5:1 | 9.1:1 |
| Success on surface | 6.6:1 | — |
| Warning on surface | 6.8:1 | — |
| Warning on warning-subtle | 6.0:1 | — |
| Focus ring on surface | 7.5:1 | 11.5:1 |
| Focus ring on canvas | 6.3:1 | — |
| Border on surface | 3.9:1 | 3.2:1 |
| Border on canvas | 3.3:1 | 3.6:1 |

### Delivery status

Each pill includes a word, not colour alone. `sandboxed` uses the Captured colours.

| Status | Light text / fill | Dark text / fill | Light on fill |
| --- | --- | --- | --- |
| Captured | `#3d4a5c` / `#e7eef2` | `#d5e0ea` / `#243038` | 7.7:1 |
| Submitted | `#0a5f59` / `#e5f3f1` | `#b7ebe4` / `#163632` | 6.6:1 |
| Delivered | `#0d6b3d` / `#e5f4ec` | `#b7ebcf` / `#163228` | 5.8:1 |
| Delayed | `#8a4b08` / `#f8efdf` | `#f0c27a` / `#332616` | 6.0:1 |
| Failed | `#9f1d2a` / `#f8e6e8` | `#ffb3b8` / `#3a1c22` | 6.5:1 |
| Bounced | `#8a2e12` / `#f8ebe6` | `#f3c0ae` / `#3a241c` | 7.3:1 |
| Complained | `#8b1e4a` / `#f8e6ee` | `#f3b6cc` / `#3a1c2c` | 7.4:1 |
| Unsubscribed | `#4c3d78` / `#eeeaf6` | `#d4c8f0` / `#2a2438` | 7.9:1 |
| Suppressed | `#6b4a12` / `#f6efdf` | `#ead7a8` / `#332c1c` | 7.0:1 |

Campaign states reuse these: draft and disabled use Captured; sending, processing, and active use Submitted; completed uses Delivered; paused, queued, and pending consent use Delayed; failed uses Failed.

## Type

| Token | Size | Use |
| --- | --- | --- |
| `text-xs` | 12px | Eyebrows, pills. Uppercase only on eyebrows. |
| `text-sm` | 13px | Table cells, help |
| `text-md` | 15px | Controls |
| `text-lg` | 18px | Section titles |
| `text-xl` | 24px | Page title |
| `text-2xl` | 32px | Stat values |

Display face (page title, sign-in headline, stat values): `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`.

UI face: `"Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif`.

Numbers in stats, tables, and meters use `font-variant-numeric: tabular-nums`.

## Space, radius, elevation, motion

Space is a 4px scale: 4, 8, 12, 16, 24, 32, 48, 64.

Radius is `8px` (controls and pills’ square cousins), `14px` (cards and dialogs), and `999px` (pills and avatars).

Shadows: a hairline lift (`shadow-1`) and a dialog/menu lift (`shadow-2`). Stat cards do not use coloured glows.

Motion is 160ms ease-out. `prefers-reduced-motion: reduce` shortens transitions and animations.

## Component reference

On a local host, open `/app#/_ui` (or the static shell at `#/_ui`). The page is not linked in production navigation.
