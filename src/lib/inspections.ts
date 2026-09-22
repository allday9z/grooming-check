/**
 * Inspection submission + HR approval workflow. Status flow (per
 * requirement doc section 3):
 *   draft -> pending -> approved (terminal)
 *   draft -> pending -> rejected -> (edit + resubmit) -> pending (loop,
 *     unlimited cycles)
 *
 * No login in this MVP (doc section 9.1's explicit decision — free-text
 * name entry only, no SSO/RBAC yet) so "actor" everywhere is just the
 * name someone typed, not a verified account. Every status transition is
 * appended to `history` (doc section 6.3) for audit/traceability, which
 * matters most here because a single inspection can bounce through many
 * reject/resubmit cycles before approval.
 */
import { sql } from "./db"
import { CHECKLIST_ITEMS, CHECKLIST_TOTAL } from "./checklist"

// The postgres driver doesn't always auto-deserialize JSONB columns back
// into JS arrays in this environment (observed directly: a fresh row's
// `items`/`history` columns came back as raw JSON strings, not arrays) —
// same defensive parsing already needed for JSONB columns in the sibling
// uficon-prf project this session. Always route reads through this instead
// of assuming the driver parsed it.
export function parseJsonbArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

export interface ChecklistItemInput {
  itemId: string
  result: "pass" | "fail" | null
  note: string | null
}

export interface InspectionInput {
  inspectorName: string
  position: string
  positionOther: string | null
  branch: string
  inspectDate: string
  items: ChecklistItemInput[]
}

export interface HistoryEntry {
  action: "created" | "saved" | "submitted" | "approved" | "rejected"
  by: string
  at: string
  cycle: number
  comment: string | null
}

function genToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
}

function normalizeItems(items: ChecklistItemInput[]): ChecklistItemInput[] {
  // Always store exactly CHECKLIST_ITEMS.length entries, in canonical
  // order, regardless of what the client sent — the checklist is fixed
  // (see lib/checklist.ts), so this keeps the stored `items` array shape
  // predictable no matter what the client's DOM iteration order was.
  const byId = new Map(items.map((i) => [i.itemId, i]))
  return CHECKLIST_ITEMS.map((def) => {
    const found = byId.get(def.itemId)
    return { itemId: def.itemId, result: found?.result ?? null, note: found?.note?.trim() || null }
  })
}

function scoreOf(items: ChecklistItemInput[]): { score: number; percent: number; overallResult: string } {
  const score = items.filter((i) => i.result === "pass").length
  const percent = Math.round((score / CHECKLIST_TOTAL) * 100)
  // Default MVP rule (doc 7.3): must pass ALL items, no percentage
  // threshold — flagged in the doc itself as a default assumption pending
  // business confirmation, not a final decision. See lib/checklist.ts /
  // this project's README for where to change it if the threshold changes.
  const overallResult = score === CHECKLIST_TOTAL ? "pass" : "fail"
  return { score, percent, overallResult }
}

export async function createDraft(input: InspectionInput, actorName: string): Promise<{ id: number; token: string }> {
  const items = normalizeItems(input.items)
  const token = genToken()
  const history: HistoryEntry[] = [{ action: "created", by: actorName, at: new Date().toISOString(), cycle: 1, comment: null }]

  const rows = await sql`
    INSERT INTO inspections (public_token, inspector_name, position, position_other, branch, inspect_date, items, status, cycle, history)
    VALUES (${token}, ${input.inspectorName}, ${input.position}, ${input.positionOther}, ${input.branch}, ${input.inspectDate}, ${JSON.stringify(items)}, 'draft', 1, ${JSON.stringify(history)})
    RETURNING id
  `
  return { id: rows[0].id as number, token }
}

/** Autosave — updates the draft/rejected record in place without touching
 * status or history (per doc 4.5: autosave must not interrupt typing, and
 * shouldn't spam the audit trail with every keystroke). */
export async function saveDraft(token: string, input: InspectionInput): Promise<void> {
  const [insp] = await sql`SELECT id, status FROM inspections WHERE public_token = ${token} AND deleted_at IS NULL`
  if (!insp) throw new Error("not_found")
  if (insp.status !== "draft" && insp.status !== "rejected") throw new Error("wrong_status")

  const items = normalizeItems(input.items)
  await sql`
    UPDATE inspections SET
      inspector_name = ${input.inspectorName}, position = ${input.position}, position_other = ${input.positionOther},
      branch = ${input.branch}, inspect_date = ${input.inspectDate}, items = ${JSON.stringify(items)}, updated_at = NOW()
    WHERE id = ${insp.id}
  `
}

/** Validates the full submission-gating rule set from doc 7.4 — every
 * check here must ALSO be enforced client-side in real time (per 7.1), but
 * this is the authoritative check; the client-side one is just UX. */
export function validateForSubmit(input: InspectionInput): string | null {
  if (!input.inspectorName?.trim()) return "missing_inspector_name"
  if (!input.position?.trim()) return "missing_position"
  if (input.position === "อื่นๆ" && !input.positionOther?.trim()) return "missing_position_other"
  if (!input.branch?.trim()) return "missing_branch"
  if (!input.inspectDate?.trim()) return "missing_date"

  const items = normalizeItems(input.items)
  for (const item of items) {
    if (item.result !== "pass" && item.result !== "fail") return `item_not_checked:${item.itemId}`
    if (item.result === "fail" && !item.note) return `item_missing_note:${item.itemId}`
  }
  return null
}

export async function submitForReview(token: string, input: InspectionInput, actorName: string): Promise<void> {
  const [insp] = await sql`SELECT id, status, cycle, history FROM inspections WHERE public_token = ${token} AND deleted_at IS NULL`
  if (!insp) throw new Error("not_found")
  if (insp.status !== "draft" && insp.status !== "rejected") throw new Error("wrong_status")

  const validationError = validateForSubmit(input)
  if (validationError) throw new Error(validationError)

  const items = normalizeItems(input.items)
  const requiresPhoto = items.filter((i) => i.result === "pass").map((i) => i.itemId)
  if (requiresPhoto.length) {
    const photoRows = await sql`SELECT item_id FROM inspection_photos WHERE inspection_id = ${insp.id} AND item_id IN ${sql(requiresPhoto)}`
    const havePhoto = new Set(photoRows.map((r: any) => r.item_id))
    const missing = requiresPhoto.find((id) => !havePhoto.has(id))
    if (missing) throw new Error(`item_missing_photo:${missing}`)
  }

  const { score, percent, overallResult } = scoreOf(items)
  const history: HistoryEntry[] = parseJsonbArray<HistoryEntry>(insp.history)
  history.push({ action: "submitted", by: actorName, at: new Date().toISOString(), cycle: insp.cycle, comment: null })

  await sql`
    UPDATE inspections SET
      inspector_name = ${input.inspectorName}, position = ${input.position}, position_other = ${input.positionOther},
      branch = ${input.branch}, inspect_date = ${input.inspectDate}, items = ${JSON.stringify(items)},
      status = 'pending', score = ${score}, percent = ${percent}, overall_result = ${overallResult},
      submitted_at = NOW(), history = ${JSON.stringify(history)}, updated_at = NOW()
    WHERE id = ${insp.id}
  `
}

export async function approve(id: number, reviewerName: string): Promise<void> {
  const [insp] = await sql`SELECT id, status, cycle, history FROM inspections WHERE id = ${id} AND deleted_at IS NULL`
  if (!insp) throw new Error("not_found")
  if (insp.status !== "pending") throw new Error("wrong_status")

  const history: HistoryEntry[] = parseJsonbArray<HistoryEntry>(insp.history)
  history.push({ action: "approved", by: reviewerName, at: new Date().toISOString(), cycle: insp.cycle, comment: null })

  await sql`
    UPDATE inspections SET status = 'approved', hr_reviewer = ${reviewerName}, hr_comment = NULL, hr_reviewed_at = NOW(), history = ${JSON.stringify(history)}, updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function reject(id: number, reviewerName: string, comment: string): Promise<void> {
  const [insp] = await sql`SELECT id, status, cycle, history FROM inspections WHERE id = ${id} AND deleted_at IS NULL`
  if (!insp) throw new Error("not_found")
  if (insp.status !== "pending") throw new Error("wrong_status")
  if (!comment?.trim()) throw new Error("comment_required")

  const nextCycle = insp.cycle + 1
  const history: HistoryEntry[] = parseJsonbArray<HistoryEntry>(insp.history)
  history.push({ action: "rejected", by: reviewerName, at: new Date().toISOString(), cycle: insp.cycle, comment: comment.trim() })

  await sql`
    UPDATE inspections SET status = 'rejected', cycle = ${nextCycle}, hr_reviewer = ${reviewerName}, hr_comment = ${comment.trim()}, hr_reviewed_at = NOW(), history = ${JSON.stringify(history)}, updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function getByToken(token: string): Promise<any | null> {
  const rows = await sql`SELECT * FROM inspections WHERE public_token = ${token} AND deleted_at IS NULL`
  return rows[0] ?? null
}

export async function getById(id: number): Promise<any | null> {
  const rows = await sql`SELECT * FROM inspections WHERE id = ${id} AND deleted_at IS NULL`
  return rows[0] ?? null
}

export async function listAll(statusFilter?: string): Promise<any[]> {
  return statusFilter && statusFilter !== "all"
    ? sql`SELECT * FROM inspections WHERE status = ${statusFilter} AND deleted_at IS NULL ORDER BY created_at DESC`
    : sql`SELECT * FROM inspections WHERE deleted_at IS NULL ORDER BY created_at DESC`
}

export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await sql`SELECT status, count(*)::int AS n FROM inspections WHERE deleted_at IS NULL GROUP BY status`
  const out: Record<string, number> = { draft: 0, pending: 0, approved: 0, rejected: 0 }
  for (const r of rows as any[]) out[r.status] = r.n
  return out
}

/** Admin-only "clear out test data" — soft delete, matching the pattern
 * used throughout this session's other projects (never a hard DELETE by a
 * regular user — see doc 8.3's explicit "ห้ามลบข้อมูลถาวรโดยผู้ใช้ทั่วไป"). */
export async function softDelete(id: number): Promise<void> {
  await sql`UPDATE inspections SET deleted_at = NOW() WHERE id = ${id}`
}
