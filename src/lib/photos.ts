/**
 * Evidence photos — one per (inspection, checklist item), per doc 6.4
 * ("แต่ละรูปเชื่อมกับ 1 หัวข้อของ 1 รายการตรวจเท่านั้น"). Compression
 * (max 1280px wide, ~80% JPEG quality) happens client-side before upload
 * (doc 8.2) — this layer just enforces the resulting size cap and stores
 * the already-compressed bytes.
 */
import { sql } from "./db"

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024 // 2MB after client-side compression, per doc 8.2
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png"]

export async function savePhoto(inspectionId: number, itemId: string, mimeType: string, bytes: Uint8Array): Promise<{ ok: true } | { ok: false; error: string }> {
  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    return { ok: false, error: `ไฟล์ใหญ่เกินไป (จำกัด ${MAX_PHOTO_BYTES / 1024 / 1024}MB ต่อรูป)` }
  }
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return { ok: false, error: "รองรับเฉพาะไฟล์ JPEG หรือ PNG" }
  }
  const base64 = Buffer.from(bytes).toString("base64")
  // One photo per (inspection, item) — re-uploading replaces the old one,
  // since re-taking a photo for the same item is the only realistic reason
  // to upload twice (matches the requirement's 1:1 photo-per-item rule).
  await sql`
    INSERT INTO inspection_photos (inspection_id, item_id, mime_type, data_base64, size_bytes)
    VALUES (${inspectionId}, ${itemId}, ${mimeType}, ${base64}, ${bytes.byteLength})
    ON CONFLICT (inspection_id, item_id) DO UPDATE SET mime_type = ${mimeType}, data_base64 = ${base64}, size_bytes = ${bytes.byteLength}, uploaded_at = NOW()
  `
  return { ok: true }
}

export async function getPhoto(inspectionId: number, itemId: string): Promise<{ mime_type: string; data_base64: string } | null> {
  const rows = await sql`SELECT mime_type, data_base64 FROM inspection_photos WHERE inspection_id = ${inspectionId} AND item_id = ${itemId}`
  return rows[0] ?? null
}

export async function listPhotoItemIds(inspectionId: number): Promise<string[]> {
  const rows = await sql`SELECT item_id FROM inspection_photos WHERE inspection_id = ${inspectionId}`
  return rows.map((r: any) => r.item_id)
}

export async function deletePhoto(inspectionId: number, itemId: string): Promise<void> {
  await sql`DELETE FROM inspection_photos WHERE inspection_id = ${inspectionId} AND item_id = ${itemId}`
}
