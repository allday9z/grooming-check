import { Hono } from "hono"
import { renderPage, esc, statusBadge } from "../ui/layout"
import { CHECKLIST_ITEMS, CATEGORY_LABELS, CHECKLIST_TOTAL } from "../lib/checklist"
import { countByStatus, getById, reviewAudit, parseJsonbArray, listFiltered, listForExport, PASS_THRESHOLD_PERCENT } from "../lib/inspections"
import { listPhotoKinds } from "../lib/photos"
import { fmtDateTH, fmtDateTimeTH } from "../lib/format"
import { filtersFromQuery, filterBarHtml, paginationHtml, queryString, xlsxResponse, reportHtml, LIST_STYLES } from "../lib/report"
import { notifyInspectorReviewed } from "../lib/notify"

const app = new Hono()

const HISTORY_LABEL: Record<string, string> = {
  created: "สร้างรายการ", saved: "บันทึกร่าง", submitted: "ส่งตรวจสอบ", approved: "ยืนยันทั้งรายการ (อนุมัติ)",
  rejected: "ตีกลับทั้งใบ", revision_requested: "ขอให้แก้ไขรายข้อ", deleted: "ลบ",
}

function itemLabel(id: string): string {
  return CHECKLIST_ITEMS.find((i) => i.itemId === id)?.label ?? id
}

app.get("/", async (c) => {
  const f = filtersFromQuery((k) => c.req.query(k))
  if (!f.status) f.status = "pending"
  const counts = await countByStatus()
  const { rows, total, page, pages } = await listFiltered({ ...f, excludeDrafts: true }, f.page)

  const tabs = [
    { key: "pending", label: `รอตรวจสอบ (${counts.pending})` },
    { key: "rejected", label: `รอผู้ตรวจแก้ไข (${counts.rejected})` },
    { key: "approved", label: `อนุมัติแล้ว (${counts.approved})` },
    { key: "all", label: "ทั้งหมด" },
  ]
  const tabsHtml = tabs.map((t) => `<a class="tab${t.key === f.status ? " active" : ""}" href="/hr${queryString({ ...f, page: 1 }, { status: t.key })}">${t.label}</a>`).join("")

  const rowsHtml = rows.length
    ? rows.map((r: any) => `
        <tr class="clickable" onclick="window.location='/hr/${r.id}'">
          <td>${esc(r.branch)}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${esc(r.inspector_name)}</td>
          <td>${fmtDateTH(r.inspect_date)}</td>
          <td>${r.score != null ? `${r.score}/${CHECKLIST_TOTAL} (${r.percent}%)` : "-"}</td>
          <td>${r.overall_result === "pass" ? '<span class="badge approved">ผ่าน</span>' : r.overall_result === "fail" ? '<span class="badge rejected">ไม่ผ่าน</span>' : "-"}</td>
          <td>${r.cycle}</td>
          <td>${fmtDateTimeTH(r.submitted_at)}</td>
        </tr>`).join("")
    : `<tr><td colspan="8" style="text-align:center;color:#94a3b8;">ไม่พบรายการ</td></tr>`

  const body = `
    <div class="top-nav">
      <h1 style="margin:0;">แดชบอร์ด HR — ตรวจ Grooming</h1>
      <a href="/inspect">← กลับหน้าผู้ตรวจ</a>
    </div>
    <div class="stat-grid">
      <div class="stat-box"><div class="num">${counts.pending}</div><div class="label">รอตรวจสอบ</div></div>
      <div class="stat-box"><div class="num">${counts.rejected}</div><div class="label">รอผู้ตรวจแก้ไข</div></div>
      <div class="stat-box"><div class="num">${counts.approved}</div><div class="label">อนุมัติแล้ว</div></div>
    </div>
    <div class="tabs">${tabsHtml}</div>
    ${filterBarHtml("/hr", f, { keepStatus: true })}
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>สาขา</th><th>สถานะ</th><th>ผู้ตรวจ</th><th>วันที่ตรวจ</th><th>คะแนน</th><th>ผลรวม</th><th>รอบ</th><th>ส่งเมื่อ</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      ${paginationHtml("/hr", f, page, pages, total)}
    </div>`
  return c.html(renderPage({ title: "แดชบอร์ด HR — Grooming Check", body, styles: LIST_STYLES, wide: true }))
})

app.get("/export.xlsx", async (c) => {
  const f = filtersFromQuery((k) => c.req.query(k))
  return xlsxResponse(await listForExport({ ...f, excludeDrafts: true }), "grooming-hr")
})

app.get("/report", async (c) => {
  const f = filtersFromQuery((k) => c.req.query(k))
  return c.html(reportHtml("รายงานการตรวจ Grooming (HR)", await listForExport({ ...f, excludeDrafts: true }), f))
})

app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10)
  if (isNaN(id)) return c.text("ไม่พบรายการตรวจ", 404)
  const insp = await getById(id)
  if (!insp) return c.text("ไม่พบรายการตรวจ", 404)

  const photos = await listPhotoKinds(insp.id)
  const items = parseJsonbArray<any>(insp.items)
  const itemsById = new Map(items.map((i) => [i.itemId, i]))
  const reviewing = insp.status === "pending"
  const photoUrl = (itemId: string, kind: string) => `/api/inspect-by-id/${insp.id}/photo/${itemId}?kind=${kind}`
  const categoryOrder = ["uniform", "personal", "card"]

  const checklistHtml = categoryOrder.map((cat) => {
    const defs = CHECKLIST_ITEMS.filter((i) => i.category === cat)
    const itemsHtml = defs.map((def) => {
      const cur = itemsById.get(def.itemId)
      const result = cur?.result ?? null
      const hasBefore = photos.before.has(def.itemId)
      const hasAfter = photos.after.has(def.itemId)
      const confirmed = !!cur?.confirmed
      const resubmitted = !!cur?.revision && !!cur?.corrective
      const doneClass = result === "pass" ? " done-pass" : result === "fail" ? " done-fail" : ""
      // Before/After side by side whenever an "after" photo exists
      // (htask-1791116230138 #6) — otherwise just the evidence photo.
      const photoHtml = hasAfter
        ? `<div class="ba-compare">
            <div><div class="ba-label">ก่อน (Before)</div>${hasBefore ? `<img class="photo-thumb ba-img" src="${photoUrl(def.itemId, "before")}" onclick="openLightbox(this.src)">` : `<span class="sub">ไม่มีรูป</span>`}</div>
            <div><div class="ba-label">หลัง (After)</div><img class="photo-thumb ba-img" src="${photoUrl(def.itemId, "after")}" onclick="openLightbox(this.src)"></div>
          </div>`
        : hasBefore ? `<img class="photo-thumb" style="margin-top:8px;" src="${photoUrl(def.itemId, "before")}" onclick="openLightbox(this.src)">` : ""
      const revHtml = cur?.revision ? `
        <div class="rev-box" style="margin-top:8px;">
          <div class="rev-title">ขอแก้ไขรอบที่ ${cur.revision.cycle} โดย ${esc(cur.revision.by)}</div>
          <div class="rev-comment">${esc(cur.revision.comment)}</div>
          ${cur.corrective ? `<div class="corrective-done">✔ Corrective action submitted${cur.corrective.at ? ` · ${fmtDateTimeTH(cur.corrective.at)}` : ""}<br>${esc(cur.corrective.note)}</div>` : `<div class="rev-by">ยังไม่ได้ส่งการแก้ไข</div>`}
        </div>` : ""
      const reviewCtl = reviewing && !confirmed ? `
        <label class="rev-toggle"><input type="checkbox" class="rev-check" data-item="${def.itemId}"> ขอให้แก้ไขข้อนี้ (Request revision)</label>
        <div class="rev-comment-box" style="display:none;"><textarea class="rev-comment-input" rows="2" placeholder="ระบุสิ่งที่ต้องแก้ไขในข้อนี้ (บังคับ)"></textarea><div class="errmsg rev-err">กรุณาระบุความเห็นของข้อนี้</div></div>` : ""
      return `
      <div class="check-item${doneClass}${confirmed ? " locked-item" : ""}${resubmitted && !confirmed ? " rev-item" : ""}">
        <div class="check-item-label">${esc(def.label)} — ${result === "pass" ? "✅ ผ่าน" : result === "fail" ? "❌ ไม่ผ่าน" : "ยังไม่ได้ตรวจ"}
          ${confirmed ? `<span class="item-tag ok">✔ ยืนยันแล้ว</span>` : resubmitted ? `<span class="item-tag warn">แก้ไขแล้ว รอตรวจ</span>` : ""}</div>
        ${cur?.note ? `<p style="font-size:13px;color:#6b7280;margin:6px 0 0;">หมายเหตุ: ${esc(cur.note)}</p>` : ""}
        ${photoHtml}
        ${revHtml}
        ${reviewCtl}
      </div>`
    }).join("")
    return `<div class="checklist-cat">${esc(CATEGORY_LABELS[cat]!)}</div>${itemsHtml}`
  }).join("")

  const history = parseJsonbArray<any>(insp.history)
  const historyHtml = history.length
    ? `<div class="table-wrap"><table><thead><tr><th>เวลา</th><th>การกระทำ</th><th>โดย</th><th>รอบ</th><th>หมายเหตุ</th></tr></thead><tbody>
        ${history.slice().reverse().map((h) => `<tr><td>${fmtDateTimeTH(h.at)}</td><td>${esc(HISTORY_LABEL[h.action] || h.action)}</td><td>${esc(h.by)}</td><td>${h.cycle}</td><td style="white-space:normal;">${esc([h.comment, h.items?.length ? `ข้อ: ${h.items.map(itemLabel).join(", ")}` : ""].filter(Boolean).join(" · ") || "-")}</td></tr>`).join("")}
      </tbody></table></div>`
    : `<p class="sub">ยังไม่มีประวัติ</p>`

  const openCount = items.filter((i) => !i.confirmed).length
  const actionsHtml = reviewing ? `
    <div class="card review-card">
      <h2>ยืนยันผลการตรวจ</h2>
      <p class="sub">ติ๊ก "ขอให้แก้ไขข้อนี้" พร้อมความเห็นในข้อที่ต้องการให้แก้ แล้วกด <b>Confirm Entire Audit ID</b> — ข้อที่ไม่ได้ติ๊กจะถูกยืนยันและปิด (แก้ไขไม่ได้อีก) · ถ้าไม่ติ๊กเลย = อนุมัติทั้งรายการ</p>
      <div class="field"><label>ชื่อผู้ตรวจสอบ (HR)<span class="req">*</span></label><input type="text" id="reviewer"></div>
      <div class="field"><label>หมายเหตุถึงผู้ตรวจ (ไม่บังคับ)</label><textarea id="overall-comment" rows="2"></textarea></div>
      <p id="review-summary" class="sub" style="margin:0 0 10px;"></p>
      <button type="button" class="btn" id="confirm-btn" style="width:100%;">Confirm Entire Audit ID</button>
      <div class="errmsg" id="review-err"></div>
      <div class="status-line" id="status-line"></div>
    </div>` : ""

  const body = `
    <div class="top-nav"><a href="/hr">← แดชบอร์ด HR</a></div>
    <div class="card">
      <h1 style="margin:0 0 4px;">${esc(insp.branch)} ${statusBadge(insp.status)}</h1>
      <p class="sub">Audit ID #${insp.id} · รอบตรวจที่ ${insp.cycle}</p>
      <table>
        <tr><td style="width:160px;color:#64748b;">ผู้ตรวจ</td><td>${esc(insp.inspector_name)} (${esc(insp.position === "อื่นๆ" ? insp.position_other : insp.position)})${insp.inspector_email ? ` · ${esc(insp.inspector_email)}` : ""}</td></tr>
        <tr><td style="color:#64748b;">วันที่ตรวจ</td><td>${fmtDateTH(insp.inspect_date)}</td></tr>
        <tr><td style="color:#64748b;">ส่งเมื่อ</td><td>${fmtDateTimeTH(insp.submitted_at)}</td></tr>
        ${insp.hr_reviewer ? `<tr><td style="color:#64748b;">ผู้ตรวจสอบล่าสุด</td><td>${esc(insp.hr_reviewer)} (${fmtDateTimeTH(insp.hr_reviewed_at)})</td></tr>` : ""}
      </table>
      <div class="stat-grid" style="margin-top:14px;">
        <div class="stat-box"><div class="num">${insp.score ?? "-"}/${CHECKLIST_TOTAL}</div><div class="label">คะแนนผ่าน</div></div>
        <div class="stat-box"><div class="num">${insp.percent ?? "-"}%</div><div class="label">เปอร์เซ็นต์</div></div>
        <div class="stat-box"><div class="num">${insp.overall_result === "pass" ? "ผ่าน" : insp.overall_result === "fail" ? "ไม่ผ่าน" : "-"}</div><div class="label">ผลรวม (เกณฑ์ ≥ ${PASS_THRESHOLD_PERCENT}%)</div></div>
      </div>
    </div>
    ${insp.hr_comment ? `<div class="reject-banner"><b>หมายเหตุล่าสุดจาก HR (${esc(insp.hr_reviewer)})</b><p style="margin:6px 0 0;">${esc(insp.hr_comment)}</p></div>` : ""}
    <div class="card">
      <h2>รายการตรวจทั้ง ${CHECKLIST_TOTAL} ข้อ ${reviewing ? `<span class="sub" style="font-weight:400;">· รอยืนยัน ${openCount} ข้อ</span>` : ""}</h2>
      ${checklistHtml}
    </div>
    ${actionsHtml}
    <div class="card"><h2>ประวัติการดำเนินการ</h2>${historyHtml}</div>
  `

  const scripts = reviewing ? `
(function() {
  function $(id) { return document.getElementById(id); }
  function refreshSummary() {
    var n = document.querySelectorAll('.rev-check:checked').length;
    $('review-summary').textContent = n ? ('ขอให้แก้ไข ' + n + ' ข้อ — ข้อที่เหลือจะถูกยืนยันและปิด') : 'ไม่มีข้อที่ขอแก้ไข — กดยืนยันเพื่ออนุมัติทั้งรายการ';
  }
  document.querySelectorAll('.rev-check').forEach(function(cb) {
    cb.addEventListener('change', function() {
      var box = cb.closest('.check-item').querySelector('.rev-comment-box');
      box.style.display = cb.checked ? 'block' : 'none';
      cb.closest('.check-item').classList.toggle('rev-flag', cb.checked);
      refreshSummary();
    });
  });
  refreshSummary();
  $('confirm-btn').addEventListener('click', async function() {
    var reviewer = $('reviewer').value.trim();
    var err = $('review-err');
    err.classList.remove('show');
    if (!reviewer) { err.textContent = 'กรุณากรอกชื่อผู้ตรวจสอบ (HR)'; err.classList.add('show'); $('reviewer').focus(); return; }
    var revisions = [], missing = false;
    document.querySelectorAll('.rev-check:checked').forEach(function(cb) {
      var item = cb.closest('.check-item');
      var comment = item.querySelector('.rev-comment-input').value.trim();
      item.querySelector('.rev-err').classList.toggle('show', !comment);
      if (!comment) missing = true;
      revisions.push({ itemId: cb.getAttribute('data-item'), comment: comment });
    });
    if (missing) { err.textContent = 'กรุณาระบุความเห็นในทุกข้อที่ขอให้แก้ไข'; err.classList.add('show'); return; }
    var msg = revisions.length ? ('ยืนยันส่งกลับให้แก้ไข ' + revisions.length + ' ข้อ และยืนยันข้อที่เหลือ?') : 'ยืนยันอนุมัติทั้งรายการ (Confirm Entire Audit ID)?';
    if (!confirm(msg)) return;
    $('confirm-btn').disabled = true;
    try {
      var res = await fetch('/hr/${insp.id}/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewer: reviewer, comment: $('overall-comment').value.trim(), revisions: revisions }) });
      var data = await res.json();
      if (!res.ok) { err.textContent = 'เกิดข้อผิดพลาด: ' + (data.error || ''); err.classList.add('show'); $('confirm-btn').disabled = false; return; }
      $('status-line').className = 'status-line ok';
      $('status-line').textContent = (data.status === 'approved' ? 'อนุมัติทั้งรายการแล้ว' : 'ส่งกลับให้แก้ไข ' + revisions.length + ' ข้อแล้ว') + ' ✅ กำลังโหลดหน้าใหม่...';
      setTimeout(function() { window.location.reload(); }, 1000);
    } catch (e) {
      err.textContent = 'เกิดข้อผิดพลาด กรุณาลองใหม่'; err.classList.add('show'); $('confirm-btn').disabled = false;
    }
  });
})();` : ""

  return c.html(renderPage({ title: `รายละเอียดการตรวจ — ${insp.branch}`, body, scripts, wide: true }))
})

// "Confirm Entire Audit ID" (htask-1791116230138 #5): revisions = items HR
// ticked with their comments; every other open item is confirmed/closed.
app.post("/:id/review", async (c) => {
  const id = parseInt(c.req.param("id"), 10)
  const body = await c.req.json().catch(() => null)
  const reviewer = String(body?.reviewer || "").trim()
  if (!reviewer) return c.json({ error: "reviewer_required" }, 400)
  const revisions = Array.isArray(body?.revisions)
    ? body.revisions.map((r: any) => ({ itemId: String(r.itemId || ""), comment: String(r.comment || "").trim() }))
    : []
  const overall = String(body?.comment || "").trim() || null
  try {
    const result = await reviewAudit(id, reviewer, revisions, overall)
    const insp = await getById(id)
    if (insp) notifyInspectorReviewed(insp, result.status, revisions.filter((r: any) => result.revisionIds.includes(r.itemId)), reviewer, overall)
    return c.json({ ok: true, status: result.status })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

// Legacy whole-sheet endpoints kept for any open tab from before the
// per-item review: approve = confirm everything; reject = flag every
// still-open item with the same comment.
app.post("/:id/approve", async (c) => {
  const id = parseInt(c.req.param("id"), 10)
  const body = await c.req.json().catch(() => null)
  const reviewer = String(body?.reviewer || "").trim()
  if (!reviewer) return c.json({ error: "reviewer_required" }, 400)
  try {
    await reviewAudit(id, reviewer, [], null)
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

app.post("/:id/reject", async (c) => {
  const id = parseInt(c.req.param("id"), 10)
  const body = await c.req.json().catch(() => null)
  const reviewer = String(body?.reviewer || "").trim()
  const comment = String(body?.comment || "").trim()
  if (!reviewer) return c.json({ error: "reviewer_required" }, 400)
  if (!comment) return c.json({ error: "comment_required" }, 400)
  const insp = await getById(id)
  if (!insp) return c.json({ error: "not_found" }, 404)
  const open = parseJsonbArray<any>(insp.items).filter((i) => !i.confirmed).map((i) => ({ itemId: i.itemId, comment }))
  try {
    const result = await reviewAudit(id, reviewer, open, comment)
    return c.json({ ok: true, status: result.status })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

export default app
