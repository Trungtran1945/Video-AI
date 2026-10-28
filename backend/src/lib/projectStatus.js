// Canonical project lifecycle statuses.
//
// Runtime state machine (single source of truth):
//   pending → queued → running → completed | failed | cancelled
//
// - `success` is a JOB/OUTPUT status (generation_jobs.status, outputs.status),
//   never a project status. Legacy rows with projects.status='success' are
//   normalized to 'completed' at schema init (see schema.js migration).
// - `generating` is a frontend-only display alias, never persisted.
// - Retention sweep (cleanupWorker) only touches terminal retainable states:
//   COMPLETED + FAILED. CANCELLED is cleaned immediately in
//   cancelProjectUseCase, never by the retention sweep (policy decision 1.A).

export const PROJECT_STATUS = Object.freeze({
  PENDING: 'pending',
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

export const PROJECT_TERMINAL_STATUSES = Object.freeze([
  PROJECT_STATUS.COMPLETED,
  PROJECT_STATUS.FAILED,
  PROJECT_STATUS.CANCELLED,
])

// States eligible for time-based retention cleanup (expires_at sweep).
// CANCELLED excluded by policy: cancel path cleans immediately.
export const PROJECT_RETAINABLE_STATUSES = Object.freeze([
  PROJECT_STATUS.COMPLETED,
  PROJECT_STATUS.FAILED,
])

export const PROJECT_ACTIVE_STATUSES = Object.freeze([
  PROJECT_STATUS.PENDING,
  PROJECT_STATUS.QUEUED,
  PROJECT_STATUS.RUNNING,
])

// Job/output vocabulary (generation_jobs.status, outputs.status).
// Runner publishes 'completed' for project-done; job-done rows historically use
// 'success'. Consumers must use normalizeJobStatus(), never literal compare.
export const JOB_STATUS = Object.freeze({
  SUCCESS: 'success',
  FAILED: 'failed',
  ERROR: 'error',
  TIMEOUT: 'timeout',
  RETRY: 'retry',
  RUNNING: 'running',
})

// Transition alias: runner-emitted 'completed' on a job row means SUCCESS.
export function normalizeJobStatus(s) {
  if (s === 'completed') return JOB_STATUS.SUCCESS
  return s
}

export function isCompletedProjectStatus(s) {
  return normalizeProjectStatus(s) === PROJECT_STATUS.COMPLETED
}

export function isActiveProjectStatus(s) {
  return PROJECT_ACTIVE_STATUSES.includes(normalizeProjectStatus(s))
}

export function isTerminalProjectStatus(status) {
  return PROJECT_TERMINAL_STATUSES.includes(String(status))
}

export function isRetainableProjectStatus(status) {
  return PROJECT_RETAINABLE_STATUSES.includes(String(status))
}

// Normalize legacy/alien values read from old DBs or callers.
// 'success' (old job-status leak) → 'completed'.
// 'generating' (frontend-only display alias) → 'running' on read-path, never persisted.
export function normalizeProjectStatus(status) {
  if (status === 'success') return PROJECT_STATUS.COMPLETED
  if (status === 'generating') return PROJECT_STATUS.RUNNING
  return status
}

export default {
  PROJECT_STATUS,
  PROJECT_TERMINAL_STATUSES,
  PROJECT_RETAINABLE_STATUSES,
  PROJECT_ACTIVE_STATUSES,
  JOB_STATUS,
  isTerminalProjectStatus,
  isRetainableProjectStatus,
  normalizeProjectStatus,
  normalizeJobStatus,
  isCompletedProjectStatus,
  isActiveProjectStatus,
}
