import postgres from "postgres"

export const sql = postgres(process.env.DATABASE_URL as string, { max: Number(process.env.DB_POOL_MAX || 10) })

export async function initDB() {
  // One row per inspection. items/history are JSONB — always read/written
  // as one unit with the parent inspection (never queried independently
  // across inspections), so a child table would just add join overhead for
  // no benefit — same reasoning as travel_requests.expense_rows in the TPF
  // project this session.
  await sql`
    CREATE TABLE IF NOT EXISTS inspections (
      id               SERIAL PRIMARY KEY,
      public_token     TEXT UNIQUE NOT NULL,
      inspector_name   TEXT NOT NULL,
      position         TEXT NOT NULL,
      position_other   TEXT,
      branch           TEXT NOT NULL,
      inspect_date     DATE NOT NULL,
      items            JSONB NOT NULL DEFAULT '[]',
      status           TEXT NOT NULL DEFAULT 'draft',
      cycle            INT NOT NULL DEFAULT 1,
      score            INT,
      percent          INT,
      overall_result   TEXT,
      hr_reviewer      TEXT,
      hr_comment       TEXT,
      hr_reviewed_at   TIMESTAMPTZ,
      submitted_at     TIMESTAMPTZ,
      history          JSONB NOT NULL DEFAULT '[]',
      deleted_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_inspections_status ON inspections(status)`
  await sql`CREATE INDEX IF NOT EXISTS idx_inspections_branch ON inspections(branch)`
  await sql`CREATE INDEX IF NOT EXISTS idx_inspections_created_at ON inspections(created_at)`

  // One row per (inspection, itemId) photo — a checklist item can only ever
  // have one photo per the spec ("แต่ละรูปเชื่อมกับ 1 หัวข้อของ 1 รายการ
  // ตรวจเท่านั้น"), so re-uploading for the same item replaces the old row
  // rather than accumulating (see lib/inspections.ts savePhoto). Inline
  // base64 storage matches the attachment pattern used throughout this
  // session (PRF/PR/TPF) — simplest option with no object-storage
  // credentials available in this environment.
  await sql`
    CREATE TABLE IF NOT EXISTS inspection_photos (
      id             SERIAL PRIMARY KEY,
      inspection_id  INT NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
      item_id        TEXT NOT NULL,
      mime_type      TEXT NOT NULL,
      data_base64    TEXT NOT NULL,
      size_bytes     INT NOT NULL,
      uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (inspection_id, item_id)
    )
  `
  // v2 (2026-10-04, htask-1791116230138):
  //  - photos get a `kind` ('before' = original evidence, 'after' = proof of
  //    the corrective action for an item HR asked to revise) so HR can compare
  //    them side by side; one photo per (inspection, item, kind).
  //  - optional inspector email, used only to notify them when HR sends
  //    items back (there is still no login in this app).
  await sql`ALTER TABLE inspection_photos ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'before'`
  await sql`ALTER TABLE inspection_photos DROP CONSTRAINT IF EXISTS inspection_photos_inspection_id_item_id_key`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_inspection_photos_item_kind ON inspection_photos(inspection_id, item_id, kind)`
  await sql`ALTER TABLE inspections ADD COLUMN IF NOT EXISTS inspector_email TEXT`
  await sql`CREATE INDEX IF NOT EXISTS idx_inspections_inspect_date ON inspections(inspect_date)`
  // v3 (htask-1791121739323 #15.2): optional corrective plan at the end of
  // the form — problem found, solution (short), due date.
  await sql`ALTER TABLE inspections ADD COLUMN IF NOT EXISTS plan_problem TEXT`
  await sql`ALTER TABLE inspections ADD COLUMN IF NOT EXISTS plan_solution TEXT`
  await sql`ALTER TABLE inspections ADD COLUMN IF NOT EXISTS plan_due_date DATE`
  console.log("[db] schema ready")
}
