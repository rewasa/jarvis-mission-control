# AgentControl Kanban Sync + GitHub Status Implementation Plan

> **For Hermes:** Use kanban-orchestrator / subagent-driven-development to execute this plan task-by-task. Code workers must use isolated git worktrees from `origin/main`, use Code Intel first, commit scoped changes, push branches, and open PRs. Do not merge PRs.

**Goal:** AgentControl should automatically mirror externally-created Hermes Kanban child tasks into the matching AgentControl parent task, show real Kanban status/logs/profile in subtasks, and surface linked GitHub PR + GitHub Actions/check status on every relevant card.

**Architecture:** Build this in AgentControl, not by patching Hermes core. AgentControl already reads the Hermes Kanban SQLite board and creates Kanban tasks for delegated subtasks. Extend that bridge into a bidirectional sync layer: poll/refresh Kanban parent-child relationships and task events from SQLite, persist mapping into AgentControl tasks, and optionally accept future Hermes webhook/plugin notifications to trigger the same sync endpoint. GitHub enrichment is a separate server service using `gh`/GitHub API plus cached DB columns, displayed by existing card/detail UI.

**Tech Stack:** TypeScript, Express, better-sqlite3, React/Vite, WebSocket board events, Hermes Kanban SQLite + CLI, GitHub CLI/API.

---

## Current State / Gap Analysis

Already present on `origin/main`:

- `server/services/kanban-bridge.ts` can:
  - create Hermes Kanban tasks via CLI,
  - read Kanban task info from `~/.hermes/kanban/boards/jarvis-mission-control/kanban.db`,
  - read task events, runs, comments.
- `server/routes/tasks.ts` creates a real Kanban task when an AgentControl delegated subtask is created.
- `shared/types.ts` already has `Task.hermes_kanban_task_id` and `Task.delegation_profile`.
- UI already has endpoints and detail panel for Kanban logs.

Missing:

1. AgentControl does not import external Kanban children into `Task.parent_task_id` subtasks.
2. No generic sync job/endpoint exists to reconcile Kanban status back into AgentControl status/delegation status.
3. No Hermes webhook/plugin subscription is wired to notify AgentControl on Kanban changes.
4. No GitHub PR/check-run metadata is stored or shown on cards/details.
5. No end-to-end smoke proves: create parent + external Kanban child -> AgentControl subtask appears -> logs/content visible -> linked PR/CI status visible.

## Decision: Hook vs Plugin vs Polling

Use a hybrid, safe path:

1. **Primary v1:** AgentControl polling + manual sync endpoint.
   - Most reliable because Hermes Kanban state is already persisted in SQLite.
   - No Hermes core changes and no dependence on webhook event availability.
   - Fast enough with a 10-30s interval for local AgentControl.

2. **Optional trigger:** Hermes webhook/plugin as a notifier only.
   - A Hermes plugin can register a `post_tool_call` hook and POST to AgentControl when tools like `kanban_create`, `kanban_complete`, `kanban_comment`, etc. run inside Hermes sessions.
   - This cannot catch every CLI-only Kanban mutation unless Hermes CLI itself emits hook events for CLI commands, so it should trigger sync, not be source of truth.
   - Also create `POST /api/integrations/hermes/kanban-sync` so webhook/plugin/cron can call the same reconciliation path.

Do not patch Hermes core for v1. If later we need full event-driven CLI hooks, implement upstream Hermes event emission separately.

## Data Model Additions

Extend AgentControl `tasks` table and `Task` type with:

- `github_pr_url TEXT NULL`
- `github_pr_number INTEGER NULL`
- `github_pr_state TEXT NULL` (`OPEN`, `MERGED`, `CLOSED`, etc.)
- `github_pr_head_ref TEXT NULL`
- `github_pr_head_sha TEXT NULL`
- `github_checks_status TEXT NULL` (`pending`, `success`, `failure`, `cancelled`, `skipped`, `unknown`)
- `github_checks_summary TEXT NULL`
- `github_checks_updated_at INTEGER NULL`
- optional: `external_source TEXT NULL` (`agentcontrol`, `hermes-kanban-sync`)

Keep `hermes_kanban_task_id` as the canonical Kanban mapping.

## Status Mapping

Kanban -> AgentControl:

- Kanban `todo`, `ready`, `running` => AgentControl `status = in_progress`
- Kanban `blocked` => AgentControl `status = in_progress`, `delegation_status = blocked`
- Kanban `done` => AgentControl `status = in_review`, `delegation_status = review`
- Kanban `archived` => no destructive AgentControl delete; keep card and mark `delegation_status = done` only if it had completed, otherwise leave with last known state.

GitHub checks:

- Any failing check conclusion (`failure`, `timed_out`, `action_required`) => `github_checks_status = failure`
- Any pending/queued/in_progress check and no failures => `pending`
- All completed with `success`, `neutral`, or `skipped` => `success`
- No PR/sha/check data => `unknown`

## Task Graph

T1 Backend: Kanban external child sync + status reconciliation.
T2 Backend: GitHub PR/check enrichment service and API integration.
T3 Frontend: Card/detail UI for Kanban sync + GitHub PR/Actions status.
T4 QA: End-to-end smoke with real Kanban task/subtask and real/fixture GitHub status, plus docs of proof.

Dependencies:

- T1 and T2 can run in parallel.
- T3 depends on T1 and T2 type/API shape.
- T4 depends on T1-T3.

---

### Task 1: Backend Kanban External Child Sync

**Objective:** Reconcile external Hermes Kanban child tasks into AgentControl subtasks and keep subtask status/profile/log links current.

**Files:**

- Modify: `server/services/kanban-bridge.ts`
- Modify: `server/db/index.ts`
- Modify: `server/db/queries.ts`
- Modify: `server/routes/tasks.ts`
- Modify: `shared/types.ts`
- Test/Add: whichever test harness exists for server route smoke; if no harness exists, add a small script under `scripts/smoke/kanban-sync-smoke.mjs` or document curl smoke in this plan.

**Implementation steps:**

1. Inspect current Kanban DB schema with `sqlite3 ~/.hermes/kanban/boards/jarvis-mission-control/kanban.db '.schema tasks' '.schema task_edges' '.schema task_events'`.
2. Add bridge functions:
   - `getKanbanChildren(parentKanbanId: string): KanbanTaskInfo[]`
   - `findKanbanTaskByAgentControlTaskId(taskId: string): KanbanTaskInfo | null` by scanning task body/events metadata for `AgentControl parent task:` and `AgentControl subtask id:` markers.
   - `syncKanbanChildrenForTask(parentTask: Task): SyncResult`
3. For parent AgentControl tasks with `hermes_kanban_task_id`, import each Kanban child whose id is not already mapped to an AgentControl task:
   - create `insertTask` with `parent_task_id = parent.id`, `title/body/status` from Kanban,
   - set `hermes_kanban_task_id`, `delegation_profile`, `delegation_status`, `external_source`.
4. For existing mapped subtasks, update status/delegation profile from Kanban without overwriting user-edited title/description unless still matching old imported value.
5. Add endpoint:
   - `POST /api/tasks/:id/kanban/sync` returns `{ parent, subtasks, imported, updated }`.
   - `POST /api/integrations/hermes/kanban-sync` accepts `{ taskId?, kanbanTaskId? }` and runs targeted sync or full lightweight sync.
6. Broadcast `task_created`/`task_updated` events for imported/updated tasks so the UI updates live.
7. Add idempotency: repeated sync must not create duplicates.

**Acceptance criteria:**

- Given an AgentControl parent task mapped to Kanban task `K_PARENT`, and a Hermes Kanban child `K_CHILD` linked under it, calling `POST /api/tasks/:parentId/kanban/sync` creates exactly one AgentControl subtask mapped to `K_CHILD`.
- Calling the same endpoint again imports `0` and does not duplicate.
- Kanban child status/profile changes update the AgentControl subtask.
- Existing `/api/tasks/:subtaskId/kanban` and `/api/tasks/:subtaskId/kanban/logs` work for imported subtasks.

**Verification commands:**

```bash
npm run build
AGENTCONTROL_HOME=/tmp/agentcontrol-kanban-sync-smoke PORT=7482 npm run dev
curl -fsS http://127.0.0.1:7482/api/health
# create parent via API, create/link Kanban child via hermes CLI, call sync endpoint, verify subtasks/logs JSON with jq
```

---

### Task 2: Backend GitHub PR + Actions Status Enrichment

**Objective:** Detect linked GitHub PRs from task/kanban content, fetch PR state and GitHub Actions/check status, persist it on tasks, and expose refresh endpoints.

**Files:**

- Create: `server/services/github-status.ts`
- Modify: `server/db/index.ts`
- Modify: `server/db/queries.ts`
- Modify: `server/routes/tasks.ts`
- Modify: `shared/types.ts`

**Implementation steps:**

1. Add DB columns listed in the Data Model section.
2. Add helper functions in `github-status.ts`:
   - `extractGitHubPrRefs(text: string): Array<{ owner: string; repo: string; number: number; url: string }>`.
   - `fetchPrStatus(ref): Promise<GitHubPrStatus>` using `gh pr view --repo owner/repo number --json url,number,state,headRefName,headRefOid,statusCheckRollup,mergeStateStatus` first.
   - Fallback to `git remote get-url origin` + `gh pr list --head` if only a branch is present in Kanban metadata.
   - Normalize `statusCheckRollup` to the status mapping above.
3. Scan sources in this order:
   - AgentControl task description/title.
   - Kanban task body/comments/latest run summary/error/metadata.
   - Existing `github_pr_url` if already stored.
4. Add service `refreshTaskGitHubStatus(task: Task): Promise<Task | null>`.
5. Add endpoints:
   - `GET /api/tasks/:id/github` returns current stored status, optionally `?refresh=1`.
   - `POST /api/tasks/:id/github/refresh` refreshes and broadcasts `task_updated`.
6. In Kanban sync (Task 1), call GitHub refresh best-effort when imported/updated task contains a PR URL.

**Acceptance criteria:**

- A task description containing `https://github.com/rewasa/jarvis-mission-control/pull/11` is enriched with PR number, URL, state, head ref/SHA, and normalized checks status.
- Failed/pending/success checks produce correct normalized state.
- If `gh` auth is missing, endpoint degrades gracefully with `github_checks_status = unknown` and a clear summary, not a 500.

**Verification commands:**

```bash
npm run build
node -e "import('./dist/server/services/github-status.js').then(async m => console.log(m.extractGitHubPrRefs('PR https://github.com/rewasa/jarvis-mission-control/pull/11')))"
curl -fsS -X POST http://127.0.0.1:7482/api/tasks/$TASK_ID/github/refresh | jq
```

---

### Task 3: Frontend Card + Detail UI

**Objective:** Show Kanban profile/status/log availability plus GitHub PR and Actions status in task cards and task details.

**Files:**

- Modify: `client/src/components/TaskCard.tsx`
- Modify: `client/src/components/TaskDetailPage.tsx`
- Modify: `client/src/lib/api.ts`
- Modify: `client/src/lib/store.ts` only if needed for WebSocket updates.
- Modify: `shared/types.ts` if frontend needs extra response types.

**Implementation steps:**

1. Extend `Task` display to include compact badges:
   - Kanban: `Kanban: <status> · <profile>` when `hermes_kanban_task_id` exists.
   - GitHub: `PR #n <state>` and `Actions <status>` when PR data exists.
2. In detail page, add a panel section:
   - linked Kanban ID with status/profile,
   - button `Sync Kanban` calling `POST /tasks/:id/kanban/sync`,
   - linked PR URL,
   - Actions/check summary,
   - button `Refresh GitHub` calling `POST /tasks/:id/github/refresh`.
3. Reuse existing styling; no large redesign.
4. Ensure mobile subtasks rail shows enough metadata to tell whether a subtask is a real Kanban task.

**Acceptance criteria:**

- Subtask cards visibly show real Kanban profile/status.
- Cards with linked PR show PR number/state and Actions status.
- Detail buttons work and update without reload.
- Empty states do not clutter normal tasks without Kanban/PR data.

**Verification commands:**

```bash
npm run build
# Browser smoke at http://127.0.0.1:7482/tasks/<parentId>
# Confirm imported subtask card shows Kanban and GitHub badges.
```

---

### Task 4: QA Smoke + Proof Task/Subtask

**Objective:** Prove the full feature against a real AgentControl task and a real Hermes Kanban child task, including logs/content and GitHub status.

**Files:**

- Create/Modify: `docs/plans/2026-05-27-kanban-sync-github-status.md` verification section or `docs/verification/2026-05-27-kanban-sync-github-status.md`.

**Smoke recipe:**

1. Start AgentControl isolated:

```bash
AGENTCONTROL_HOME=/tmp/agentcontrol-kanban-sync-smoke PORT=7482 npm run dev
```

2. Create an AgentControl parent task via API.
3. Create or map a Hermes Kanban parent task and persist `hermes_kanban_task_id` on the AgentControl parent if needed.
4. Create a Hermes Kanban child with body including:

```text
AgentControl parent task: <title> (<agentcontrol-parent-id>)
GitHub PR: https://github.com/rewasa/jarvis-mission-control/pull/11
```

5. Link Kanban parent -> child.
6. Add at least one Kanban comment and check that logs/comments appear through AgentControl.
7. Call `POST /api/tasks/:parentId/kanban/sync`.
8. Verify:
   - `GET /api/tasks/:parentId/subtasks` contains imported child.
   - `GET /api/tasks/:subtaskId/kanban` returns real Kanban status/profile.
   - `GET /api/tasks/:subtaskId/kanban/logs` returns real events/comments.
   - `POST /api/tasks/:subtaskId/github/refresh` returns PR/check status.
9. Browser smoke the parent task page and capture console-free render evidence.
10. Run final build.

**Acceptance criteria:**

- The proof document contains actual AgentControl task id, subtask id, Kanban ids, PR URL, endpoint outputs summarized in human-readable form, and build command output.
- No isolated smoke data is written into the production `~/.agentcontrol` DB.

---

## Webhook / Plugin Follow-up Details

If the polling sync is accepted, add a small optional Hermes plugin later:

- Path: `~/.hermes/plugins/agentcontrol_bridge/`
- Hook: `post_tool_call`
- Trigger on tool names starting with `kanban_` or shell commands containing `hermes kanban` if available in tool metadata.
- Action: POST to `http://127.0.0.1:7460/api/integrations/hermes/kanban-sync` with a short timeout.
- It must be best-effort and never block a Hermes worker.
- Symlink plugin into profiles that should trigger sync (`backend-dev`, `kimi-ui`, `qa-dev`, `reviewer`, `worker`, `orchestrator`) only after default profile smoke passes.

This plugin is a notifier, not the source of truth. AgentControl still reads the Kanban DB to reconcile.

## PR / Branch Strategy

Use one canonical implementation PR if possible:

- Branch: `feat/agentcontrol-kanban-sync-github-status`
- Repo: `rewasa/jarvis-mission-control`
- PR body must include:
  - what changed,
  - how tested,
  - smoke task/subtask ids,
  - note that Hermes plugin is optional/not source of truth.

If workers create split branches, consolidate before final review into this canonical branch/PR.
