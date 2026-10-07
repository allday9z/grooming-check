/**
 * Inspection submission + HR review workflow.
 *
 * Status flow:
 *   draft -> pending -> approved (terminal)
 *   draft -> pending -> rejected -> (fix flagged items) -> pending (loop)
 *
 * v2 (2026-10-04, htask-1791116230138) — per-item review:
 *  - HR ticks "Request revision" on individual items (each with its own
 *    comment) and presses "Confirm Entire Audit ID": every item NOT ticked
 *    is confirmed (closed for good); if nothing is ticked the audit is
 *    approved. Ticked items go back to the inspector.
 *  - The inspector can then change ONLY the flagged items, and must submit
 *    a corrective-action note + an "after" photo for each (Before/After).
 *  - All of that is enforced here, server-side — the page only mirrors it.
 *  - Overall result: pass only when every item passes (PASS_THRESHOLD_PERCENT = 100).
 *
 * No login in this app — "actor" everywhere is the name someone typed.
 * Every status transition is appended to `history` for audit.
 */
import { sql } from "./db"
import { CHECKLIST_ITEMS, CHECKLIST_TOTAL, GROUP_PHOTO_SLOTS } from "./checklist"
import { listPhotoKinds } from "./photos"

/** Grading rule: was ">= 80% = ผ่าน" (htask-1791116230138); now every item
 * must pass — 100% only, anything lower is ไม่ผ่าน (Preeyapan, htask-1791386476660). */
export const PASS_THRESHOLD_PERCENT = 100
export const PASS_RULE_LABEL = "ต้องผ่านทุกข้อ (100%)"

// The postgres driver doesn't always auto-deserialize JSONB columns in this
// environment — always route reads through this.
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

export interface RevisionRequest {
  comment: string
  by: string
  at: string
  cycle: number
}

export interface CorrectiveAction {
  note: string
  at: string | null
}

export interface ChecklistItemInput {
  itemId: string
  result: "pass" | "fail" | null
  note: string | null
  /** How the failed condition will be / was fixed (htask-1791121739323 #15.1). */
  fix?: string | null
  /** Set by HR: this item must be fixed by the inspector. */
  revision?: RevisionRequest | null
  /** Set by HR: item accepted and closed — never editable again. */
  confirmed?: boolean
  /** Inspector's reply to a revision request ("Corrective action submitted"). */
  corrective?: CorrectiveAction | null
}

export interface InspectionInput {
  inspectorName: string
  inspectorEmail: string | null
  position: string
  positionOther: string | null
  branch: string
  inspectDate: string
  items: ChecklistItemInput[]
  /** Optional corrective plan (htask-1791121739323 #15.2). */
  planProblem?: string | null
  planSolution?: string | null
  planDueDate?: string | null
}

export interface HistoryEntry {
  action: "created" | "saved" | "submitted" | "approved" | "rejected" | "revision_requested" | "deleted"
  by: string
  at: string
  cycle: number
  comment: string | null
  items?: string[]
}

function genToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
}

/** Always exactly CHECKLIST_ITEMS.length entries, in canonical order. Only
 * the inspector-owned fields come from `items`; HR-owned fields
 * (revision/confirmed) are carried over from `existing` so a client can
 * never forge or clear them. */
function normalizeItems(items: ChecklistItemInput[], existing: ChecklistItemInput[] = []): ChecklistItemInput[] {
  const byId = new Map(items.map((i) => [i.itemId, i]))
  const oldById = new Map(existing.map((i) => [i.itemId, i]))
  return CHECKLIST_ITEMS.map((def) => {
    const found = byId.get(def.itemId)
    const old = oldById.get(def.itemId)
    const correctiveNote = found?.corrective?.note?.trim() || null
    return {
      itemId: def.itemId,
      result: found?.result === "pass" || found?.result === "fail" ? found.result : null,
      note: found?.note?.trim() || null,
      fix: found?.fix?.trim() || null,
      revision: old?.revision ?? null,
      confirmed: !!old?.confirmed,
      corrective: correctiveNote ? { note: correctiveNote, at: old?.corrective?.at ?? null } : null,
    }
  })
}

/** Items HR sent back that the inspector still has to fix. */
export function openRevisionIds(items: ChecklistItemInput[]): string[] {
  return items.filter((i) => i.revision && !i.confirmed).map((i) => i.itemId)
}

/** For a rejected audit with per-item revision requests, the inspector may
 * change ONLY those items — everything else (header + other items) is
 * taken from the stored record, whatever the client sent. */
function mergeForRevision(stored: any, input: InspectionInput): InspectionInput {
  const storedItems = parseJsonbArray<ChecklistItemInput>(stored.items)
  const open = new Set(openRevisionIds(storedItems))
  const incoming = new Map(input.items.map((i) => [i.itemId, i]))
  return {
    inspectorName: stored.inspector_name,
    inspectorEmail: stored.inspector_email ?? null,
    position: stored.position,
    positionOther: stored.position_other,
    branch: stored.branch,
    inspectDate: dateOnly(stored.inspect_date),
    // The corrective plan stays editable during a revision round — it's the
    // inspector's follow-up plan, not one of HR's confirmed checklist items.
    planProblem: input.planProblem ?? null,
    planSolution: input.planSolution ?? null,
    planDueDate: input.planDueDate ?? null,
    items: storedItems.map((it) => (open.has(it.itemId) && incoming.has(it.itemId) ? { ...it, ...pickInspectorFields(incoming.get(it.itemId)!) } : it)),
  }
}

function pickInspectorFields(i: ChecklistItemInput): Partial<ChecklistItemInput> {
  return { result: i.result, note: i.note, fix: i.fix ?? null, corrective: i.corrective ?? null }
}

export function dateOnly(d: any): string {
  if (!d) return ""
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  return String(d).slice(0, 10)
}

export function scoreOf(items: ChecklistItemInput[]): { score: number; percent: number; overallResult: string } {
  const score = items.filter((i) => i.result === "pass").length
  const percent = Math.round((score / CHECKLIST_TOTAL) * 100)
  // Compare the exact ratio, not the rounded percent (13/14 must never round up to a pass).
  const overallResult = (score / CHECKLIST_TOTAL) * 100 >= PASS_THRESHOLD_PERCENT ? "pass" : "fail"
  return { score, percent, overallResult }
}

/** A brand-new draft is only created once there's something worth saving
 * (htask-1791116230138 #9 — opening "new" no longer leaves empty drafts). */
export function isEmptyInput(input: InspectionInput): boolean {
  return !input.inspectorName?.trim() && !input.branch?.trim() && !input.position?.trim() && !input.items.some((i) => i.result || i.note)
}

export async function createDraft(input: InspectionInput, actorName: string): Promise<{ id: number; token: string }> {
  const items = normalizeItems(input.items)
  const token = genToken()
  const history: HistoryEntry[] = [{ action: "created", by: actorName, at: new Date().toISOString(), cycle: 1, comment: null }]
  const rows = await sql`
    INSERT INTO inspections (public_token, inspector_name, inspector_email, position, position_other, branch, inspect_date, items, status, cycle, history, plan_problem, plan_solution, plan_due_date)
    VALUES (${token}, ${input.inspectorName}, ${input.inspectorEmail}, ${input.position}, ${input.positionOther}, ${input.branch}, ${input.inspectDate || new Date().toISOString().slice(0, 10)}, ${JSON.stringify(items)}, 'draft', 1, ${JSON.stringify(history)},
      ${input.planProblem || null}, ${input.planSolution || null}, ${input.planDueDate || null})
    RETURNING id
  `
  return { id: rows[0].id as number, token }
}

/** Autosave — updates the draft/rejected record in place without touching
 * status or history. */
export async function saveDraft(token: string, input: InspectionInput): Promise<void> {
  const [insp] = await sql`SELECT * FROM inspections WHERE public_token = ${token} AND deleted_at IS NULL`
  if (!insp) throw new Error("not_found")
  if (insp.status !== "draft" && insp.status !== "rejected") throw new Error("wrong_status")

  const storedItems = parseJsonbArray<ChecklistItemInput>(insp.items)
  const effective = insp.status === "rejected" && openRevisionIds(storedItems).length ? mergeForRevision(insp, input) : input
  const items = normalizeItems(effective.items, storedItems)
  await sql`
    UPDATE inspections SET
      inspector_name = ${effective.inspectorName}, inspector_email = ${effective.inspectorEmail}, position = ${effective.position},
      position_other = ${effective.positionOther}, branch = ${effective.branch}, inspect_date = ${effective.inspectDate || dateOnly(insp.inspect_date)},
      items = ${JSON.stringify(items)}, plan_problem = ${effective.planProblem || null}, plan_solution = ${effective.planSolution || null},
      plan_due_date = ${effective.planDueDate && !isNaN(Date.parse(effective.planDueDate)) ? effective.planDueDate : null}, updated_at = NOW()
    WHERE id = ${insp.id}
  `
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Authoritative submission rules (htask-1791116230138 #8) — the page
 * checks the same things live, but this is what actually gates a submit:
 *  - complete header (name, email, position (+other), branch, date)
 *  - every item checked; fail => note; pass => photo (before or after)
 *  - every open revision item => corrective-action note + "after" photo */
export function validateForSubmit(input: InspectionInput, photos: { before: Set<string>; after: Set<string> }, openRevisions: string[] = []): string | null {
  if (!input.inspectorName?.trim()) return "missing_inspector_name"
  if (!input.position?.trim()) return "missing_position"
  if (input.position === "อื่นๆ" && !input.positionOther?.trim()) return "missing_position_other"
  if (!input.branch?.trim()) return "missing_branch"
  if (!input.inspectDate?.trim() || isNaN(Date.parse(input.inspectDate))) return "missing_date"
  // Inspector email is required (Preeyapan, htask-1791386476660). Not re-checked
  // on a revision resubmit: the header is locked then, so an audit first sent
  // without an email must still be able to send its fixes back.
  if (!openRevisions.length && !input.inspectorEmail?.trim()) return "missing_email"
  if (input.inspectorEmail && !EMAIL_RE.test(input.inspectorEmail)) return "invalid_email"
  if (input.planDueDate && isNaN(Date.parse(input.planDueDate))) return "invalid_plan_due_date"
  // "ง. แนบรูปรวมที่ตรวจวันนี้" — at least one group photo (Preeyapan,
  // htask-1791357251217). Not re-checked on a revision resubmit: group photos
  // are locked while items are out for revision, so an audit first sent
  // before this rule existed must still be able to send its fixes back.
  if (!openRevisions.length && !GROUP_PHOTO_SLOTS.some((s) => photos.before.has(s))) return "missing_group_photo"

  const open = new Set(openRevisions)
  for (const item of input.items) {
    if (item.result !== "pass" && item.result !== "fail") return `item_not_checked:${item.itemId}`
    // Fail = note + its own photo of the failing condition (kept as the
    // "Before" photo) + fix method — all three (htask-1791121739323 #15.1).
    if (item.result === "fail" && !item.note?.trim()) return `item_missing_note:${item.itemId}`
    if (item.result === "fail" && !photos.before.has(item.itemId) && !photos.after.has(item.itemId)) return `item_missing_fail_photo:${item.itemId}`
    if (item.result === "fail" && !item.fix?.trim()) return `item_missing_fix:${item.itemId}`
    // Passed items no longer need a photo — only failed ones do (README
    // from Preeyapan, htask-1791123159751: "ข้อที่ผ่านไม่ต้องแนบรูป").
    if (open.has(item.itemId)) {
      if (!item.corrective?.note?.trim()) return `item_missing_corrective_note:${item.itemId}`
      if (!photos.after.has(item.itemId)) return `item_missing_after_photo:${item.itemId}`
    }
  }
  return null
}

/** Human-readable Thai for the validation codes above. */
export function validationMessage(code: string): string {
  const [key, itemId] = code.split(":")
  const label = itemId ? CHECKLIST_ITEMS.find((i) => i.itemId === itemId)?.label ?? itemId : ""
  const map: Record<string, string> = {
    missing_inspector_name: "กรุณากรอกชื่อผู้ตรวจ",
    missing_position: "กรุณาเลือกตำแหน่ง",
    missing_position_other: "กรุณาระบุตำแหน่ง",
    missing_branch: "กรุณาเลือกสาขา",
    missing_date: "กรุณาระบุวันที่ตรวจ",
    missing_email: "กรุณากรอกอีเมลผู้ตรวจ",
    invalid_email: "รูปแบบอีเมลไม่ถูกต้อง",
    item_not_checked: `ยังไม่ได้ตรวจข้อ "${label}"`,
    item_missing_note: `ข้อ "${label}" ไม่ผ่าน ต้องระบุหมายเหตุ`,
    item_missing_fail_photo: `ข้อ "${label}" ไม่ผ่าน ต้องแนบรูปสภาพที่ไม่ผ่าน`,
    item_missing_fix: `ข้อ "${label}" ไม่ผ่าน ต้องระบุวิธีแก้ไข`,
    invalid_plan_due_date: "กำหนดเสร็จของแผนการแก้ไขไม่ถูกต้อง",
    missing_group_photo: "กรุณาแนบรูปรวมที่ตรวจวันนี้ (ข้อ ง.) อย่างน้อย 1 รูป",
    item_missing_photo: `ข้อ "${label}" ผ่าน ต้องแนบรูป`,
    item_missing_corrective_note: `ข้อ "${label}" ต้องระบุการแก้ไข (Corrective action)`,
    item_missing_after_photo: `ข้อ "${label}" ต้องแนบรูปหลังแก้ไข (After)`,
    wrong_status: "รายการนี้ส่งแล้ว แก้ไขไม่ได้",
    not_found: "ไม่พบรายการตรวจ",
  }
  return map[key!] || code
}

export async function submitForReview(token: string, rawInput: InspectionInput, actorName: string): Promise<{ id: number }> {
  const [insp] = await sql`SELECT * FROM inspections WHERE public_token = ${token} AND deleted_at IS NULL`
  if (!insp) throw new Error("not_found")
  if (insp.status !== "draft" && insp.status !== "rejected") throw new Error("wrong_status")

  const storedItems = parseJsonbArray<ChecklistItemInput>(insp.items)
  const open = insp.status === "rejected" ? openRevisionIds(storedItems) : []
  const input = open.length ? mergeForRevision(insp, rawInput) : rawInput
  const items = normalizeItems(input.items, storedItems)
  const photos = await listPhotoKinds(insp.id)

  const validationError = validateForSubmit({ ...input, items }, photos, open)
  if (validationError) throw new Error(validationError)

  const now = new Date().toISOString()
  for (const it of items) if (open.includes(it.itemId) && it.corrective) it.corrective.at = now

  const { score, percent, overallResult } = scoreOf(items)
  const history: HistoryEntry[] = parseJsonbArray<HistoryEntry>(insp.history)
  history.push({ action: "submitted", by: actorName, at: now, cycle: insp.cycle, comment: open.length ? "Corrective action submitted" : null, items: open.length ? open : undefined })

  await sql`
    UPDATE inspections SET
      inspector_name = ${input.inspectorName}, inspector_email = ${input.inspectorEmail}, position = ${input.position}, position_other = ${input.positionOther},
      branch = ${input.branch}, inspect_date = ${input.inspectDate}, items = ${JSON.stringify(items)},
      plan_problem = ${input.planProblem || null}, plan_solution = ${input.planSolution || null}, plan_due_date = ${input.planDueDate || null},
      status = 'pending', score = ${score}, percent = ${percent}, overall_result = ${overallResult},
      submitted_at = NOW(), history = ${JSON.stringify(history)}, updated_at = NOW()
    WHERE id = ${insp.id}
  `
  return { id: insp.id }
}

/** HR's single review action — "Confirm Entire Audit ID". Every item not
 * listed in `revisions` is confirmed (closed); listed items go back to the
 * inspector with their own comment. No revisions => approved. */
export async function reviewAudit(id: number, reviewerName: string, revisions: { itemId: string; comment: string }[], overallComment: string | null): Promise<{ status: "approved" | "rejected"; revisionIds: string[] }> {
  const [insp] = await sql`SELECT * FROM inspections WHERE id = ${id} AND deleted_at IS NULL`
  if (!insp) throw new Error("not_found")
  if (insp.status !== "pending") throw new Error("wrong_status")

  const items = normalizeItems(parseJsonbArray<ChecklistItemInput>(insp.items), parseJsonbArray<ChecklistItemInput>(insp.items))
  const valid = new Set(items.filter((i) => !i.confirmed).map((i) => i.itemId))
  const revMap = new Map<string, string>()
  for (const r of revisions) {
    if (!valid.has(r.itemId)) continue
    if (!r.comment?.trim()) throw new Error(`revision_comment_required:${r.itemId}`)
    revMap.set(r.itemId, r.comment.trim())
  }

  const now = new Date().toISOString()
  for (const it of items) {
    if (revMap.has(it.itemId)) {
      it.revision = { comment: revMap.get(it.itemId)!, by: reviewerName, at: now, cycle: insp.cycle }
      it.confirmed = false
      it.corrective = null
    } else {
      it.confirmed = true
    }
  }

  const history: HistoryEntry[] = parseJsonbArray<HistoryEntry>(insp.history)
  const revisionIds = [...revMap.keys()]
  if (!revisionIds.length) {
    history.push({ action: "approved", by: reviewerName, at: now, cycle: insp.cycle, comment: overallComment })
    await sql`
      UPDATE inspections SET status = 'approved', items = ${JSON.stringify(items)}, hr_reviewer = ${reviewerName}, hr_comment = ${overallComment},
        hr_reviewed_at = NOW(), history = ${JSON.stringify(history)}, updated_at = NOW()
      WHERE id = ${id}
    `
    return { status: "approved", revisionIds }
  }
  history.push({ action: "revision_requested", by: reviewerName, at: now, cycle: insp.cycle, comment: overallComment, items: revisionIds })
  await sql`
    UPDATE inspections SET status = 'rejected', cycle = ${insp.cycle + 1}, items = ${JSON.stringify(items)}, hr_reviewer = ${reviewerName},
      hr_comment = ${overallComment}, hr_reviewed_at = NOW(), history = ${JSON.stringify(history)}, updated_at = NOW()
    WHERE id = ${id}
  `
  return { status: "rejected", revisionIds }
}

export async function getByToken(token: string): Promise<any | null> {
  const rows = await sql`SELECT * FROM inspections WHERE public_token = ${token} AND deleted_at IS NULL`
  return rows[0] ?? null
}

export async function getById(id: number): Promise<any | null> {
  const rows = await sql`SELECT * FROM inspections WHERE id = ${id} AND deleted_at IS NULL`
  return rows[0] ?? null
}

export interface ListFilters {
  status?: string
  branch?: string
  from?: string
  to?: string
  q?: string
  /** HR never sees drafts. */
  excludeDrafts?: boolean
}

function filterWhere(f: ListFilters) {
  const conds = [sql`deleted_at IS NULL`]
  if (f.status && f.status !== "all") conds.push(sql`status = ${f.status}`)
  if (f.excludeDrafts) conds.push(sql`status <> 'draft'`)
  if (f.branch) conds.push(sql`branch = ${f.branch}`)
  if (f.from && !isNaN(Date.parse(f.from))) conds.push(sql`inspect_date >= ${f.from}`)
  if (f.to && !isNaN(Date.parse(f.to))) conds.push(sql`inspect_date <= ${f.to}`)
  if (f.q?.trim()) {
    const like = `%${f.q.trim()}%`
    const codeId = parseInspectionCode(f.q)
    conds.push(codeId != null
      ? sql`(id = ${codeId} OR inspector_name ILIKE ${like} OR branch ILIKE ${like})`
      : sql`(inspector_name ILIKE ${like} OR branch ILIKE ${like} OR position ILIKE ${like} OR COALESCE(position_other, '') ILIKE ${like})`)
  }
  return conds.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`))
}

export const PAGE_SIZE = 20

export async function listFiltered(f: ListFilters, page = 1, pageSize = PAGE_SIZE): Promise<{ rows: any[]; total: number; page: number; pages: number }> {
  const where = filterWhere(f)
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM inspections WHERE ${where}`
  const pages = Math.max(1, Math.ceil(n / pageSize))
  const p = Math.min(Math.max(1, page), pages)
  const rows = await sql`SELECT * FROM inspections WHERE ${where} ORDER BY inspect_date DESC, created_at DESC LIMIT ${pageSize} OFFSET ${(p - 1) * pageSize}`
  return { rows, total: n, page: p, pages }
}

/** Every matching row, for Excel/PDF export. */
export async function listForExport(f: ListFilters): Promise<any[]> {
  return sql`SELECT * FROM inspections WHERE ${filterWhere(f)} ORDER BY inspect_date DESC, created_at DESC LIMIT 5000`
}

export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await sql`SELECT status, count(*)::int AS n FROM inspections WHERE deleted_at IS NULL GROUP BY status`
  const out: Record<string, number> = { draft: 0, pending: 0, approved: 0, rejected: 0 }
  for (const r of rows as any[]) out[r.status] = r.n
  return out
}

/** Soft delete (never a hard DELETE by a regular user). */
export async function softDelete(id: number): Promise<void> {
  await sql`UPDATE inspections SET deleted_at = NOW() WHERE id = ${id}`
}

/** Inspector deletes their own draft (htask-1791116230138 #9) — drafts
 * only; once submitted it's part of the HR record. */
export async function deleteDraft(token: string): Promise<void> {
  const [insp] = await sql`SELECT id, status FROM inspections WHERE public_token = ${token} AND deleted_at IS NULL`
  if (!insp) throw new Error("not_found")
  if (insp.status !== "draft") throw new Error("only_drafts")
  await sql`UPDATE inspections SET deleted_at = NOW() WHERE id = ${insp.id}`
}

/** Cleans up drafts that never got any content (from the old behaviour of
 * creating a row the moment "new" was opened): no name, no branch, no
 * checked item, no photo, and untouched for over an hour. */
export async function purgeEmptyDrafts(): Promise<number> {
  const rows = await sql`
    UPDATE inspections i SET deleted_at = NOW()
    WHERE i.status = 'draft' AND i.deleted_at IS NULL
      AND COALESCE(TRIM(i.inspector_name), '') = '' AND COALESCE(TRIM(i.branch), '') = ''
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.items) = 'array' THEN i.items WHEN jsonb_typeof(i.items) = 'string' THEN (i.items #>> '{}')::jsonb ELSE '[]'::jsonb END) e WHERE e->>'result' IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM inspection_photos p WHERE p.inspection_id = i.id)
      AND i.updated_at < NOW() - INTERVAL '1 hour'
    RETURNING i.id
  `
  return rows.length
}

/** Corrective-plan deadline state (htask-1791121739323 #15.2): "overdue"
 * once the due date has passed, "soon" within PLAN_DUE_SOON_DAYS, while the
 * audit isn't approved yet — an approved audit means HR has accepted the
 * outcome, so its plan no longer nags. Dates compared in Bangkok time. */
export const PLAN_DUE_SOON_DAYS = 3
export function planDueState(row: { plan_due_date?: any; status?: string }): "overdue" | "soon" | "ok" | null {
  if (!row.plan_due_date) return null
  if (row.status === "approved") return "ok"
  const due = dateOnly(row.plan_due_date)
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date())
  if (due < today) return "overdue"
  const diffDays = (Date.parse(due) - Date.parse(today)) / 86400000
  return diffDays <= PLAN_DUE_SOON_DAYS ? "soon" : "ok"
}

/** Not-yet-approved audits whose corrective plan is overdue / due soon. */
export async function countPlanDue(): Promise<{ overdue: number; soon: number }> {
  const rows = await sql`SELECT plan_due_date, status FROM inspections WHERE deleted_at IS NULL AND status <> 'approved' AND plan_due_date IS NOT NULL`
  let overdue = 0, soon = 0
  for (const r of rows as any[]) { const st = planDueState(r); if (st === "overdue") overdue++; else if (st === "soon") soon++ }
  return { overdue, soon }
}

/** Human inspection code ("รหัสการตรวจ", README htask-1791123159751) —
 * derived from the row id, so it's stable across revision rounds: GC-00012. */
export function inspectionCode(id: number | null | undefined): string {
  return id == null ? "-" : `GC-${String(id).padStart(5, "0")}`
}
/** Accepts "GC-00012", "gc12", "#12" … → 12, else null. */
export function parseInspectionCode(q: string | null | undefined): number | null {
  const m = String(q ?? "").trim().match(/^(?:gc-?|#)?0*(\d{1,9})$/i)
  return m && /^(gc|#)/i.test(String(q).trim()) ? Number(m[1]) : null
}
