import { Hono } from "hono"
import { renderPage, esc, statusBadge } from "../ui/layout"
import { CHECKLIST_ITEMS, CATEGORY_LABELS, CHECKLIST_TOTAL } from "../lib/checklist"
import { listAll, countByStatus, getById, approve, reject } from "../lib/inspections"
import { listPhotoItemIds } from "../lib/photos"

const app = new Hono()

function fmtDateTH(d: any): string {
  if (!d) return "-"
  const v = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
  const [y, m, day] = v.split("-")
  return `${day}/${m}/${y}`
}
function fmtDateTimeTH(d: any): string {
  if (!d) return "-"
  const dt = new Date(d)
  return dt.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Bangkok" })
}

app.get("/", async (c) => {
  const tab = c.req.query("status") || "pending"
  const counts = await countByStatus()
  const rows = await listAll(tab)

  const tabs = [
    { key: "pending", label: "รอตรวจสอบ" },
    { key: "approved", label: "อนุมัติแล้ว" },
    { key: "rejected", label: "ตีกลับ" },
    { key: "all", label: "ทั้งหมด" },
  ]
  const tabsHtml = tabs.map((t) => `<a class="tab${t.key === tab ? " active" : ""}" href="/hr?status=${t.key}">${t.label}</a>`).join("")

  const rowsHtml = rows.length
    ? rows.map((r: any) => `
        <tr class="clickable" onclick="window.location='/hr/${r.id}'">
          <td>${esc(r.branch)}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${esc(r.inspector_name)}</td>
          <td>${fmtDateTH(r.inspect_date)}</td>
          <td>${r.score != null ? `${r.score}/${CHECKLIST_TOTAL} (${r.percent}%)` : "-"}</td>
          <td>${fmtDateTimeTH(r.submitted_at)}</td>
        </tr>`).join("")
    : `<tr><td colspan="6" style="text-align:center;color:#94a3b8;">ไม่พบรายการ</td></tr>`

  const body = `
    <div class="top-nav">
      <h1 style="margin:0;">แดชบอร์ด HR — ตรวจ Grooming</h1>
      <a href="/inspect">← กลับหน้าผู้ตรวจ</a>
    </div>
    <div class="stat-grid">
      <div class="stat-box"><div class="num">${counts.pending}</div><div class="label">รอตรวจสอบ</div></div>
      <div class="stat-box"><div class="num">${counts.approved}</div><div class="label">อนุมัติแล้ว</div></div>
      <div class="stat-box"><div class="num">${counts.rejected}</div><div class="label">ตีกลับ</div></div>
    </div>
    <div class="tabs">${tabsHtml}</div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>สาขา</th><th>สถานะ</th><th>ผู้ตรวจ</th><th>วันที่ตรวจ</th><th>คะแนน</th><th>ส่งเมื่อ</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>`
  return c.html(renderPage({ title: "แดชบอร์ด HR — Grooming Check", body, wide: true }))
})

app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10)
  const insp = await getById(id)
  if (!insp) return c.text("ไม่พบรายการตรวจ", 404)

  const photoItemIds = new Set(await listPhotoItemIds(insp.id))
  const itemsById = new Map((insp.items as any[]).map((i) => [i.itemId, i]))
  const categoryOrder = ["uniform", "personal", "card"]

  const checklistHtml = categoryOrder.map((cat) => {
    const items = CHECKLIST_ITEMS.filter((i) => i.category === cat)
    const itemsHtml = items.map((def) => {
      const cur = itemsById.get(def.itemId)
      const result = cur?.result ?? null
      const hasPhoto = photoItemIds.has(def.itemId)
      const doneClass = result === "pass" ? " done-pass" : result === "fail" ? " done-fail" : ""
      return `
      <div class="check-item${doneClass}">
        <div class="check-item-label">${esc(def.label)} — ${result === "pass" ? "✅ ผ่าน" : result === "fail" ? "❌ ไม่ผ่าน" : "ยังไม่ได้ตรวจ"}</div>
        ${cur?.note ? `<p style="font-size:13px;color:#6b7280;margin:6px 0 0;">หมายเหตุ: ${esc(cur.note)}</p>` : ""}
        ${hasPhoto ? `<img class="photo-thumb" style="margin-top:8px;" src="/api/inspect-by-id/${insp.id}/photo/${def.itemId}" onclick="openLightbox(this.src)">` : ""}
      </div>`
    }).join("")
    return `<div class="checklist-cat">${esc(CATEGORY_LABELS[cat]!)}</div>${itemsHtml}`
  }).join("")

  const history = (insp.history as any[]) || []
  const historyHtml = history.length
    ? `<div class="table-wrap"><table><thead><tr><th>เวลา</th><th>การกระทำ</th><th>โดย</th><th>รอบ</th><th>หมายเหตุ</th></tr></thead><tbody>
        ${history.slice().reverse().map((h) => `<tr><td>${fmtDateTimeTH(h.at)}</td><td>${esc({ created: "สร้างรายการ", saved: "บันทึกร่าง", submitted: "ส่งตรวจสอบ", approved: "อนุมัติ", rejected: "ตีกลับ" }[h.action as string] || h.action)}</td><td>${esc(h.by)}</td><td>${h.cycle}</td><td>${esc(h.comment || "-")}</td></tr>`).join("")}
      </tbody></table></div>`
    : `<p class="sub">ยังไม่มีประวัติ</p>`

  const actionsHtml = insp.status === "pending"
    ? `
    <div class="card">
      <h2>การอนุมัติ</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button type="button" class="btn" id="approve-btn" style="flex:1;">✅ อนุมัติ</button>
        <button type="button" class="btn btn-danger" id="reject-btn" style="flex:1;">↩️ ตีกลับ</button>
      </div>
      <div class="status-line" id="status-line"></div>
    </div>
    <div id="modal-backdrop" style="display:none;position:fixed;inset:0;background:rgba(10,15,20,0.55);z-index:150;align-items:center;justify-content:center;padding:16px;">
      <div style="background:#fff;border-radius:12px;padding:22px;max-width:420px;width:100%;">
        <h3 id="modal-title" style="margin:0 0 12px;">อนุมัติรายการตรวจ</h3>
        <div class="field">
          <label>ชื่อผู้ตรวจสอบ (HR)<span class="req">*</span></label>
          <input type="text" id="modal-reviewer">
        </div>
        <div class="field" id="modal-comment-box" style="display:none;">
          <label>เหตุผลที่ตีกลับ<span class="req">*</span></label>
          <textarea id="modal-comment" rows="3" placeholder="ระบุสิ่งที่ต้องแก้ไข"></textarea>
        </div>
        <div class="errmsg" id="modal-err">กรุณากรอกข้อมูลให้ครบ</div>
        <div style="display:flex;gap:10px;margin-top:14px;">
          <button type="button" class="btn btn-ghost" id="modal-cancel" style="flex:1;">ยกเลิก</button>
          <button type="button" class="btn" id="modal-confirm" style="flex:1;">ยืนยัน</button>
        </div>
      </div>
    </div>`
    : ""

  const body = `
    <div class="top-nav"><a href="/hr">← แดชบอร์ด HR</a></div>
    <div class="card">
      <h1 style="margin:0 0 4px;">${esc(insp.branch)} ${statusBadge(insp.status)}</h1>
      <p class="sub">รอบตรวจที่ ${insp.cycle}</p>
      <table>
        <tr><td style="width:160px;color:#64748b;">ผู้ตรวจ</td><td>${esc(insp.inspector_name)} (${esc(insp.position === "อื่นๆ" ? insp.position_other : insp.position)})</td></tr>
        <tr><td style="color:#64748b;">วันที่ตรวจ</td><td>${fmtDateTH(insp.inspect_date)}</td></tr>
        <tr><td style="color:#64748b;">ส่งเมื่อ</td><td>${fmtDateTimeTH(insp.submitted_at)}</td></tr>
        ${insp.hr_reviewer ? `<tr><td style="color:#64748b;">ผู้ตรวจสอบล่าสุด</td><td>${esc(insp.hr_reviewer)} (${fmtDateTimeTH(insp.hr_reviewed_at)})</td></tr>` : ""}
      </table>
      <div class="stat-grid" style="margin-top:14px;">
        <div class="stat-box"><div class="num">${insp.score ?? "-"}/${CHECKLIST_TOTAL}</div><div class="label">คะแนนผ่าน</div></div>
        <div class="stat-box"><div class="num">${insp.percent ?? "-"}%</div><div class="label">เปอร์เซ็นต์</div></div>
        <div class="stat-box"><div class="num">${insp.overall_result === "pass" ? "ผ่าน" : insp.overall_result === "fail" ? "ไม่ผ่าน" : "-"}</div><div class="label">ผลรวม (อ้างอิง)</div></div>
      </div>
    </div>
    ${insp.hr_comment ? `<div class="reject-banner"><b>เหตุผลตีกลับล่าสุด (โดย ${esc(insp.hr_reviewer)})</b><p style="margin:6px 0 0;">${esc(insp.hr_comment)}</p></div>` : ""}
    <div class="card">
      <h2>รายการตรวจทั้ง ${CHECKLIST_TOTAL} ข้อ</h2>
      ${checklistHtml}
    </div>
    ${actionsHtml}
    <div class="card">
      <h2>ประวัติการดำเนินการ</h2>
      ${historyHtml}
    </div>
  `

  const scripts = insp.status === "pending" ? `
(function() {
  function $(id) { return document.getElementById(id); }
  var mode = null;
  function openModal(m) {
    mode = m;
    $('modal-title').textContent = m === 'approve' ? 'อนุมัติรายการตรวจ' : 'ตีกลับรายการตรวจ';
    $('modal-comment-box').style.display = m === 'reject' ? 'block' : 'none';
    $('modal-err').classList.remove('show');
    $('modal-backdrop').style.display = 'flex';
  }
  $('approve-btn').addEventListener('click', function() { openModal('approve'); });
  $('reject-btn').addEventListener('click', function() { openModal('reject'); });
  $('modal-cancel').addEventListener('click', function() { $('modal-backdrop').style.display = 'none'; });
  $('modal-confirm').addEventListener('click', async function() {
    var reviewer = $('modal-reviewer').value.trim();
    var comment = $('modal-comment').value.trim();
    if (!reviewer || (mode === 'reject' && !comment)) { $('modal-err').classList.add('show'); return; }
    $('modal-confirm').disabled = true;
    try {
      var res = await fetch('/hr/${insp.id}/' + mode, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewer: reviewer, comment: comment })
      });
      var data = await res.json();
      if (!res.ok) { $('modal-err').textContent = 'เกิดข้อผิดพลาด: ' + (data.error || ''); $('modal-err').classList.add('show'); $('modal-confirm').disabled = false; return; }
      $('modal-backdrop').style.display = 'none';
      $('status-line').className = 'status-line ok';
      $('status-line').textContent = (mode === 'approve' ? 'อนุมัติ' : 'ตีกลับ') + 'เรียบร้อยแล้ว ✅ กำลังโหลดหน้าใหม่...';
      setTimeout(function() { window.location.reload(); }, 1000);
    } catch (e) {
      $('modal-err').textContent = 'เกิดข้อผิดพลาด กรุณาลองใหม่'; $('modal-err').classList.add('show'); $('modal-confirm').disabled = false;
    }
  });
})();` : ""

  return c.html(renderPage({ title: `รายละเอียดการตรวจ — ${insp.branch}`, body, scripts, wide: true }))
})

app.post("/:id/approve", async (c) => {
  const id = parseInt(c.req.param("id"), 10)
  const body = await c.req.json().catch(() => null)
  const reviewer = String(body?.reviewer || "").trim()
  if (!reviewer) return c.json({ error: "reviewer_required" }, 400)
  try {
    await approve(id, reviewer)
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
  try {
    await reject(id, reviewer, comment)
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

export default app
