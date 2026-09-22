import { Hono } from "hono"
import { saveDraft, submitForReview, getByToken, type InspectionInput } from "../lib/inspections"
import { savePhoto, getPhoto } from "../lib/photos"

const app = new Hono()

function parseInput(body: any): InspectionInput {
  return {
    inspectorName: String(body.inspectorName || "").trim(),
    position: String(body.position || "").trim(),
    positionOther: body.positionOther ? String(body.positionOther).trim() : null,
    branch: String(body.branch || "").trim(),
    inspectDate: String(body.inspectDate || "").trim(),
    items: Array.isArray(body.items)
      ? body.items.map((i: any) => ({
          itemId: String(i.itemId || ""),
          result: i.result === "pass" || i.result === "fail" ? i.result : null,
          note: i.note ? String(i.note).trim() : null,
        }))
      : [],
  }
}

app.post("/inspect/:token/draft", async (c) => {
  const token = c.req.param("token")
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: "invalid_body" }, 400)
  try {
    await saveDraft(token, parseInput(body))
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

app.post("/inspect/:token/submit", async (c) => {
  const token = c.req.param("token")
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: "invalid_body" }, 400)
  const inspectorName = String(body.inspectorName || "").trim() || "ไม่ระบุชื่อ"
  try {
    await submitForReview(token, parseInput(body), inspectorName)
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

app.post("/inspect/:token/photo/:itemId", async (c) => {
  const token = c.req.param("token")
  const itemId = c.req.param("itemId")
  const insp = await getByToken(token)
  if (!insp) return c.json({ error: "not_found" }, 404)
  if (insp.status !== "draft" && insp.status !== "rejected") return c.json({ error: "locked" }, 400)

  const form = await c.req.formData().catch(() => null)
  const file = form?.get("photo")
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "no_file" }, 400)

  const bytes = new Uint8Array(await file.arrayBuffer())
  const result = await savePhoto(insp.id, itemId, file.type || "image/jpeg", bytes)
  if (!result.ok) return c.json({ error: result.error }, 400)
  return c.json({ ok: true })
})

// Photo access is gated by knowing the long random public_token (same
// trust model as PRF/PR/TPF's sign links this session) — no separate login
// exists in this MVP to gate on instead (see doc 9.1's explicit decision).
app.get("/inspect/:token/photo/:itemId", async (c) => {
  const token = c.req.param("token")
  const itemId = c.req.param("itemId")
  const insp = await getByToken(token)
  if (!insp) return c.text("ไม่พบเอกสาร", 404)
  const photo = await getPhoto(insp.id, itemId)
  if (!photo) return c.text("ไม่พบรูปภาพ", 404)
  const bytes = Buffer.from(photo.data_base64, "base64")
  return new Response(bytes, { headers: { "Content-Type": photo.mime_type, "Cache-Control": "private, max-age=3600" } })
})

// HR's photo view reaches the same photo by inspection id (HR browses by
// id, not token) — resolved to the same underlying storage.
app.get("/inspect-by-id/:id/photo/:itemId", async (c) => {
  const id = parseInt(c.req.param("id"), 10)
  const itemId = c.req.param("itemId")
  const photo = await getPhoto(id, itemId)
  if (!photo) return c.text("ไม่พบรูปภาพ", 404)
  const bytes = Buffer.from(photo.data_base64, "base64")
  return new Response(bytes, { headers: { "Content-Type": photo.mime_type, "Cache-Control": "private, max-age=3600" } })
})

export default app
