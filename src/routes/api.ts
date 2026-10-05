import { Hono } from "hono"
import { createDraft, saveDraft, submitForReview, getByToken, getById, deleteDraft, isEmptyInput, openRevisionIds, parseJsonbArray, validationMessage, type InspectionInput } from "../lib/inspections"
import { savePhoto, getPhoto, deletePhoto, type PhotoKind } from "../lib/photos"
import { isValidPhotoSlot, GROUP_PHOTO_SLOTS } from "../lib/checklist"
import { notifyHrSubmitted } from "../lib/notify"
import { requireHr } from "../lib/hr-auth"

const app = new Hono()

function parseInput(body: any): InspectionInput {
  return {
    inspectorName: String(body.inspectorName || "").trim(),
    inspectorEmail: body.inspectorEmail ? String(body.inspectorEmail).trim().slice(0, 200) || null : null,
    position: String(body.position || "").trim(),
    positionOther: body.positionOther ? String(body.positionOther).trim() : null,
    branch: String(body.branch || "").trim(),
    inspectDate: String(body.inspectDate || "").trim(),
    planProblem: body.planProblem ? String(body.planProblem).trim().slice(0, 1000) || null : null,
    planSolution: body.planSolution ? String(body.planSolution).trim().slice(0, 300) || null : null,
    planDueDate: body.planDueDate ? String(body.planDueDate).trim().slice(0, 10) || null : null,
    items: Array.isArray(body.items)
      ? body.items.map((i: any) => ({
          itemId: String(i.itemId || ""),
          result: i.result === "pass" || i.result === "fail" ? i.result : null,
          note: i.note ? String(i.note).trim() : null,
          fix: i.fix ? String(i.fix).trim() : null,
          corrective: i.correctiveNote ? { note: String(i.correctiveNote).trim(), at: null } : null,
        }))
      : [],
  }
}

function kindOf(v: any): PhotoKind {
  return v === "after" ? "after" : "before"
}

// Creates the draft on its FIRST real save (htask-1791116230138 #9) — the
// "new" page no longer inserts a row just for being opened.
app.post("/inspect/create", async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: "invalid_body" }, 400)
  const input = parseInput(body)
  if (isEmptyInput(input) && !body.force) return c.json({ error: "empty" }, 400)
  const { token } = await createDraft(input, input.inspectorName || "ผู้ตรวจ (ยังไม่ระบุชื่อ)")
  return c.json({ ok: true, token })
})

app.post("/inspect/:token/draft", async (c) => {
  const token = c.req.param("token")
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: "invalid_body" }, 400)
  try {
    await saveDraft(token, parseInput(body))
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message, message: validationMessage(e.message) }, 400)
  }
})

app.post("/inspect/:token/submit", async (c) => {
  const token = c.req.param("token")
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: "invalid_body" }, 400)
  const inspectorName = String(body.inspectorName || "").trim() || "ไม่ระบุชื่อ"
  try {
    const before = await getByToken(token)
    const reopened = before && before.status === "rejected" ? openRevisionIds(parseJsonbArray(before.items)) : []
    const { id } = await submitForReview(token, parseInput(body), inspectorName)
    const after = await getById(id)
    if (after) notifyHrSubmitted(after, reopened)
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message, message: validationMessage(e.message) }, 400)
  }
})

app.post("/inspect/:token/delete", async (c) => {
  try {
    await deleteDraft(c.req.param("token"))
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

app.post("/inspect/:token/photo/:itemId", async (c) => {
  const token = c.req.param("token")
  const itemId = c.req.param("itemId")
  const kind = kindOf(c.req.query("kind"))
  if (!isValidPhotoSlot(itemId)) return c.json({ error: "invalid_item" }, 400)
  const insp = await getByToken(token)
  if (!insp) return c.json({ error: "not_found" }, 404)
  if (insp.status !== "draft" && insp.status !== "rejected") return c.json({ error: "locked" }, 400)
  // While items are out for revision only those items' photos may change,
  // and the new evidence goes in as the "after" photo (Before/After).
  const open = insp.status === "rejected" ? openRevisionIds(parseJsonbArray(insp.items)) : []
  if (open.length && !open.includes(itemId)) return c.json({ error: "item_locked" }, 400)
  if (open.length && kind !== "after") return c.json({ error: "after_photo_only" }, 400)

  const form = await c.req.formData().catch(() => null)
  const file = form?.get("photo")
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "no_file" }, 400)

  const bytes = new Uint8Array(await file.arrayBuffer())
  const result = await savePhoto(insp.id, itemId, file.type || "image/jpeg", bytes, kind)
  if (!result.ok) return c.json({ error: result.error }, 400)
  return c.json({ ok: true })
})

// Remove one of the "ง. รูปรวม" group photos (draft / non-revision only).
app.post("/inspect/:token/photo/:itemId/delete", async (c) => {
  const itemId = c.req.param("itemId")
  if (!GROUP_PHOTO_SLOTS.includes(itemId)) return c.json({ error: "invalid_item" }, 400)
  const insp = await getByToken(c.req.param("token"))
  if (!insp) return c.json({ error: "not_found" }, 404)
  const open = insp.status === "rejected" ? openRevisionIds(parseJsonbArray(insp.items)) : []
  if ((insp.status !== "draft" && insp.status !== "rejected") || open.length) return c.json({ error: "locked" }, 400)
  await deletePhoto(insp.id, itemId, "before")
  return c.json({ ok: true })
})

// Photo access is gated by knowing the long random public_token — no login
// exists in this app to gate on instead.
app.get("/inspect/:token/photo/:itemId", async (c) => {
  const insp = await getByToken(c.req.param("token"))
  if (!insp) return c.text("ไม่พบเอกสาร", 404)
  const photo = await getPhoto(insp.id, c.req.param("itemId"), kindOf(c.req.query("kind")))
  if (!photo) return c.text("ไม่พบรูปภาพ", 404)
  return new Response(Buffer.from(photo.data_base64, "base64"), { headers: { "Content-Type": photo.mime_type, "Cache-Control": "private, max-age=300" } })
})

// HR-only (browses by numeric id, which is guessable) — needs the HR login.
app.get("/inspect-by-id/:id/photo/:itemId", requireHr, async (c) => {
  const photo = await getPhoto(parseInt(c.req.param("id"), 10), c.req.param("itemId"), kindOf(c.req.query("kind")))
  if (!photo) return c.text("ไม่พบรูปภาพ", 404)
  return new Response(Buffer.from(photo.data_base64, "base64"), { headers: { "Content-Type": photo.mime_type, "Cache-Control": "private, max-age=300" } })
})

export default app
