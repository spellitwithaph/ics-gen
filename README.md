# ICS Generator

A dependency-free **iCalendar (.ics) generator that runs entirely in the browser** — built for static-site hosting. No server-side code, no build step, no API keys. The demo page's only third-party request is Cloudflare Web Analytics (cookie-free visit counting; event data never leaves the browser).

- Generate `.ics` files with a few lines of plain JavaScript
- Pick a **time zone** per event in the demo form — defaults to your device's zone, with `UTC` and every IANA zone available
- **Import an existing `.ics`** by dropping a file, choosing one, or pasting text — parsed locally in the browser, never uploaded
- Add an **organizer** and any number of **attendees** (name, email, role, reply status, RSVP)
- Download them with a Blob URL (works on `file://` too)
- Import the result into Google Calendar, Outlook, Apple Calendar, Thunderbird, etc.

> **Authored by:** DeepSeek V4 Flash - High - Paseo/Pi/Opencode Go  
> **Last updated:** `2026-10-04T18:11:35Z` (ISO 8601, UTC)
>
> **Maintenance rule:** every change that produces a branch to merge must bump
> the `Last updated` timestamp above to the current UTC date and time (ISO 8601,
> `YYYY-MM-DDTHH:MM:SSZ`), so each merge's doc freshness is auditable at a glance.

## v2 preview

A v2 of the site is in development and served from `/v2/`, so the stable
version can keep running untouched at the site root. `/` remains v1; `/v2/` is
the preview where new work lands until it is promoted. What `/v2/` adds over
v1 (each point is verifiable in `v2/app.js`, `v2/ics.js`, and
`v2/ics-parse.js`):

- **Event list** — edit events in place (the UID is kept stable across an
  edit), duplicate them with one click, and see them sorted by start date.
  Status messages and the event count are announced to screen readers
  (`role="status"` / `aria-live`). Removing, clearing, and loading samples show
  an undo toast (about 8 seconds, paused while hovered or focused) instead of
  confirm dialogs. Escape only dismisses the toast (no undo); Ctrl/Cmd+Z
  triggers the undo only while the toast is visible and focus is not inside an
  editable control.
- **Persistence** — events, the calendar name, the download filename, and the
  VTIMEZONE preference are saved in the browser's localStorage, so events are
  restored on reload. Saved data is treated as untrusted: a failed or
  unreadable restore leaves the saved data untouched and pauses saving until
  the visitor makes an explicit change to the event list (add, edit, remove,
  clear, import, or samples — including clearing an empty list).
- **Form** — inline per-field validation with focus moved to the first invalid
  field; a weekly day-of-week picker plus occurrence-count and end-date
  recurrence ends; rules the form cannot represent exactly are preserved on
  edit (a hint names what is kept); a type-to-filter time zone picker showing
  each zone's current UTC offset; multiple reminders per event (up to five);
  Show-as busy/free (`TRANSP`) and priority; organizer/attendees as before.
- **Import** — parser notes are surfaced in a collapsed list; imported events
  can be added or replace the current list; a calendar name from
  `X-WR-CALNAME` is picked up while the name field still shows the default.
- **Output** — a Google Calendar link per event, optional VTIMEZONE blocks (an
  opt-in checkbox; transitions are sampled at the distinct UTC start-years of
  each zone's events plus one margin year when the 40-year budget permits —
  not every year an event or its recurrence touches; when distinct years
  exceed the budget, the earliest 39 plus the latest are kept; explicit
  `TZID=UTC` (and UTC-instanced) events get no block — approximate for zones
  with exotic history), and a custom download filename. When a zoned event's
  end wall time falls in the repeated hour of a DST fall-back, the generator
  emits `DTEND` in UTC (`…Z`) so the duration stays unambiguous next to the
  `TZID`'d `DTSTART`.
- **Appearance** — automatic dark mode (`prefers-color-scheme`), the raw
  `.ics` text behind a collapsed "View code" toggle (the wrap and copy
  controls still live on that panel), and an invite-style card at the top of
  the list panel summarizing the next event (the earliest one).

The v2 libraries ship with the repo's zero-dependency Node test suite: 108
passing tests covering the generator (option validation, escaping and folding,
time-zone conversion, VTIMEZONE emission, `TRANSP`/`PRIORITY`, `updateEvent`)
and the parser (round trips, warnings, and zone fallbacks). Run it from the
repo root:

```bash
node v2/tests/run.js
```

The Quick start, API reference, and remaining sections below describe the v1
demo at the repo root unless marked otherwise.

## Is this possible on a static site? Yes.

An `.ics` file is just plain text (RFC 5545). Nothing about generating it requires a backend: the JavaScript runs in the visitor's browser, builds the text, and hands it to the browser as a downloadable file. A static host only needs to serve HTML/JS/CSS — the same files you already use for any static site.

The only things a static host *can't* do are server-side tasks — e.g. emailing invites on your behalf. Mitigations are included: attendees can be attached as `mailto:` entries (your mail client handles the invite), and a hosted `calendar.ics` file URL can be shared for import/subscribe.

## Files

| File | Purpose |
| --- | --- |
| `ics.js` | The generator library (also usable as a Node module). No dependencies. |
| `ics-parse.js` | Optional `.ics` reader (RFC 5545 text → event objects). Loaded after `ics.js`; extends the same global. No dependencies. |
| `index.html` | A self-contained demo app: form → events list → download. |
| `styles.css` | Styling for the demo app. |
| `app.js` | Demo-app logic (kept in its own file so the page can enforce a strict CSP). |
| `og-image.png` | 1200×630 social share image for Open Graph / X (Twitter) cards. |
| `sitemap.xml`, `robots.txt` | Search-engine discovery for the hosted site. |
| `v2/` | The v2 preview copy of the site plus its Node test suite (`v2/tests`). |
| `README.md` | This file. |

## Quick start

1. Open `index.html` in any modern browser (double-clicking works — there is no build step).
2. Fill in an event and click **Add to .ics** (the `.ics` preview below the event list is always expanded, so you can watch the generated text as you go).
3. Click **Download .ics** (next to the Add button), then import the file:
   - Google Calendar → Settings → **Import & export** → select the file.
   - Outlook → **File → Open & Export → Import/Export** (or drag it in Outlook 365).
   - Apple Calendar → **File → Import**.

Try the **Load sample events** button to see recurrence, all-day, attendees, and
reminders working — each sample event carries its own reminder (10 minutes,
2 hours, or 1 day before). In the form, reminders are optional: "No reminder"
is the default; switch the Reminder select to "Remind me" to set one in
minutes, hours, or days before the event.

The **Time zone** select sits directly above the date fields and defaults to the
zone your device reports (labelled "your device"). Pick `UTC` to emit a plain
`…Z` timestamp, or any IANA zone to emit `DTSTART;TZID=…` wall-clock times.
All-day events are date-only, so the field is hidden for them. The typed
start/end times are read as wall-clock time in the chosen zone, so an event
stays at the same local time across DST changes.

To bring in an existing calendar, open **Import an .ics file (drop or paste
text)** at the top of the form: drop a `.ics` file, pick one, or paste its text
and click **Import pasted text** (Ctrl/⌘+Enter also works). Reading happens
entirely in the browser — the file is never uploaded. Every `VEVENT` is added
to the list and preview; when the input holds exactly one event its fields are
also loaded into the form for editing. Anything the form cannot represent
(`EXDATE`, `COUNT`, unknown zones, …) is kept where possible; unknown properties
are ignored silently.

The **Organizer** and **Attendees** fields write `ORGANIZER` and `ATTENDEE`
lines. Add as many attendees as you need and set each one's role, reply status,
and RSVP flag; imported files fill these fields automatically.

## Hosting on any static site

Because there is no build step, deploy the folder as-is:

**GitHub Pages** — push the repo, then *Settings → Pages → Deploy from a branch* and choose a branch + `/ (root)`. You can publish any branch — including a feature branch like `first-branch` — which fits a "never work directly on main" workflow: ship the feature from its branch for review, then switch Pages (or the branch it publishes) to `main` after merge.

**Netlify Drop** — drag the folder onto <https://app.netlify.com/drop>. Done.

**Vercel** — `npx vercel` in the folder: pick "Other" as the framework, leave the build command empty, output directory `.`.

**Cloudflare Pages** — *Direct Upload* → drag the folder, or connect the Git repo with no build command.

**S3 + CloudFront / nginx / any file host** — upload the files and serve them. Serve `.ics` with `Content-Type: text/calendar` if you want users to subscribe to a shared `calendar.ics` URL (GitHub Pages, Netlify, and Cloudflare Pages already map `.ics` correctly).

**Local preview** — `npx serve .` or `python3 -m http.server 8080`, or just open `index.html` directly.

**Search & social metadata** — `index.html` ships a keyword-focused `<title>` and meta description, canonical, Open Graph and X/Twitter card tags, plus JSON-LD structured data: a `WebApplication` entity for the tool and a `FAQPage` that mirrors the on-page FAQ. `sitemap.xml` and `robots.txt` are included for the hosted site. This repository deploys to Cloudflare Pages (`https://ics-gen.pages.dev/`) via GitHub Actions, and the canonical/`og:`/sitemap URLs target that domain; if you ever move to a custom domain, update the canonical, `og:url` and `og:image` values in the `<head>` and the URLs inside `sitemap.xml`/`robots.txt`.

## Using the generator in your own page

Copy `ics.js` next to your page, include it, and generate on demand:

```html
<script src="ics.js"></script>
<button onclick="addWebinarToCalendar()">Add webinar to my calendar</button>
<script>
  function addWebinarToCalendar() {
    const cal = new IcsGenerator.Calendar({ name: 'Company events' });
    cal.addEvent({
      title: 'Product webinar',
      start: new Date('2026-02-10T17:00:00Z'),   // instant; emitted as UTC
      durationMinutes: 60,
      location: 'Online',
      description: 'Q&A with the team',
      categories: ['Webinar'],
      rrule: 'FREQ=WEEKLY;COUNT=4',
      alarms: [{ trigger: -15 }],                // 15 minutes before
      attendees: [{ email: 'you@example.com' }]
    });
    IcsGenerator.download('webinar.ics', cal.toString());
  }
</script>
```

It works as a Node module for scripts/CI checks too:

```js
const IcsGenerator = require('./ics.js');
```

## API reference

Everything lives on the `IcsGenerator` global (or the Node `module.exports`).

### `new IcsGenerator.Calendar(options)`

| Option | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Sets `X-WR-CALNAME` — the calendar title shown by Google/Apple. |
| `desc` | `string` | Sets `X-WR-CALDESC`. |
| `includeVtimezone` | `boolean` | **(v2)** Default `false`. Emits a best-effort `VTIMEZONE` block for every unique event `TZID` before the `VEVENT`s, so strict/offline clients can resolve the `TZID` without their own tz data. Explicit `TZID=UTC` (and UTC-instanced) events get no block. Transitions are sampled at the distinct UTC start-years of that zone's events plus one margin year when the 40-year budget permits (not every year an event or its recurrence touches); when distinct years exceed the budget, the earliest 39 plus the latest are kept. Approximate for zones with exotic history. |

Methods: `addEvent(options)` → `VEvent` · `updateEvent(indexOrEvent, options)` → `VEvent | false` **(v2)** · `removeEvent(indexOrEvent)` → `boolean` · `clear()` · `toString()` → full `.ics` text · `.events` array.

### `cal.addEvent(options)`

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | `string` | ✅ | Emitted as `SUMMARY`. Must be non-empty. |
| `start` | `Date` or `{year, month, day}` | ✅ | `Date` for timed events (emitted UTC). The object form forces an all-day event and is timezone-safe. |
| `end` | `Date` or `{year, month, day}` | | Timed: exclusive end instant. All-day: **exclusive** per RFC 5545 — omit it to get start + 1 day. |
| `durationMinutes` | `number` | | Used to compute `end` when no `end` is given (timed events). |
| `allDay` | `boolean` | | Forces `VALUE=DATE` output (implied by the `{year, month, day}` start). |
| `timezone` | `string` | | IANA name, e.g. `America/New_York`. Emits `DTSTART;TZID=…` with wall-clock time. Control characters are rejected. |
| `uid` | `string` | | Defaults to a random UUID. Set it to keep stable identity across regenerations (important for updates). |
| `description` | `string` | | `DESCRIPTION`. |
| `location` | `string` | | `LOCATION`. |
| `url` | `string` | | `URL` — must be an absolute http(s) link; other schemes (`javascript:`, `data:`, …) are rejected, and values containing control characters throw. |
| `status` | `string` | | `CONFIRMED` / `TENTATIVE` / `CANCELLED`. |
| `categories` | `string[]` | | `CATEGORIES`. |
| `rrule` | `string` | | Raw rule, e.g. `FREQ=WEEKLY;BYDAY=MO,WE,FR` or `FREQ=MONTHLY;COUNT=6`. Rejected if it contains control characters (CR/LF injection). |
| `alarms` | `Array<{trigger, description?, action?}>` | | `trigger` is a minute number (`-15`) or an ISO 8601 duration string (`-PT30M`, `-P2D`, …). Each array entry emits its own `VALARM` inside that event's `VEVENT`, so every event — and every reminder of an event — is independent. `description` defaults to the event title. Any value containing control characters throws. |
| `attendees` | `Array<{email, name?, role?, status?, rsvp?}>` | | Emitted as `ATTENDEE;CN=…;ROLE=…;PARTSTAT=…:mailto:…`. `email` is validated (non-empty local part + dotted domain, no whitespace); `name`, `role` and `status` must not contain control characters. |
| `organizer` | `{email, name?}` | | Emitted as `ORGANIZER;CN=…:mailto:…`. `email` validated as above. |
| `transp` | `string` | | **(v2)** `OPAQUE` (busy, the default) or `TRANSPARENT` (free) → `TRANSP`. Emitted only when set; other values throw. |
| `priority` | `number` | | **(v2)** Integer 0–9 (1 highest, 9 lowest) → `PRIORITY`. Emitted when ≥ 1; `0`/omitted emit no line. Non-integers or values outside 0–9 throw. |

### `cal.updateEvent(indexOrEvent, options)` **(v2)**

Replaces the event at `indexOrEvent` (a numeric index or an existing `VEvent`)
with a new one built from `options`, in place — the new `VEvent` takes the same
slot, so list position is preserved. Options run through the same validation as
`addEvent`, and the replacement is built before the calendar is touched, so
invalid options throw without changing it. When `options.uid` is omitted, the
previous event's uid is carried over, keeping the event's identity stable
across regenerations. Returns the new `VEvent`, or `false` when the target does
not exist.

### `IcsGenerator.parse(text)` / `parseEvents(text)`

Reads RFC 5545 text into plain objects (needs `ics-parse.js`; loaded after
`ics.js` it extends the same global, and it also `require()`s in Node).

```js
const { calendar, events, warnings, counts } = IcsGenerator.parse(icsText);
```

`calendar` carries `X-WR-CALNAME`/`X-WR-CALDESC`; `events` is one object per
`VEVENT` with `start`/`end` as `Date` or `{year, month, day}`, plus `allDay`,
`timezone`, `rrule`, `alarms`, `organizer`, `attendees`, `categories`, `transp`
and `priority` **(v2)**, and an `unsupported` list; `warnings` explains anything
dropped or approximated — an unreadable `TRANSP` or `PRIORITY` value is
ignored with a note (`Ignored an unreadable TRANSP value.` / `Ignored an
unreadable PRIORITY value.`). A `DTEND` that is not after `DTSTART` is kept
rather than dropped — **(v2)** with the warning `DTEND is not after DTSTART;
kept as-is.` (v1 keeps it silently).
`parseEvents(text)` returns just the events. The reader handles line folding,
quoted parameters, TEXT unescaping, `TZID` (IANA and common Windows/Outlook
names), a `VTIMEZONE` fixed-offset fallback, `DURATION`, and all-day / floating
/ UTC date-times. It never touches the network or the DOM.

### `IcsGenerator.download(filename, text)`

Builds a Blob and triggers a file download in the browser. Pure client-side.

### Helpers

`escapeText()`, `foldLines()`, `formatDateTimeUTC(date)`, `formatDateUTC(dateOrParts)` — exported for your own tooling.

## What the generator emits

- **RFC 5545 line endings**: every line ends in `CRLF`.
- **Escaping**: `\`, `;`, `,` and newlines in text values are escaped (`,`/`;` in parameter values too); remaining C0 control characters are stripped from TEXT values.
- **Input hardening**: single-line values (URLs, emails, rules, status/role/action tokens, triggers) reject control characters, so untrusted input cannot inject extra lines into the generated `.ics`; `URL` is restricted to absolute http(s) links.
- **Line folding**: no line exceeds 75 octets (RFC 5545 §3.1); continuations are space-prefixed — Outlook and Exchange can reject long unfolded lines.
- **Timestamps**: times are emitted as UTC (`…Z`) by default; use `timezone` for a `TZID`-flavored wall-clock value. `DTSTAMP` is always UTC (required).
- **All-day events**: `DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE`. The end is exclusive, so an event on Jan 5 defaults to `DTEND` Jan 6.
- **Recurrence**: `RRULE` passthrough; when you provide a `UNTIL` date with a timed event, use UTC (`UNTIL=20260301T235959Z`), or date-only for all-day.
- **Calendar metadata**: `PRODID`, `VERSION:2.0`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, optional `X-WR-CALNAME`.
- **Reminders**: `BEGIN:VALARM / ACTION:DISPLAY / TRIGGER:-PT15M / END:VALARM`.

## Validating your output

- Paste the preview (or **Copy .ics**) into the validator at <https://icalendar.org/validator.html>.
- Import into Google Calendar / Outlook / Apple Calendar and check: special characters (`;` `,` `\` `&`), multi-line descriptions, a >75-char description (folding), an all-day multi-day event, a recurring event, and a timezone event.

## Security & web-form best practices

This page is a static, 100% client-side form — there is no server-side code, no
persistence, and no third-party runtime code except the Cloudflare Web
Analytics beacon injected by the host (visit counting only), so the classic
server-side attack classes (server-side injection, CSRF, auth bypass, SSRF,
SQL injection) do not apply. What does apply is the client-side half of the industry guidance
(OWASP Top 10:2025, OWASP Cheat Sheet Series, MDN), mapped below.

### Controls already in place (this repository)

- **Input validation** *(OWASP Top 10:2025 A05-Injection — which includes XSS,
  30k+ CVEs; OWASP Input Validation Cheat Sheet)* — validation happens as early
  as possible in the data flow, at the `IcsGenerator` boundary: single-line
  values (URLs, emails, recurrence rules, time zones, status/role/action
  tokens, alarm triggers) reject control characters (CR/LF line injection); `URL` is
  restricted to absolute `http(s)` links (no `javascript:`/`data:` schemes);
  attendee/organizer `mailto:` emails are format-checked.
- **Output encoding, never raw HTML** *(OWASP XSS Prevention / DOM-based XSS
  Cheat Sheets — avoid `innerHTML`, use safe DOM APIs)* — every DOM insertion
  uses `textContent` (zero `innerHTML`/`eval` across the codebase); for the
  `.ics` output, text values are escaped per RFC 5545 and residual C0 control
  characters are stripped, so input cannot inject extra lines or properties
  into the generated file.
- **Import is data-only** *(OWASP Input Validation Cheat Sheet)* — `ics-parse.js`
  never touches the network or the DOM; it caps input at 20,000 lines and 12
  levels of nesting and returns plain data. The demo reads dropped/picked files
  with `File.text()`/`FileReader` (2 MB cap) and renders every parsed value with
  `textContent`, so a hostile `.ics` cannot inject markup or script.
- **Content-Security-Policy** *(OWASP Top 10:2025 A02-Security Misconfiguration;
  OWASP CSP Cheat Sheet)* — a strict default-deny policy
  (`default-src 'none'`, `script-src 'self'`, no `'unsafe-inline'`) ships in a
  `<meta>` tag so it applies even on hosts that can't send headers (GitHub
  Pages). CSP is defense-in-depth, not a primary defense — it caps the blast
  radius if a DOM-XSS bug is ever introduced later.
- **Supply chain** *(OWASP Top 10:2025 A03-Software & Data Integrity)* — zero
  runtime dependencies and zero external requests; a page cannot be compromised
  through a dependency it doesn't have.

### Suggestions if you extend this app

- **Client-side validation is UX, not a security boundary** *(OWASP Input
  Validation Cheat Sheet; MDN)* — if a backend is ever added (e.g. an API that
  receives events), it must re-validate all input server-side. Front-end checks
  stop mistakes, not attackers.
- **Header-based hardening where the host supports it** — the `<meta>` CSP
  cannot carry `frame-ancestors` or `X-Frame-Options`; those require response
  headers *(OWASP CSP Cheat Sheet)*. Netlify (`_headers`), Cloudflare
  (`_headers`), and nginx (`add_header`) can add `frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS, and
  `Permissions-Policy`. GitHub Pages cannot send custom headers.
- **If inline scripts or external resources are ever added**, keep the CSP
  strict: prefer nonces or hashes over `'unsafe-inline'` *(OWASP CSP Cheat
  Sheet)*.
- **If a rich-text or WYSIWYG field is ever added**, never echo its value as
  HTML — sanitize with a maintained library (OWASP recommends DOMPurify) in
  addition to output encoding.
- **If any data is ever persisted** (e.g. `localStorage`), treat everything
  read back from storage as untrusted input on read *(OWASP HTML5 Security
  Cheat Sheet)*.
- **Serve `.ics` correctly**: hosts that already map `.ics` to
  `Content-Type: text/calendar` (Netlify, Cloudflare Pages) are fine — add your
  own mappings elsewhere if you host a shared `calendar.ics`, and pair with
  `nosniff`.
- **Re-audit on change**: after any change touching `ics.js`, re-run the
  validation checks in the test suite and re-import a generated file into a
  calendar client.

## Limitations

- **Modern browsers** are assumed (Blob, `Intl.DateTimeFormat`, `Array.from`, classes). No IE support.
- **No persistence** on a static host — fine for generating downloads, not for user accounts.
- **No server-side invitations** — attendees are `mailto:` links; the sender's mail client handles them.
- **Content-Security-Policy**: `index.html` ships a strict meta CSP (`default-src 'none'`, `script-src 'self'`, no inline script). The only third-party allowances are `https://static.cloudflareinsights.com` (script) and `https://cloudflareinsights.com` (connect) for the Cloudflare Web Analytics beacon that Pages auto-injects — cookie-free visit counting only; on hosts without injection (GitHub Pages, `file://`) the allowances are simply unused. `file:` sources are explicitly allowed so double-clicking `index.html` keeps working on every browser (scheme `'self'` cannot match local files). Works unchanged on `file://` in Chromium and Firefox. If you ever add inline handlers or external resources, adjust the meta tag or move the policy to response headers (Netlify `_headers`, Cloudflare `_headers`, nginx `add_header`, …). GitHub Pages cannot send custom headers, so the meta tag is the enforcement there.
- `TZID` events can optionally carry a generated `VTIMEZONE` component (v2's opt-in **Include VTIMEZONE blocks** checkbox), built from transitions sampled across the years the events span and therefore approximate for zones with exotic history; v1 at `/` still emits `TZID` without one.

## License

MIT — see [LICENSE](LICENSE).
