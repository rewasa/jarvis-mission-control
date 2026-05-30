# QA Smoke Test Results
**Date:** 2026-05-30
**App:** AI Event Studio (localhost:3000)
**Task:** t_745ea64f

---

## 1. Frontend Routes

| Route | Status | Notes |
|-------|--------|-------|
| `/` (Landing Page) | ✅ PASS | Hero, stats counter, feature cards, CTA all render. Nav shows "Event Studio" logo + "Jetzt loslegen". |
| `/events/create` (Event Wizard) | ✅ PASS | 3-step wizard (Event Basics → Wer wird gefeiert → Budget & Gäste). Type selector, title, date, location inputs. Weiter button disabled until valid. |
| `/events` (Event List) | ✅ PASS | Shows "Meine Events" heading, "Neues Event" button. Empty state with CTA. Renders event cards with type badge, date, title. |
| `/events/[id]` (Event Detail) | ✅ PASS | Event card with Party badge, title, inline-edit, info cards, sub-navigation tabs (Produkte/Geschenke/Design/Checkliste/Venues/AI-Suche). |
| `/events/[id]/products` | ✅ PASS | Product search/swipe interface with search box + category filters. Test Product shows in results. |
| `/events/[id]/gifts` | ✅ PASS | Gift management UI with counters (Total/Verfügbar/Zugewiesen) and "Eigenes Geschenk" button. |
| `/events/[id]/design` | ✅ PASS | Full design editor with canvas, elements panel, layers, size combobox, undo/redo, export/save. |
| `/events/[id]/venues` | ✅ PASS | Venue search with category buttons (Spielplatz, Restaurant, Café, Kino, Museum). |
| `/events/[id]/ai-search` | ✅ PASS | AI search interface with source filters (Alle/Neu/Übernommen/Amazon/Etsy). |
| `/events/[id]/checklist` | ❌ FAIL | 404 "Seite nicht gefunden". API routes exist but no frontend page. |
| `/design/editor` | ✅ PASS | Standalone design editor with canvas, tools (Text/Form/Bild), export/save, zoom controls. |

## 2. API Endpoints

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/events` | GET | ✅ PASS | Returns `{success: true, events: [...], total: N}` |
| `/api/events` | POST | ❌ BUG | Returns `{success: false, error: "Unauthorized: No valid session"}` |
| `/api/events` | PATCH | ✅ PASS | Updates event, returns updated record |
| `/api/events/stats` | GET | ✅ PASS | Returns events list with attendeeCount, productCount, hasDesign |
| `/api/designs` | GET | ✅ PASS | Returns `{success: true, designs: [], total: 0}` |
| `/api/attendees` | GET | ✅ PASS | Returns attendee list |
| `/api/attendees` | POST | ✅ PASS | Creates attendee, returns `{success: true, attendee: {...}}` |
| `/api/products` | GET | ✅ PASS | Returns product list |
| `/api/products` | POST | ✅ PASS | Creates product |
| `/api/gifts` | GET | ✅ PASS | Returns gift list (no event_id) |
| `/api/gifts?event_id=X` | GET | ✅ PASS | Returns gifts filtered by event |
| `/api/events/[id]/checklist` | GET | ⚠️ PARTIAL | Returns `{error: "Unauthorized"}` (needs auth) |

## 3. E2E Flow

Landing → "Jetzt loslegen" → Event Wizard → Fill form → Submit → Redirect

| Step | Status | Notes |
|------|--------|-------|
| Landing page loads | ✅ | |
| "Jetzt loslegen" link visible | ✅ | Two instances: nav bar + hero CTA |
| Event Wizard (/events/create) loads | ✅ | 3-step form renders correctly |
| Form submit | ❌ BLOCKED | POST /api/events returns auth error — cannot complete E2E through UI |

## 4. Bugs Found

### BUG-1: POST /api/events — "Unauthorized: No valid session" (CRITICAL)
**Route:** POST /api/events
**Status:** Confirmed
**Root Cause:** Mock auth mode is enabled in the Clerk middleware (`proxy.ts` checks `NEXT_PUBLIC_MOCK_AUTH` env var and returns `NextResponse.next()`), but server-side route handlers use `getUserId()` from `auth.ts` which checks `isMockAuthEnabled()` — a module-level boolean that starts `false` and is **never set to true** during server startup. `enableMockAuth(true)` is never called in any server-side initialization path.
**Impact:** Users cannot create events through the UI. The Event Wizard's submit step will fail after form validation.
**Workaround:** Create events directly via PocketBase API (`POST /api/collections/events/records`).
**Fix:** Either (a) have `getUserId()` check `process.env.NEXT_PUBLIC_MOCK_AUTH` directly when `isMockAuthEnabled()` returns false, or (b) call `enableMockAuth(true)` during server initialization based on env, or (c) have `getAuthenticatedPB()` fall back to unauthenticated PocketBase when auth fails instead of throwing.

### BUG-2: /events/[id]/checklist — 404 Page Not Found
**Route:** GET /events/[id]/checklist
**Status:** Confirmed
**Description:** The event detail page's navigation tabs include "Checkliste" as a tab, and API routes exist at `/api/events/[eventId]/checklist`, but no frontend page exists at `/events/[id]/checklist`. Clicking the tab leads to a 404 error page.
**Impact:** Broken navigation — checklist tab is a dead link.

### BUG-3: /api/events/stats returns events array instead of aggregate stats
**Route:** GET /api/events/stats
**Status:** Minor / Design issue
**Description:** The `/api/events/stats` endpoint returns the full events array with computed fields (`attendeeCount`, `productCount`, `hasDesign`) rather than aggregated statistics. This works but the naming "stats" is misleading — it returns filtered events rather than summary statistics.

### BUG-4: Events created through PocketBase API show as editable but user_id is empty
**Route:** GET /api/events → PATCH /api/events
**Status:** Minor
**Description:** Events created directly via PocketBase API (workaround) have an empty `user_id`. The PATCH endpoint allows editing them without ownership validation because it uses admin PB credentials. Not a bug per se in dev mode, but in production this would bypass RLS.

## 5. Summary

| Category | Passed | Failed | Partial |
|----------|--------|--------|---------|
| Frontend Routes | 10 | 1 (checklist) | 0 |
| API Endpoints | 11 | 1 (POST events) | 1 (checklist API) |
| E2E Flow | 3/5 | 2 blocked by BUG-1 | - |
| **Total** | **24** | **3** | **1** |

**Key finding:** BUG-1 (POST /api/events auth failure) is the most critical issue — it blocks the entire "create event" flow through the UI. The mock auth system is partially implemented: the Clerk middleware respects it, but server-side route handlers don't.
