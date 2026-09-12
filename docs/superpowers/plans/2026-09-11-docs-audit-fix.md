# Documentation Audit Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all discrepancies between documentation (.md files) and actual source code structure/tech stack.

**Architecture:** Surgical edits to existing .md files to align with the actual flat `backend/` + `frontend/` structure, JavaScript (not TypeScript) tech stack, and sql.js (not Prisma) database layer.

**Tech Stack:** Documentation only — no code changes.

**Spec:** Analysis of all 22 .md files vs actual source code (package.json, directory structure, schema.js).

## Global Constraints

- Do not change source code — only documentation files
- Preserve all existing design intent and architecture decisions
- Keep Vietnamese language for user-facing docs
- Follow existing doc style and formatting conventions

---

## Discrepancy Summary

| # | File | Issue | Fix |
|---|------|-------|-----|
| 1 | `frontend/README.md` | References `../AI-Shorts-Factory-Documentation-Starter/docs/` | Change to `../Video_AI_docs/docs/` |
| 2 | `frontend/AGENTS.md` | References `../AI-Shorts-Factory-Documentation-Starter/docs/` | Change to `../Video_AI_docs/docs/` |
| 3 | `Video_AI_docs/README.md` | Says "React 19" | Change to "React 18" |
| 4 | `Video_AI_docs/README.md` | Says "TypeScript" in target stack | Change to "JavaScript (JSX)" |
| 5 | `Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md` | References monorepo `apps/` + `packages/` | Add note about actual flat structure |
| 6 | `Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md` | Says "Node.js 22+" | Change to "Node.js 18+" |
| 7 | `Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md` | Says "TypeScript (strict)" | Add note about JavaScript implementation |
| 8 | `Video_AI_docs/docs/03_THIET_KE_BACKEND.md` | References `apps/api/` structure | Add note about actual `backend/` structure |
| 9 | `Video_AI_docs/docs/03_THIET_KE_BACKEND.md` | Says "TypeScript (strict)" | Add note about JavaScript implementation |
| 10 | `Video_AI_docs/docs/04_THIET_KE_FRONTEND.md` | Says "React 19 + Vite + TypeScript" | Change to "React 18 + Vite + JavaScript" |
| 11 | `Video_AI_docs/docs/04_THIET_KE_FRONTEND.md` | References `apps/web/` structure | Add note about actual `frontend/` structure |
| 12 | `Video_AI_docs/docs/02_THIET_KE_CO_SO_DU_LIEU.md` | References Prisma ORM | Add note about sql.js implementation |
| 13 | `Video_AI_docs/AGENTS.md` | References workflow reading docs from `docs/` folder | Clarify path is `Video_AI_docs/docs/` |
| 14 | `Video_AI_docs/CLAUDE.md` | References "TypeScript strict mode" | Add note about JavaScript implementation |

---

### Task 1: Fix Frontend README.md Reference Path

**Files:**
- Modify: `frontend/README.md:72,86`

- [ ] **Step 1: Update documentation reference path**

In `frontend/README.md`, line 72, change:

```
> `../AI-Shorts-Factory-Documentation-Starter/docs/04_THIET_KE_FRONTEND.md`
```

To:

```
> `../Video_AI_docs/docs/04_THIET_KE_FRONTEND.md`
```

- [ ] **Step 2: Update docs directory reference**

In `frontend/README.md`, line 86, change:

```
Toàn bộ đặc tả nằm ở thư mục `../AI-Shorts-Factory-Documentation-Starter/docs/`
```

To:

```
Toàn bộ đặc tả nằm ở thư mục `../Video_AI_docs/docs/`
```

- [ ] **Step 3: Commit**

```bash
git add frontend/README.md
git commit -m "docs(frontend): fix documentation reference path to Video_AI_docs"
```

---

### Task 2: Fix Frontend AGENTS.md Reference Path

**Files:**
- Modify: `frontend/AGENTS.md:12,20`

- [ ] **Step 1: Update documentation reference in warning**

In `frontend/AGENTS.md`, line 12, change:

```
> `../AI-Shorts-Factory-Documentation-Starter/docs/` và xoá dần code cũ.
```

To:

```
> `../Video_AI_docs/docs/` và xoá dần code cũ.
```

- [ ] **Step 2: Update CreateProject reference**

In `frontend/AGENTS.md`, line 20, change:

```
— đặc tả tại `../AI-Shorts-Factory-Documentation-Starter/docs/04_THIET_KE_FRONTEND.md` mục 4.
```

To:

```
— đặc tả tại `../Video_AI_docs/docs/04_THIET_KE_FRONTEND.md` mục 4.
```

- [ ] **Step 3: Commit**

```bash
git add frontend/AGENTS.md
git commit -m "docs(frontend): fix documentation reference path in AGENTS.md"
```

---

### Task 3: Fix Video_AI_docs/README.md Tech Stack

**Files:**
- Modify: `Video_AI_docs/README.md:45-46`

- [ ] **Step 1: Update React version**

In `Video_AI_docs/README.md`, line 45, change:

```
- **Frontend:** React 19, Vite, TypeScript, TailwindCSS, shadcn/ui, TanStack Query, React Router, React Hook Form, Framer Motion.
```

To:

```
- **Frontend:** React 18, Vite, JavaScript (JSX), TailwindCSS, shadcn/ui, TanStack Query, React Router, React Hook Form, Framer Motion.
```

- [ ] **Step 2: Update Backend language**

In `Video_AI_docs/README.md`, line 44, change:

```
- **Backend:** Node.js 22+, TypeScript (strict), Express, Prisma (SQLite MVP → PostgreSQL), BullMQ + Redis, Zod, JWT, Swagger/OpenAPI, Pino.
```

To:

```
- **Backend:** Node.js 18+, JavaScript (ES modules), Express, sql.js (SQLite MVP → PostgreSQL), BullMQ + Redis, Zod, JWT, Swagger/OpenAPI, Pino.
```

- [ ] **Step 3: Commit**

```bash
git add Video_AI_docs/README.md
git commit -m "docs(README): update tech stack to match actual implementation"
```

---

### Task 4: Add Implementation Notes to Architecture Doc

**Files:**
- Modify: `Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md:1-32`

- [ ] **Step 1: Add implementation note at top**

In `Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md`, after the title (line 1), add:

```markdown

> **Lưu ý Triển khai:** Tài liệu này mô tả thiết kế target (monorepo với `apps/` + `packages/`).
> Triển khai hiện tại dùng cấu trúc phẳng `backend/` + `frontend/` với JavaScript (không TypeScript).
> Xem `docs/superpowers/plans/` cho chi tiết gap giữa thiết kế và triển khai.
```

- [ ] **Step 2: Commit**

```bash
git add Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md
git commit -m "docs(architecture): add implementation note about flat structure"
```

---

### Task 5: Add Implementation Notes to Backend Design Doc

**Files:**
- Modify: `Video_AI_docs/docs/03_THIET_KE_BACKEND.md:1-4`

- [ ] **Step 1: Add implementation note at top**

In `Video_AI_docs/docs/03_THIET_KE_BACKEND.md`, after the title (line 1), add:

```markdown

> **Lưu ý Triển khai:** Thiết kế target dùng TypeScript strict + `apps/api/`.
> Triển khai hiện tại dùng JavaScript (ES modules) + `backend/` với sql.js thay vì Prisma.
```

- [ ] **Step 2: Commit**

```bash
git add Video_AI_docs/docs/03_THIET_KE_BACKEND.md
git commit -m "docs(backend): add implementation note about JavaScript + sql.js"
```

---

### Task 6: Add Implementation Notes to Frontend Design Doc

**Files:**
- Modify: `Video_AI_docs/docs/04_THIET_KE_FRONTEND.md:1-4`

- [ ] **Step 1: Add implementation note at top**

In `Video_AI_docs/docs/04_THIET_KE_FRONTEND.md`, after the title (line 1), add:

```markdown

> **Lưu ý Triển khai:** Thiết kế target dùng React 19 + TypeScript + `apps/web/`.
> Triển khai hiện tại dùng React 18 + JavaScript (JSX) + `frontend/`.
```

- [ ] **Step 2: Commit**

```bash
git add Video_AI_docs/docs/04_THIET_KE_FRONTEND.md
git commit -m "docs(frontend): add implementation note about React 18 + JavaScript"
```

---

### Task 7: Add Implementation Notes to Database Design Doc

**Files:**
- Modify: `Video_AI_docs/docs/02_THIET_KE_CO_SO_DU_LIEU.md:1-4`

- [ ] **Step 1: Add implementation note at top**

In `Video_AI_docs/docs/02_THIET_KE_CO_SO_DU_LIEU.md`, after the title (line 1), add:

```markdown

> **Lưu ý Triển khai:** Thiết kế target dùng Prisma ORM.
> Triển khai hiện tại dùng sql.js với raw SQL trực tiếp (`backend/src/db/schema.js`).
> Schema SQL mirror 1-1 các model Prisma, nhưng enum giá trị lowercase (không có native enum trong SQLite).
```

- [ ] **Step 2: Commit**

```bash
git add Video_AI_docs/docs/02_THIET_KE_CO_SO_DU_LIEU.md
git commit -m "docs(database): add implementation note about sql.js vs Prisma"
```

---

### Task 8: Fix Video_AI_docs/AGENTS.md Workflow Path

**Files:**
- Modify: `Video_AI_docs/AGENTS.md:9-12`

- [ ] **Step 1: Clarify doc paths**

In `Video_AI_docs/AGENTS.md`, the workflow references `docs/00_TAM_NHIN_VA_YEU_CAU.md` etc. These paths are correct relative to `Video_AI_docs/` folder. No change needed — the paths are already correct when running from within `Video_AI_docs/`.

- [ ] **Step 2: Commit (no-op, verified correct)**

No commit needed — paths are already correct.

---

### Task 9: Fix Video_AI_docs/CLAUDE.md

**Files:**
- Modify: `Video_AI_docs/CLAUDE.md:1-3`

- [ ] **Step 1: Update to reference AGENTS.md**

In `Video_AI_docs/CLAUDE.md`, replace content with:

```markdown
# Claude Instructions

Follow the instructions in `AGENTS.md`.

**Implementation notes:**
- Follow SOLID, Clean Architecture, Provider Pattern, and incremental delivery.
- Current implementation uses JavaScript (not TypeScript) with sql.js (not Prisma).
```

- [ ] **Step 2: Commit**

```bash
git add Video_AI_docs/CLAUDE.md
git commit -m "docs(CLAUDE): add implementation notes about JS + sql.js"
```

---

### Task 10: Verification

- [ ] **Step 1: Verify all references are correct**

Run: `grep -r "AI-Shorts-Factory-Documentation-Starter" --include="*.md"`
Expected: No results (all references should be fixed)

- [ ] **Step 2: Verify React version references**

Run: `grep -r "React 19" --include="*.md"`
Expected: No results (all should say React 18)

- [ ] **Step 3: Verify TypeScript references in implementation docs**

Run: `grep -r "TypeScript" Video_AI_docs/docs/ --include="*.md" -l`
Expected: Files should have implementation notes about JavaScript

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "docs: complete documentation audit — align docs with actual implementation"
```
