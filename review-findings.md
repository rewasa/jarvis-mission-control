# Code Review Findings — Frontend Changes

**Review Date:** 2026-05-30  
**Repository:** aieventstudio  
**Reviewer:** @reviewer  
**Files Reviewed:** 6  
**Branches:** kanban/landing-page-ux, main (events + create + detail + editor are on main)

---

## Summary

Overall code quality is **good — no blockers**. The UI is functional, well-structured with extracted sub-components, proper `memo()` usage, correct `useCallback` dependencies, and solid TypeScript strict mode. Main deficiencies are in accessibility (focus rings, aria-labels on icon buttons, modals), error handling (empty catch blocks, `alert()`/`confirm()`), and CSS variable usage (heavy reliance on hardcoded hex colors).

---

## BLOCKER (0) — None found

No issues that prevent deployment or break core functionality.

---

## WARNING (10) — Should fix before production

### W1. Missing focus-visible styles on all interactive elements
**Files:** ALL — global issue  
**Impact:** Keyboard-only users cannot see which element is focused. WCAG 2.4.7 failure.

Every interactive element (buttons, links, inputs, selects) throughout all 6 files lacks `focus-visible:ring-*` styles. Tailwind's Preflight resets outlines, so keyboard users see zero focus indication.

**Fix:** Add `focus-visible:ring-2 focus-visible:ring-purple-500` to all interactive elements. Consider a global Tailwind plugin or `@layer base { *:focus-visible { @apply ring-2 ring-purple-500; } }`.

---

### W2. Icon-only buttons missing aria-labels
- `app/design/editor/page.tsx`: Lines 217-219 (emoji back button `←`), 240-258 (mobile toolbar: text/rect/image/undo/redo/delete), 280-287 (zoom), 296-308 (desktop sidebar tools), 315-329 (undo/redo/duplicate/delete)
- `app/events/[id]/page.tsx`: Lines 1410-1418, 1446-1449 (product card icon buttons), 1072 (modal close button)

**Impact:** Screen reader users cannot identify these controls.

**Fix:** Add `aria-label` to all icon-only buttons.

---

### W3. `as unknown as T` type safety escapes
**File:** `app/events/[id]/page.tsx`, Lines 132-134
```typescript
setEvent(eventData as unknown as Event);
setProducts(productsData as unknown as Product[]);
setAttendees(attendeesData as unknown as Attendee[]);
```
**Impact:** Silences all type mismatches between repository return types and local interfaces. The local `Event` interface (lines 19-34) duplicates and may diverge from `@/types/api`.

**Fix:** Import `Event` from `@/types/api` directly. Remove the double casts. Add proper null handling per fetch call.

---

### W4. `confirm()` / `alert()` for user interaction — blocking, inaccessible
**File:** `app/events/[id]/page.tsx`, Lines 259, 276-278, 294, 306, 311, 317, 1661, 1664, 1676, 1685, 1706

**Impact:** `confirm()` blocks the main thread and doesn't integrate with React's rendering. `alert()` is invisible to screen readers. The `(err as any)?.message` pattern on errors also leaks implementation details.

**Fix:** Replace all `confirm()` with a React `ConfirmDialog` modal component. Replace `alert()` with a toast/snackbar system or inline error messages.

---

### W5. No AbortController on data-fetching useEffects
- `app/design/editor/page.tsx`: Lines 43-48 (load event), 52-74 (load saved design)
- `app/events/create/page.tsx`: Lines 211-223 (locate detection)

**Impact:** Stale responses can update unmounted components (React 18+ logs warnings). Race condition on re-mount.

**Fix:** Add `AbortController` to each `useEffect` and clean up in the return function.

---

### W6. Empty catch blocks swallow errors
**File:** `app/design/editor/page.tsx`
- Line 48: `.catch(() => { /* ignore */ })` — network errors silently ignored
- Lines 67-70: `catch { console.log('[Load] No saved design') }` — mislabels network errors as "no data"

**Impact:** Users see a blank editor with no indication of failure. Debugging requires reading console logs.

**Fix:** Surface errors to the user. At minimum log error details and set an error state for UI feedback.

---

### W7. No save debouncing — Design Editor hits the server on every keystroke
**File:** `app/design/editor/page.tsx`, Lines 118-130 (`updateElements`)

`updateElements` calls `saveToPocketBase` on every element change — including during drag/resize operations. Each save also does a **GET + then PUT/POST** (2 round-trips per change).

**Impact:** Server load proportional to user interaction frequency. Risk of race conditions from overlapping saves.

**Fix:** Debounce save calls (300-500ms). Cache existing record ID to avoid GET-before-write pattern.

---

### W8. No loading/error state isolation in Promise.all
**File:** `app/events/[id]/page.tsx`, Lines 121-135

```typescript
const [eventData, productsData, attendeesData] = await Promise.all([...]);
```
**Impact:** If one fetch fails (e.g. products), all three fail. The entire page shows an error instead of gracefully degrading.

**Fix:** Use `Promise.allSettled` or individual try/catch per call with per-source error state.

---

### W9. Fire-and-forget `fetch('/api/agent')` without id guard
**File:** `app/events/create/page.tsx`, Lines 366-384

The gift search agent POST fires immediately after form submit without checking `record.id` is defined. If the API returns success without an id, the request goes with `eventId: undefined`.

**Impact:** Silent failure of automatic gift search. No user feedback.

**Fix:** Add `if (!record?.id) return;` guard before the fetch call.

---

### W10. No `<main>` landmark element
**File:** `app/components/LandingPage.tsx`, Line 128

All hero/stats/features/CTA content is wrapped in a plain `<div>` instead of `<main>`.

**Impact:** Screen reader users cannot jump directly to the primary content.

**Fix:** Change the root wrapper `<div>` to `<main>`.

---

## NIT (8) — Nice to have improvements

### N1. Hardcoded hex colors throughout all files
All 6 files use `bg-[#0A0A0C]`, `text-[#6B7280]`, `text-[#9CA3AF]`, `bg-purple-500`, etc. directly instead of CSS custom properties. While the project uses CSS variables in `globals.css` (`--background: #0A0A0C`, `--mist-gray: #9CA3AF`, etc.), the components don't reference them.

**Fix:** Replace with CSS variables or design tokens (e.g., `bg-background`, `text-mist-gray`).

---

### N2. Emoji usage where lucide-react icons are available
- `app/events/create/page.tsx`: Lines 14-22 (event type buttons use emoji `🎂` `💒` `🎊` etc.), 137 (`aria-hidden`), 406, 484, 669 (section headers with `📅` `🎁` `💰`), 771 (`←`), 794 (`→`), 807 (`⏳` loading spinner)
- `app/design/editor/page.tsx`: Line 217 (`←` emoji back button)

The task spec says "Icons von lucide-react (keine Emojis)".

**Fix:** Replace emoji with lucide-react equivalents.

---

### N3. `console.log()` with eslint-disable comments
**File:** `app/design/editor/page.tsx`, Lines 64-65, 68-69, 109, 112

4 instances of `// eslint-disable-next-line no-console` paired with `console.log()`.

**Fix:** Remove debug logging or gate behind a `DEBUG` env variable.

---

### N4. No `prefers-reduced-motion` support
All animation files lack `@media (prefers-reduced-motion: reduce)` support. Framer-motion animations in `LandingPage.tsx` (fade-in, counter, scroll indicator), CSS `animate-float` on gradient orbs, and `transition-all` on form elements all play unconditionally.

**Fix:** Use framer-motion's `useReducedMotion()` hook and CSS media queries to disable/respect reduced motion preferences.

---

### N5. Date locale inconsistency: `de-CH` vs `de-DE`
- `app/events/[id]/page.tsx`, Line 458: `toLocaleDateString('de-CH')` (Swiss locale)
- `app/events/[id]/page.tsx`, Line 2115: `toLocaleDateString('de-DE')` (German locale)
- `app/events/page.tsx`: `toLocaleDateString('de-DE')` (German locale)

**Impact:** Same event shown on the same page may format dates differently.

**Fix:** Standardize on one locale (likely `de-CH` for Swiss context) or make locale configurable.

---

### N6. `key={f.title}` assumes hardcoded titles are unique
**File:** `app/components/LandingPage.tsx`, Line 295

Hardcoded feature titles are unique today, but a future duplicate would cause React reconciliation bugs.

**Fix:** Add a stable `id` field to the features array.

---

### N7. No pagination on events fetch
**File:** `app/events/page.tsx`, Line 210

`fetch('/api/events')` with no limit/offset/page. A user with hundreds of events loads all at once.

**Fix:** Add `?page=1&perPage=50` (or similar) to the fetch URL and implement pagination or virtual scrolling.

---

### N8. Gender mapping uses nested ternary
**File:** `app/events/[id]/page.tsx`, Lines 468-472

```typescript
{event.honoree_gender === 'female'
  ? (event.honoree_age && event.honoree_age < 18 ? 'Mädchen' : 'Frau')
  : event.honoree_gender === 'male'
  ? (event.honoree_age && event.honoree_age < 18 ? 'Junge' : 'Mann')
  : 'Divers'}
```

**Fix:** Extract to a function or lookup table with age-aware labels.

---

## Per-File Summary

| File | Lines | Warnings | Nits | Notes |
|------|-------|----------|------|-------|
| `app/page.tsx` | 13 | — | — | Clean server component. No error boundary on `currentUser()`. |
| `app/components/LandingPage.tsx` | 365 | W1, W10 | N1, N4, N6 | Well-typed CSS variable usage on root wrapper. Good a11y on decorative elements. |
| `app/events/page.tsx` | 312 | W1 | N1, N5, N7 | Clean list component. Loading/Error/Empty states properly handled. |
| `app/events/[id]/page.tsx` | 2213 | W1-W4, W8, W9 | N1, N5, N8 | Largest file. Good memo/sub-component pattern. Major a11y and type issues. |
| `app/design/editor/page.tsx` | 389 | W1-W2, W5-W7 | N1-N3, N4 | Functional editor. No save debouncing = excessive API calls. |
| `app/events/create/page.tsx` | 823 | W1, W5, W9 | N1, N2, N4 | Well-structured wizard. Emoji vs icon inconsistency. |

---

## Decision

**REVIEW PASSED — NO BLOCKERS.** The code is functional, buildable, and meets the feature requirements. All issues are fixable as follow-up improvements.

**Before production launch, prioritize:**
1. Focus-visible styles (global fix)
2. Aria-labels on icon-only buttons
3. AbortController on all useEffects
4. Replace `alert()`/`confirm()` with React components
5. Remove `as unknown as T` casts
