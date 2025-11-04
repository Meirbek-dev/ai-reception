# Live Reviewer UI & HITL MVP

## Goals

- Surface low-confidence classifications to human reviewers for quick validation.
- Provide light session-based auth with reviewer/admin roles.
- Track reviewer activity (assignments, actions, timing) for KPIs: time-to-review, resolution rate, misclassification reduction.
- Preserve existing upload flow while extending metadata persistence beyond filenames.

## Current State Snapshot

- Upload workflow writes classified files to `uploads/` and returns metadata in-memory.
- No persistence layer for classification confidence, review status, user data, or audit trails.
- Frontend (React + Vite) only exposes the applicant upload UI.

## High-Level Architecture Changes

- Introduce SQLite (file-based) via SQLAlchemy to persist documents, reviewer actions, and users. Allow future swap to Postgres.
- Store raw file path + derived metadata + classification confidence for every upload (classified or not).
- Add review queue domain: each document has a `review_status` (`pending`, `claimed`, `resolved`) and optional `assigned_reviewer_id`.
- Extend FastAPI app with authenticated routes under `/admin` namespace and shared session middleware.
- Serve built admin SPA from `/admin` (vite multi-entry) or mount via TanStack Router route guard.

## Data Model (initial)

```text
User
  id (uuid)
  email (unique)
  display_name
  role (enum: reviewer, admin)
  password_hash
  created_at
  last_login_at

Document
  id (uuid)
  original_name
  stored_filename
  applicant_name
  applicant_lastname
  category_predicted
  category_confidence (float)
  category_final
  status (enum: uploaded, queued, in_review, resolved)
  assigned_reviewer_id (fk User?)
  uploaded_at
  updated_at

DocumentText
  document_id (fk)
  text_excerpt (optional, for preview)

ReviewAction
  id
  document_id
  reviewer_id
  action (enum: claim, release, accept, override, reject)
  from_category
  to_category
  comment
  duration_seconds
  created_at

AuditLog (optional initial merge with ReviewAction to simplify)
  id
  actor_id (nullable)
  scope (document|system)
  event
  payload (json)
  created_at
```

## Backend Additions

- **Persistence**: add SQLAlchemy + Alembic. For MVP, single SQLite file `data/ai_reception.db` with `sqlite+aiosqlite`.
- **Session Auth**:
  - Add `/auth/login` to issue signed session cookie (FastAPI `SessionMiddleware` + `itsdangerous` or `authlib`).
  - Store password hashes using `passlib` (bcrypt).
  - Add `/auth/me`, `/auth/logout` endpoints.
  - Add dependency `require_role("reviewer")` and `require_role("admin")`.
- **Document persistence over uploads**:
  - During existing `/upload`, after classification compute confidence score (store from classifier or new heuristics). For current keyword-based classifier we can derive pseudo-confidence: cached fuzzy score or flag `unclassified` -> `0.0`.
  - Persist `Document` row regardless of whether file saved. Link stored file path. Mark low confidence threshold (configurable, default <0.65) as `status='queued'`.
  - Write OCR text snippet (first N chars) for inline preview.
- **Review queue endpoints** (under `/admin`):
  - `GET /admin/review-queue?status=pending&limit=50` -> list docs with metadata + preview snippet.
  - `POST /admin/review-queue/{document_id}/claim` -> mark claimed by reviewer, store start timestamp.
  - `POST /admin/review-queue/{document_id}/release` -> release claim.
  - `POST /admin/review-queue/{document_id}/resolve` -> accept/override metadata; payload includes `final_category`, `notes`, `applicant info edits`. Computes duration from claim to resolve, stores `ReviewAction` row.
  - `POST /admin/review-queue/{document_id}/assign` (admin only) -> assign to reviewer for batch flows.
  - `GET /admin/reviewers` -> list reviewers, stats (docs resolved, avg time).
  - `GET /admin/review-queue/{document_id}/audit` -> audit trail for detail drawer.
- **KPIs & metrics**: nightly cron optional later; for MVP provide aggregated stats via `GET /admin/metrics` (avg duration, resolution %).

## Frontend Additions

- New protected route `/review` in React app (tanstack router). Could be separate entry or same SPA with conditional navigation.
- Implement login screen (username/password) that stores session cookie.
- Review queue page:
  - Left panel list/table of queued docs with filters (status, category, search by name, assigned reviewer).
  - Detail pane showing inline preview (render first page image or text snippet). To support preview, extend backend to provide `/admin/documents/{id}/preview` returning either base64 image or text snippet. For PDF first page image we can reuse pdf2image.
  - Editable metadata: applicant name/lastname, final category dropdown, notes field.
  - Action buttons with keyboard shortcuts: `a` accept, `o` override, `r` reject, `shift+s` save/submit.
  - Timer per document (start when claimed, display time elapsed).
- Batch assignment UI for admins: multi-select docs -> assign to reviewer.
- Use `sonner` or similar for toast notifications.
- Integrate `react-query` or `@tanstack/react-query` (already available via router plugin) for data fetching.

## Auth & Security

- Use HTTP-only secure cookies; CSRF token via double-submit (send header).
- Rate limit auth attempts.
- Seed initial admin user via environment variables or CLI command (`python server.py create-admin --email ...`).

## Review Flow

1. Upload pipeline classifies and stores doc.
2. If `category_confidence < threshold` or classification = `UNCLASSIFIED`, mark `status='queued'`.
3. Reviewer visits queue, claims doc (status -> `in_review`).
4. Reviewer accepts/overrides: updates `category_final`, optionally edits metadata, status -> `resolved`.
5. `ReviewAction` + `Document` updated with resolution info and timing.
6. Metrics aggregated from `ReviewAction` and `Document` statuses.

## Implementation Phases

1. **Foundation** ✅ **COMPLETE**: add database layer, models, migrations, config, CLI for admin user.
2. **Upload persistence** ✅ **COMPLETE**: modify `/upload` to write `Document` rows, compute confidence, queue logic.
3. **Auth** ✅ **COMPLETE**: session middleware, login/logout endpoints, role guards, frontend auth state.
4. **Review API** ✅ **COMPLETE**: queue list/claim/release/resolve endpoints, preview handler, audit logging.
5. **Frontend UI**: new routes, layout, state management, keyboard shortcuts, assignment workflow.
6. **Metrics**: scoreboard endpoint and dashboard widgets.
7. **QA**: end-to-end manual test plan + automated FastAPI + frontend tests.

## Config & Deployment Notes

- New dependencies: `sqlalchemy`, `aiosqlite`, `alembic`, `passlib[bcrypt]`, `python-multipart` already present, `itsdangerous`.
- Add env vars: `DATABASE_URL`, `SESSION_SECRET`, `REVIEW_CONFIDENCE_THRESHOLD`, `REVIEW_AUTO_ASSIGN_LIMIT`.
- Dockerfile: install system deps for sqlite (already included) and run migrations on launch.
- docker-compose: mount persistent volume for database + uploads.

## Open Questions

- reviewers Should be able to upload replacements
- What constitutes low confidence for rule-based classifier? (Need heuristic mapping.)
