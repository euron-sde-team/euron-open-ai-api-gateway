# Design language

The web app follows one calm design language. It should feel like a well-made instrument
panel for money and traffic, never like a template: a cool grey ground, type and numbers
doing the work, a single vermilion accent (the lit route in the logo). These rules are the
contract for every page.

## Foundations

| Token | Use |
| --- | --- |
| `font-display` (Bricolage Grotesque, 600 to 700, tracking -0.02em) | Page titles, the overview greeting, stat figures, section headings |
| `font-sans` (Hanken Grotesk) | Everything else. Body 14.5px, meta 13px, labels 12.5px; numbers in tables use `tabular-nums` |
| `ink` | Text and the one solid call to action per screen (Create key, Continue to payment, `Button variant="primary"`) |
| `primary` / `brand` | Links, focus rings, the active underline, chart series, switches, small accents. Never large fills |
| `background` / `ground-2` | Page ground; the sidebar and code blocks sit on `ground-2` |
| `card` + `shadow-card` + `rounded-card` | Only surfaces that float: menus, dialogs, sheets |
| `border` | 1px hairlines between list rows and sections |

Widths: reading pages (docs, settings) `max-w-5xl`, data pages (overview, keys, usage,
models, billing, playground) `max-w-7xl`, admin `max-w-[1200px]`, gutters `px-4 sm:px-6`. Light and dark mode are a
token swap: never hard-code a colour (`bg-white`, `#fff`, `text-gray-*`).

## Rules

1. **No box inside a box.** A surface never contains another bordered or tinted panel.
   Lists inside a surface are rows separated by hairlines.
2. **Numbers are type, not tiles.** Totals sit in a `StatLine`: big figures with a label,
   no borders. Money always goes through `lib/money.ts` (micro-USD in, never floats, tiny
   amounts keep enough decimals to never read as zero).
3. **Forms are not wrapped in cards.** A settings page is a column of sections: heading,
   one line of help, fields, a save button.
4. **Choices are words, not pills.** Tabs and filters are plain words in a row; the active
   one is ink with a 2px underline as wide as the word. Use
   `components/common/underline-tabs.tsx`.
5. **Facts are type.** "/v1/chat/completions, streamed" is one line of 13px meta text, not
   chips. Status is a small dot and a word (`StatusText`), never a coloured pill.
6. **One lit action per screen.** One `primary` button; secondary actions are `outline`,
   `ghost` or a text link. Destructive actions confirm in a dialog that names the thing.
7. **Buttons are 10px-corner bars**, never capsules. Icon-only buttons are round
   (`IconButton`) and always have a label (tooltip and `aria-label`). Hover-only actions
   stay reachable by keyboard: they fade in on `focus-visible` too.
8. **Secrets are shown once.** A new API key appears in one dialog with a copy button and a
   ready snippet, then never again; lists show the hint (`gw-abcd...wxyz`). Provider
   credentials are never shown at all, only a label and the last four characters.
9. **Instant UI.** Revokes, toggles and edits are optimistic; skeletons match the final
   layout; never a bare spinner on a blank page. Errors say what happened and what to do,
   with the API `code` mapped in `lib/errors.ts`.
10. **No filler.** No "Welcome back!", no icon-in-a-tinted-circle feature grids, no gradient
    blobs, no invented numbers (usage and money are shown only when they are real). No em
    dashes in any copy.
11. **Accessible by default.** Every interactive element is reachable and labelled; focus
    rings are visible; colour is never the only signal; contrast passes WCAG AA in both
    themes (the e2e suite runs axe on every page in both). Streamed playground replies and
    status changes are announced politely.

## Patterns

- **Shell**: a left sidebar (the console pages, then the balance and the account menu) that
  collapses on desktop and becomes a sheet on phones; the page fills the rest.
- **Overview**: the greeting in display type, a stat line (balance, spend, requests, tokens,
  latency), daily charts with range tabs, then spend by model and by key. A first-run block
  (create a key, point your SDK, watch usage) shows until the first request.
- **Keys and usage**: hairline tables; a request opens a right-side sheet with its billing
  facts and, when kept, its bodies.
- **Billing**: the wallet as a stat line, the top-up form with a live preview of what is paid
  and credited, promo codes, then the ledger and top-ups.
- **Admin**: a left sidebar of areas, a page header with the title and the primary action,
  then tables with hairline rows, filters as underline tabs plus one search field, and
  detail in a right-side sheet.
- **Empty states**: one sentence of what this is and one action, using `EmptyState`.
- **Dates**: `lib/time.ts` helpers; relative for recent activity, absolute in the ledger and
  the audit log.
