# MKVBatchMux — UI/UX Audit & Windows 11 Redesign Direction

Audit date: 2026-08-28 · Version audited: 1.28.0

Sources of truth used (fetched, not recalled):
- [Fluent 2 — Typography](https://fluent2.microsoft.design/typography)
- [Windows 11 — Geometry (corner radius, spacing)](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/geometry)
- [Windows app silhouettes (layout margins)](https://learn.microsoft.com/en-us/windows/apps/design/basics/app-silhouette)
- [NavigationView guidance](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/navigationview)

---

## 1. What the app is

A Tauri + React desktop tool that batch-muxes MKV files via MKVToolNix. The user
journey is a pipeline: **load videos → attach external audio → attach subtitles →
chapters → attachments → configure mux → queue → run**.

Stack: React 18, Tailwind, shadcn/ui (Radix), lucide icons, Tauri v1 with
`decorations: false` (custom title bar).

## 2. What the design is today

### 2.1 Structure

```
┌────┬──────────────────────────────────────────┐
│    │ custom title bar (40px)  – + □ ×         │
│ na ├──────────────────────────────────────────┤
│ v  │ CommandBar (52px): title · search · ⚙ ⌨  │
│ ra ├──────────────────────────────────────────┤
│ il │ page content (p-5, gap-4)                │
│    │   config surface card                    │
│    │   data table / split panes               │
│    │   (Mux tab only) sticky action bar       │
└────┴──────────────────────────────────────────┘
```

- **Icon rail** (`SidebarNav`): 48px collapsed / 176px expanded, 6 destinations,
  collapse toggle pinned at bottom. Active state = tinted background + 3px left bar.
- **CommandBar**: page title left, search / filter / sort right, plus settings and
  shortcuts icon buttons.
- **Pages**: `PageLayout` = `flex flex-col h-full p-5 gap-4`. Each page is one or
  two "fluent-surface" cards over a virtualized table (`VideosTab` virtualizes past
  120 rows) or a two-pane video↔external split.
- **Dialogs**: `BaseModal` (64px header w/ icon + title + subtitle, scroll body,
  60px footer) and a lighter `DialogShell`. Options is a single long scroll.

### 2.2 Theme

`global.css` is already titled *"Windows 11 Fluent Theme"* and defines a full HSL
token set for **both** light and dark, with Fluent-ish spacing (`--space-1..6`),
row heights, and a Segoe UI Variable font stack in `tailwind.config.ts`. Accent is
`206 100% 42%` ≈ `#0078D4` — the correct Windows accent.

**But the screenshots in `docs/` show a gold/graphite theme.** They are stale: they
predate the Fluent token migration. The current code is mid-migration — which is the
single most important finding in this audit.

## 3. Findings

### A. The migration is half-finished — this is the core problem

The token layer says Fluent; a meaningful amount of the component layer still
hardcodes the old VS-Code-dark palette. 28 hardcoded hex values remain, and the
worst offenders are in the shared primitives every screen renders:

| File | Hardcoded value | Effect |
|---|---|---|
| `src/shared/ui/button.tsx:12-16` | `#1177bb`, `#0c5685`, `#2a2a2a` | Every button hover/active ignores the token system |
| `src/shared/ui/select.tsx:108` | `focus:bg-[#3a3a3a]` | Dropdown focus row is invisible in light mode |
| `src/shared/ui/progress.tsx:16` | `linear-gradient(#0066cc→#4cc2ff)` | Fixed gradient, not accent-aware |
| `global.css` (`.fluent-window-control`, `.fluent-button.*`, `.data-table__row:hover`, `.table-row.selected`) | `#3a3a3a`, `#d13438`, `#0e639c`, `#4fc3f7`, `rgb(255 255 255 / 0.04)` | Hover/selection states break entirely in light mode |

**Consequence:** the light theme defined at `global.css:9-81` is effectively
unusable. Dark-only hovers (`#3a3a3a` on a white card) and white-alpha row hovers
(invisible on white) mean flipping `Dark_Mode` produces a broken screen. The app
ships a theme it cannot actually render.

### B. Window chrome is not Windows 11

`decorations: false` + a hand-rolled title bar in `AppShell.tsx`, and it diverges
from the real thing:

- Caption buttons are `h-8 w-9` (32×36). Windows 11 spec is **46×32**, and the close
  button's hover red is right (`#d13438`) but the neutral hover `#3a3a3a` is hardcoded.
- The title bar sits **to the right of** the nav rail (`AppShell.tsx:36-38` renders
  `sidebar` as a sibling before the column containing the window bar). In every
  Windows 11 app the title bar spans the **full window width** above all content.
  This is the most visually "not-Windows" thing in the app.
- No snap-layouts support: the maximize button is a plain button, so hovering it
  doesn't offer Windows 11 snap layouts.
- No Mica. Windows 11 app base layers use Mica; this is flat `--background`.
- `isMaximized` is read once on mount and on click, never subscribed — resize or
  Win+Up leaves the icon stale (`AppShell.tsx:28-33`).
- Corners: window is `8px` per spec but nothing tells DWM to round, and the app
  doesn't drop rounding when maximized.

### C. Typography does not match the Fluent ramp

The Fluent 2 Windows ramp is Caption 12/16, Body 14/20, Body Strong 14/20,
Body Large 18/24, Subtitle 20/28, Title 28/36.

The app instead uses an ad-hoc micro-type scale: **92 occurrences of `text-[10px]`
and `text-[11px]`** across feature components, plus `text-[12px]`, `text-[13px]`,
`text-[18px]`. Body text is set to 14px globally (correct) but almost every label,
chip, section header, and table cell undercuts it.

10px and 11px text is **below the Fluent minimum of 12px** and is a real
accessibility problem on a 1080p Windows laptop at 150% scaling. Section headers are
also uppercase + letterspaced, which is a macOS/web idiom — Windows 11 uses
sentence-case Body Strong for section headers, not uppercase micro-caps.

`font-mono` maps to JetBrains Mono in Tailwind but `Consolas/Cascadia Mono` in CSS —
two conflicting definitions.

### D. Corner radius is inverted from the Windows rule

Spec: **8px for overlays** (dialogs, flyouts), **4px for in-page controls**
(buttons, inputs, list backplates).

The app sets `--radius: 8px` and derives `md: 6px`, `sm: 4px` — then applies
`rounded-lg` (8px) to in-page surfaces and cards, and `rounded` / `rounded-md` to
buttons and inputs. Net effect: in-page elements are rounder than the spec and
overlays are inconsistent (`dialog-shell` is `rounded-lg`, `base-modal` is
`rounded-xl` = 12px, which matches nothing).

### E. Navigation diverges from NavigationView

Per the docs, NavigationView adapts: expanded pane ≥1008px, LeftCompact 641–1007px,
LeftMinimal below; settings lives as a **footer item in the pane**; the selection
indicator is a **rounded pill on the leading edge**.

The app: fixed manual collapse only (no adaptive breakpoints), Settings is a gear
icon in the CommandBar instead of a pane footer item, and the active indicator is a
square-ish 3px bar plus a tinted *bordered box* — the border makes it read as a
selected checkbox rather than a nav selection.

Expanded pane is 176px; Windows default is 320px, and 176px truncates "Attachments".

### F. Information architecture — the real UX problem

The six destinations are **not peers**; they are stages of one pipeline with hard
dependencies. Audio, Subtitles, Chapters and Attachments are all meaningless until
Videos are loaded, and Mux Settings is meaningless until the others are configured.
Yet the nav presents them as six equivalent tabs with no state, no progress, and no
gating.

Concretely:
- Nothing in the rail shows how many files are loaded, which stages are configured,
  or which have problems. You must visit a tab to learn its state.
- Errors surface far from their cause: unlinked external files are detected in
  `WorkspacePage` but only reported as a warning banner inside the Mux Settings tab
  (`MuxSettingTab.tsx:491-503`), which is 4 clicks from the Audio tab where you'd fix it.
- "Start Muxing" — the app's entire purpose — is buried at the bottom of the sixth
  tab. There is no global primary action.
- Progress during a run is only visible on the Mux tab; navigate away and you lose
  all feedback. There's no taskbar progress and no completion notification, both of
  which are standard Windows behaviors for long jobs.

### G. Density and layout inconsistency

- Page padding is `p-5` (20px). Windows utility apps use 12–16px margins; Settings-
  style apps use 24–56px. 20px matches neither, and combined with nested card
  padding (`px-4 py-3` inside `p-5` inside a card) the content area loses ~15% of
  horizontal space to chrome on a 1280px window — the default window size.
- Control heights are inconsistent: `--control-height: 32px` is the token, but the
  codebase uses `h-7` (28), `h-8` (32), `h-9` (36) interchangeably, sometimes in the
  same row (`AudiosTab` edit dialog uses `h-9` fields next to `h-7` buttons).
- The `VideosTab` footer has an `Actions` button that is **permanently disabled**
  (`VideosTab.tsx:706`) — dead UI.
- Two different table implementations: `DataTable` (Videos) and hand-rolled CSS grid
  rows (`MuxSettingTab`, `file-item-audio`). They have different row heights (44 vs
  44 vs 40), different hover treatments, and different selection styling.
- `.workspace-split { height: calc(100vh - 280px) }` is a magic number that will
  break with any chrome height change.

### H. Accessibility

- Only **6 files** contain any `aria-label`, while **45** interactive elements rely on
  `title=` alone. `title` is not announced reliably by NVDA/Narrator and never
  appears for keyboard users on Windows.
- Icon-only buttons (browse / rescan / clear, present on 4 tabs) are labeled — but
  the many `panel-icon-btn` row actions are not.
- Focus ring is `ring-2 ring-ring ring-offset-2` globally, which is decent, but
  `:focus-visible` is set on `*` so it also fires on non-interactive divs used as rows.
- Table rows are `<div>` with `onClick`, not `role="row"`/`<tr>` with keyboard
  handling. Multi-select works with Ctrl/Shift by mouse only — **there is no keyboard
  path to select files**, and no arrow-key navigation in any list.
- No `prefers-reduced-motion` handling despite spinners and transitions.
- Status is color-coded only (job status chips at `MuxSettingTab.tsx:662-671`) — the
  text label saves it, but the warning triangle relies on a `title` tooltip.

### I. Feedback and error handling

- 37 `toast()` calls, but toasts are the *only* error surface for backend failures.
  A failed mux job shows status `error` in the row with no reason and no way to see
  the reason without opening the log file externally.
- The scan overlay (`fluent-loading-overlay`) is a **modal blocker** over the whole
  window for something that is cancellable and streams results — it should be
  non-blocking inline progress, since the table is already populating behind it.
- No confirmation on destructive "Clear" (clears the whole queue) or on the X that
  wipes the loaded file list.
- No empty-state affordance for the *first run* — the app never explains that it
  needs MKVToolNix and MediaInfo until something fails.

### J. Smaller things

- `index.html` still carries `og:`/`twitter:` meta tags — leftover web scaffolding
  in a desktop app.
- Title bar shows "MKVBatchMux · By Ionicboy" — attribution in the title bar is
  unusual; it belongs in an About dialog.
- Keyboard shortcuts use `event.key === 'o'` etc., which **breaks with Caps Lock on**
  and doesn't respect layout; also `Ctrl+N`/`Ctrl+O` are claimed but no menu shows them.
- The app has no menu bar at all, so there is no discoverable path to Options,
  About, or Help other than two unlabeled icons.
- 2245-line `AudiosTab.tsx` and 1795-line `SubtitlesTab.tsx` are near-duplicates of
  each other — a redesign should extract one shared "external track tab".

---

## 4. Redesign direction — a real Windows 11 app

### 4.1 Foundations to fix first

| Item | Spec | Change |
|---|---|---|
| Corner radius | 4px controls / 8px overlays | `--radius-control: 4px`, `--radius-overlay: 8px`; stop using `rounded-lg` on buttons/inputs, stop `rounded-xl` on modals |
| Type ramp | Caption 12/16 · Body 14/20 · Body Strong 14/20 · Subtitle 20/28 · Title 28/36 | Delete all `text-[10px]`/`text-[11px]`; add `.type-caption`, `.type-body`, `.type-body-strong`, `.type-subtitle`, `.type-title` |
| Font | Segoe UI Variable | Already correct in Tailwind; fix the conflicting mono stack |
| Color | Fluent neutrals + system accent | Purge all 28 hardcoded hex values into tokens; make light mode actually work |
| Accent | Read the user's Windows accent color | Tauri can read it; fall back to `#0078D4` |
| Elevation | Mica base, card fills | Mica on window background, `CardBackgroundFillColorDefault` for surfaces |
| Spacing | 4px grid, 12–16px page margins | Replace `p-5` with 16px; kill nested double-padding |
| Controls | 32px standard height | Enforce `--control-height: 32px` everywhere; retire `h-7`/`h-9` |

### 4.2 Shell

Full-width title bar across the top (spanning the nav rail), 32px tall, with
46×32 caption buttons and snap-layout support on maximize. App name + icon on the
left, no attribution. Mica background.

Below it, a proper NavigationView:
- Adaptive: expanded ≥1008px, compact icon-rail 641–1007px, overlay below.
- 320px expanded pane, 48px compact.
- Pill selection indicator on the leading edge, no border box.
- **Settings as a pane footer item**, not a CommandBar gear.
- **Each destination carries a badge**: file count, configured-track count, or a
  warning dot. This is the single highest-value change in the redesign — it turns
  six opaque tabs into a visible pipeline state.

### 4.3 Persistent command surface

Promote the run controls out of the Mux tab into a persistent bottom command bar
present on every page:

```
[ 24 files · 3 audio · 2 subtitle · ⚠ 1 issue ]        [ Validate ] [ ▶ Start Muxing ]
```

During a run it becomes a progress strip (current file, overall %, ETA, Pause/Stop),
mirrored to the Windows taskbar progress indicator, with a toast on completion.
This means the app's primary action is always one click away and progress is never
hidden behind navigation.

### 4.4 Pages

- **Videos**: keep the table; make it a real `role="grid"` with arrow-key navigation
  and Space/Ctrl+Space selection. Replace the blocking scan overlay with an inline
  determinate progress bar under the CommandBar. Drop the dead "Actions" button;
  move Remove into a right-click ContextMenu and a keyboard `Delete`.
- **Audio / Subtitles**: collapse the two 2000-line near-duplicates into one shared
  component parameterized by track kind. Keep the two-pane video↔file layout but
  give it a real splitter, and show link status inline per row (linked/unlinked)
  instead of deferring the error to the Mux tab.
- **Mux Settings**: convert to Windows 11 Settings-style **expander cards** — one
  card per group (Output, Cleanup, Track rules, Safety, Logging), each collapsed to a
  single summary row. This is the native pattern and would replace the current
  dense checkbox grid, which is the least Windows-like screen in the app.
- **Queue**: give the job list a per-row failure reason and an inline "view log"
  affordance, rather than a toast that disappears.

### 4.5 Accessibility pass

Real `aria-label` on every icon-only control (replacing `title`-only), keyboard
navigation in all lists, `role="grid"` tables, `prefers-reduced-motion`, minimum
12px type, and a visible focus ring scoped to actually-interactive elements.

---

## 5. Suggested sequence

1. **Foundations** — tokens, purge hardcoded hex, type ramp, radius, spacing. Nothing
   visual is "designed" yet, but light mode starts working and the drift stops.
2. **Shell** — full-width title bar, Mica, adaptive NavigationView with badges,
   settings in the pane footer.
3. **Persistent command bar** — global run controls + taskbar progress.
4. **Pages** — Videos grid/a11y, unify Audio+Subtitles, Mux Settings expanders.
5. **Polish** — context menus, keyboard map, first-run prerequisite check, About dialog.

Steps 1 and 2 give most of the "it looks like a Windows app" payoff; step 3 gives
most of the usability payoff.
