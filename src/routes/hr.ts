import { Hono } from "hono"
import { renderPage, esc, statusBadge, planDueBadge } from "../ui/layout"
import { CHECKLIST_ITEMS, CATEGORY_LABELS, CHECKLIST_TOTAL, GROUP_PHOTO_SLOTS } from "../lib/checklist"
import { countByStatus, getById, reviewAudit, hrDeleteAudit, parseJsonbArray, listFiltered, listForExport, planDueState, countPlanDue, inspectionCode, PASS_THRESHOLD_PERCENT, PASS_RULE_LABEL } from "../lib/inspections"
import { listPhotoKinds } from "../lib/photos"
import { fmtDateTH, fmtDateTimeTH } from "../lib/format"
import { filtersFromQuery, filterBarHtml, paginationHtml, queryString, xlsxResponse, reportHtml, LIST_STYLES, buildSummary, summaryBodyHtml, summaryPrintHtml, summaryXlsx, SUMMARY_STYLES } from "../lib/report"
import { BRANCHES } from "../lib/checklist"
import { notifyInspectorReviewed } from "../lib/notify"
import { requireHr, isHr, checkHrPassword, setHrCookie, clearHrCookie, safeNext } from "../lib/hr-auth"

const app = new Hono()

// ---- HR login (htask-1791178152734) — must stay ABOVE the requireHr gate ----
app.get("/login", async (c) => {
  if (await isHr(c)) return c.redirect(safeNext(c.req.query("next")))
  const err = c.req.query("err")
  const nextPath = safeNext(c.req.query("next"))
  const body = `
    <div class="card" style="max-width:420px;margin:40px auto;">
      <h1 style="margin:0 0 4px;">สำหรับผู้บังคับบัญชาตามสายงาน</h1>
      <p class="sub">กรุณาใส่รหัสผ่านเพื่อเข้าสู่แดชบอร์ดผู้บังคับบัญชาตามสายงาน</p>
      ${err ? `<div class="reject-banner" style="margin-bottom:12px;">${err === "nopw" ? "ยังไม่ได้ตั้งรหัสผ่านผู้บังคับบัญชาในระบบ กรุณาติดต่อผู้ดูแลระบบ" : "รหัสผ่านไม่ถูกต้อง"}</div>` : ""}
      <form method="post" action="/hr/login">
        <input type="hidden" name="next" value="${esc(nextPath)}">
        <div class="field"><label>รหัสผ่าน<span class="req">*</span></label><input type="password" name="password" required autofocus autocomplete="current-password" style="width:100%;padding:10px 11px;border:1.5px solid var(--border);border-radius:8px;font-size:15px;"></div>
        <button type="submit" class="btn" style="width:100%;">เข้าสู่ระบบ</button>
      </form>
      <p style="margin:14px 0 0;text-align:center;"><a href="/inspect" style="color:var(--brand);font-size:13.5px;">← กลับหน้าผู้ตรวจ</a></p>
    </div>`
  return c.html(renderPage({ title: "เข้าสู่ระบบผู้บังคับบัญชา — Grooming Check", body }))
})

app.post("/login", async (c) => {
  const form = await c.req.formData().catch(() => null)
  const pw = String(form?.get("password") ?? "")
  const nextPath = safeNext(String(form?.get("next") ?? ""))
  if (!process.env.HR_PASSWORD) return c.redirect(`/hr/login?err=nopw&next=${encodeURIComponent(nextPath)}`)
  if (!checkHrPassword(pw)) {
    await new Promise((r) => setTimeout(r, 600)) // slow down guessing
    return c.redirect(`/hr/login?err=1&next=${encodeURIComponent(nextPath)}`)
  }
  await setHrCookie(c)
  return c.redirect(nextPath)
})

app.get("/logout", (c) => {
  clearHrCookie(c)
  return c.redirect("/hr/login")
})

// Everything below requires the HR password.
app.use("*", requireHr)


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
  const due = await countPlanDue()
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
        <tr class="clickable${planDueState(r) === "overdue" ? " due-overdue" : planDueState(r) === "soon" ? " due-soon" : ""}" onclick="window.location='/hr/${r.id}'">
          <td><b>${inspectionCode(r.id)}</b></td>
          <td>${esc(r.branch)}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${esc(r.inspector_name)}</td>
          <td>${fmtDateTH(r.inspect_date)}</td>
          <td>${r.score != null ? `${r.score}/${CHECKLIST_TOTAL} (${r.percent}%)` : "-"}</td>
          <td>${r.overall_result === "pass" ? '<span class="badge approved">ผ่าน</span>' : r.overall_result === "fail" ? '<span class="badge rejected">ไม่ผ่าน</span>' : "-"}</td>
          <td>${r.cycle}</td>
          <td>${fmtDateTimeTH(r.submitted_at)}</td>
          <td>${r.plan_due_date ? `${fmtDateTH(r.plan_due_date)} ${planDueBadge(planDueState(r))}` : "-"}</td>
          <td><button type="button" class="btn btn-danger btn-xs" onclick="event.stopPropagation();openDelete(${r.id}, ${esc(JSON.stringify(deleteLabel(r)))})">ลบ</button></td>
        </tr>`).join("")
    : `<tr><td colspan="11" style="text-align:center;color:#94a3b8;">ไม่พบรายการ</td></tr>`

  const body = `
    <div class="top-nav">
      <h1 style="margin:0;">แดชบอร์ดผู้บังคับบัญชาตามสายงาน — ตรวจ Grooming</h1>
      <span style="display:flex;gap:12px;flex-wrap:wrap;"><a href="/hr/summary">รายงานสรุปผลตรวจ →</a><a href="/inspect">← กลับหน้าผู้ตรวจ</a><a href="/hr/logout">ออกจากระบบ</a></span>
    </div>
    <div class="stat-grid">
      <div class="stat-box"><div class="num">${counts.pending}</div><div class="label">รอตรวจสอบ</div></div>
      <div class="stat-box"><div class="num">${counts.rejected}</div><div class="label">รอผู้ตรวจแก้ไข</div></div>
      <div class="stat-box"><div class="num">${counts.approved}</div><div class="label">อนุมัติแล้ว</div></div>
      <div class="stat-box"${due.overdue ? ' style="border-color:#f0a8a8;background:#fdf5f5;"' : ""}><div class="num" style="color:${due.overdue ? "#c22b2b" : "inherit"};">${due.overdue}</div><div class="label">แผนแก้ไขเกินกำหนด</div></div>
      <div class="stat-box"${due.soon ? ' style="border-color:#f5c98a;background:#fffaf2;"' : ""}><div class="num" style="color:${due.soon ? "#b45309" : "inherit"};">${due.soon}</div><div class="label">ใกล้ครบกำหนด (≤ 3 วัน)</div></div>
    </div>
    ${deletedBanner(c.req.query("deleted"))}
    <div class="tabs">${tabsHtml}</div>
    ${filterBarHtml("/hr", f, { keepStatus: true })}
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>รหัสการตรวจ</th><th>สาขา</th><th>สถานะ</th><th>ผู้ตรวจ</th><th>วันที่ตรวจ</th><th>คะแนน</th><th>ผลรวม</th><th>รอบ</th><th>ส่งเมื่อ</th><th>กำหนดเสร็จแผนแก้ไข</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      ${paginationHtml("/hr", f, page, pages, total)}
    </div>
    ${DELETE_MODAL_HTML}`
  return c.html(renderPage({ title: "แดชบอร์ดผู้บังคับบัญชา — Grooming Check", body, styles: LIST_STYLES + DELETE_MODAL_STYLES, scripts: DELETE_MODAL_SCRIPT, wide: true }))
})

app.get("/export.xlsx", async (c) => {
  const f = filtersFromQuery((k) => c.req.query(k))
  return xlsxResponse(await listForExport({ ...f, excludeDrafts: true }), "grooming-supervisor")
})

app.get("/report", async (c) => {
  const f = filtersFromQuery((k) => c.req.query(k))
  return c.html(reportHtml("รายงานการตรวจ Grooming (ผู้บังคับบัญชา)", await listForExport({ ...f, excludeDrafts: true }), f))
})

// Summary report (htask-1791121739323 #15.3) — on screen + PDF (print) + Excel.
async function summaryFor(c: any) {
  const f = filtersFromQuery((k) => c.req.query(k))
  const d = buildSummary(await listForExport({ branch: f.branch, from: f.from, to: f.to, excludeDrafts: true }))
  return { f, d }
}

app.get("/summary", async (c) => {
  const { f, d } = await summaryFor(c)
  const qs = queryString({ branch: f.branch, from: f.from, to: f.to })
  const branchOpts = BRANCHES.map((b) => `<option value="${esc(b)}"${b === f.branch ? " selected" : ""}>${esc(b)}</option>`).join("")
  const body = `
    <div class="top-nav"><h1 style="margin:0;">รายงานสรุปผลตรวจเครื่องแต่งกายพนักงานหน้าร้าน</h1><a href="/hr">← แดชบอร์ดผู้บังคับบัญชา</a></div>
    <form class="filter-bar" method="get" action="/hr/summary">
      <div class="fb-field"><label>สาขา</label><select name="branch"><option value="">ทุกสาขา</option>${branchOpts}</select></div>
      <div class="fb-field"><label>ตั้งแต่วันที่</label><input type="date" name="from" value="${esc(f.from ?? "")}"></div>
      <div class="fb-field"><label>ถึงวันที่</label><input type="date" name="to" value="${esc(f.to ?? "")}"></div>
      <div class="fb-actions">
        <button type="submit" class="btn">ดูรายงาน</button>
        <a class="btn btn-ghost" href="/hr/summary">ล้าง</a>
        <a class="btn btn-ghost" href="/hr/summary/export.xlsx${qs}">Excel</a>
        <a class="btn btn-ghost" href="/hr/summary/print${qs}" target="_blank" rel="noopener">PDF</a>
      </div>
    </form>
    <div class="card">${summaryBodyHtml(d)}</div>`
  return c.html(renderPage({ title: "รายงานสรุปผลตรวจ Grooming", body, styles: LIST_STYLES + SUMMARY_STYLES, wide: true }))
})

app.get("/summary/export.xlsx", async (c) => {
  const { f, d } = await summaryFor(c)
  return new Response(summaryXlsx(d, f), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="grooming-summary-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  })
})

app.get("/summary/print", async (c) => {
  const { f, d } = await summaryFor(c)
  return c.html(summaryPrintHtml(d, f))
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
        ${cur?.fix ? `<p class="fix-line">วิธีแก้ไข: ${esc(cur.fix)}</p>` : ""}
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
      <div class="field"><label>ชื่อผู้ตรวจสอบ (ผู้บังคับบัญชาตามสายงาน)<span class="req">*</span></label><input type="text" id="reviewer"></div>
      <div class="field"><label>หมายเหตุถึงผู้ตรวจ (ไม่บังคับ)</label><textarea id="overall-comment" rows="2"></textarea></div>
      <p id="review-summary" class="sub" style="margin:0 0 10px;"></p>
      <button type="button" class="btn" id="confirm-btn" style="width:100%;">Confirm Entire Audit ID</button>
      <div class="errmsg" id="review-err"></div>
      <div class="status-line" id="status-line"></div>
    </div>` : ""

  const body = `
    <div class="top-nav"><a href="/hr">← แดชบอร์ดผู้บังคับบัญชา</a><button type="button" class="btn btn-danger btn-xs" onclick="openDelete(${insp.id}, ${esc(JSON.stringify(deleteLabel(insp)))})">ลบเอกสารนี้</button></div>
    <div class="card">
      <h1 style="margin:0 0 4px;">${esc(insp.branch)} ${statusBadge(insp.status)}</h1>
      <p class="sub">รหัสการตรวจ (Audit ID) <b>${inspectionCode(insp.id)}</b> · รอบตรวจที่ ${insp.cycle}</p>
      <table>
        <tr><td style="width:160px;color:#64748b;">ผู้ตรวจ</td><td>${esc(insp.inspector_name)} (${esc(insp.position === "อื่นๆ" ? insp.position_other : insp.position)})${insp.inspector_email ? ` · ${esc(insp.inspector_email)}` : ""}</td></tr>
        <tr><td style="color:#64748b;">วันที่ตรวจ</td><td>${fmtDateTH(insp.inspect_date)}</td></tr>
        <tr><td style="color:#64748b;">ส่งเมื่อ</td><td>${fmtDateTimeTH(insp.submitted_at)}</td></tr>
        ${insp.hr_reviewer ? `<tr><td style="color:#64748b;">ผู้ตรวจสอบล่าสุด</td><td>${esc(insp.hr_reviewer)} (${fmtDateTimeTH(insp.hr_reviewed_at)})</td></tr>` : ""}
      </table>
      <div class="stat-grid" style="margin-top:14px;">
        <div class="stat-box"><div class="num">${insp.score ?? "-"}/${CHECKLIST_TOTAL}</div><div class="label">คะแนนผ่าน</div></div>
        <div class="stat-box"><div class="num">${insp.percent ?? "-"}%</div><div class="label">เปอร์เซ็นต์</div></div>
        <div class="stat-box"><div class="num">${insp.overall_result === "pass" ? "ผ่าน" : insp.overall_result === "fail" ? "ไม่ผ่าน" : "-"}</div><div class="label">ผลรวม (เกณฑ์: ${PASS_RULE_LABEL})</div></div>
      </div>
    </div>
    ${insp.hr_comment ? `<div class="reject-banner"><b>หมายเหตุล่าสุดจากผู้บังคับบัญชา (${esc(insp.hr_reviewer)})</b><p style="margin:6px 0 0;">${esc(insp.hr_comment)}</p></div>` : ""}
    <div class="card">
      <h2>รายการตรวจทั้ง ${CHECKLIST_TOTAL} ข้อ ${reviewing ? `<span class="sub" style="font-weight:400;">· รอยืนยัน ${openCount} ข้อ</span>` : ""}</h2>
      ${checklistHtml}
    </div>
    <div class="card">
      <h2>ง. รูปรวมที่ตรวจวันนี้</h2>
      ${GROUP_PHOTO_SLOTS.some((s) => photos.before.has(s))
        ? `<div class="group-grid">${GROUP_PHOTO_SLOTS.filter((s) => photos.before.has(s)).map((s) => `<div class="group-slot"><img class="group-img" src="${photoUrl(s, "before")}" onclick="openLightbox(this.src)"></div>`).join("")}</div>`
        : `<p class="sub" style="margin:0;">ไม่ได้แนบรูปรวม</p>`}
    </div>
    <div class="card plan-card">
      <h2>แผนการแก้ไข ${planDueBadge(planDueState(insp))}</h2>
      ${insp.plan_problem || insp.plan_solution || insp.plan_due_date ? `<table>
        <tr><td style="width:160px;color:#64748b;">ปัญหาที่พบ</td><td style="white-space:pre-wrap;">${esc(insp.plan_problem || "-")}</td></tr>
        <tr><td style="color:#64748b;">แนวทางแก้ไข</td><td style="white-space:normal;">${esc(insp.plan_solution || "-")}</td></tr>
        <tr><td style="color:#64748b;">กำหนดเสร็จ</td><td>${insp.plan_due_date ? fmtDateTH(insp.plan_due_date) : "-"}</td></tr>
      </table>` : `<p class="sub" style="margin:0;">ผู้ตรวจไม่ได้ระบุแผนการแก้ไข</p>`}
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
    if (!reviewer) { err.textContent = 'กรุณากรอกชื่อผู้ตรวจสอบ (ผู้บังคับบัญชาตามสายงาน)'; err.classList.add('show'); $('reviewer').focus(); return; }
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

  return c.html(renderPage({ title: `รายละเอียดการตรวจ — ${insp.branch}`, body: body + DELETE_MODAL_HTML, styles: DELETE_MODAL_STYLES, scripts: scripts + DELETE_MODAL_SCRIPT, wide: true }))
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

// ---- HR-only delete (Preeyapan, htask-1791426505254) ----
// Behind requireHr like everything else here (no HR cookie -> 401). Every
// delete goes through the confirmation dialog, and the server also insists
// on confirm=true + the name of the HR person deleting.
app.post("/:id/delete", async (c) => {
  const id = parseInt(c.req.param("id"), 10)
  if (isNaN(id)) return c.json({ error: "not_found" }, 404)
  const body = await c.req.json().catch(() => null)
  if (body?.confirm !== true) return c.json({ error: "confirm_required" }, 400)
  const by = String(body?.by || "").trim().slice(0, 100)
  if (!by) return c.json({ error: "name_required" }, 400)
  const reason = String(body?.reason || "").trim().slice(0, 500) || null
  const done = await hrDeleteAudit(id, by, reason)
  if (!done) return c.json({ error: "not_found" }, 404)
  console.log(`[hr] deleted ${done.code} (${done.branch}) by ${by}${reason ? ` — ${reason}` : ""}`)
  return c.json({ ok: true, code: done.code })
})

function deleteLabel(r: any): string {
  return `${inspectionCode(r.id)} · ${r.branch || "-"} · ${fmtDateTH(r.inspect_date)} · ผู้ตรวจ ${r.inspector_name || "-"}`
}

function deletedBanner(code: string | undefined): string {
  if (!code || !/^GC-\d+$/.test(code)) return ""
  return `<div class="deleted-banner">ลบเอกสาร <b>${esc(code)}</b> แล้ว</div>`
}

const DELETE_MODAL_STYLES = `
  .deleted-banner { background:#fdf2f2; border:1px solid #f0b4b4; color:#9b1c1c; border-radius:10px; padding:10px 14px; margin-bottom:12px; font-weight:600; }
  .dm-bg { position:fixed; inset:0; background:rgba(15,23,23,.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px; }
  .dm-bg[hidden] { display:none; }
  .dm { background:#fff; border-radius:14px; max-width:460px; width:100%; padding:20px; box-shadow:0 20px 50px rgba(0,0,0,.25); }
  .dm h3 { margin:0 0 6px; color:var(--fail); font-size:19px; }
  .dm .dm-doc { background:#fdf5f5; border:1px solid #f0c4c4; border-radius:10px; padding:10px 12px; margin:10px 0 12px; font-weight:600; font-size:14px; }
  .dm .dm-warn { color:#6b7a7a; font-size:13.5px; margin:0 0 12px; }
  .dm label { display:block; font-weight:600; font-size:14px; margin:8px 0 4px; }
  .dm input { width:100%; padding:9px 11px; border:1px solid var(--border); border-radius:8px; font:inherit; }
  .dm .dm-err { color:var(--fail); font-size:13px; min-height:18px; margin-top:6px; }
  .dm .dm-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:10px; }
  .dm .dm-actions .btn-cancel { background:#eef2f2; color:var(--text); }
`

const DELETE_MODAL_HTML = `
<div class="dm-bg" id="dm" hidden>
  <div class="dm" role="dialog" aria-modal="true" aria-labelledby="dm-title">
    <h3 id="dm-title">ยืนยันการลบเอกสาร</h3>
    <div class="dm-doc" id="dm-doc"></div>
    <p class="dm-warn">เอกสารนี้จะหายจากทุกหน้า (ผู้ตรวจ, ผู้บังคับบัญชา, รายงาน, Excel) — ระบบเก็บประวัติไว้ว่าใครลบและเพราะอะไร</p>
    <label for="dm-by">ชื่อผู้ลบ (ผู้บังคับบัญชา)<span style="color:var(--fail);">*</span></label>
    <input id="dm-by" type="text" autocomplete="name">
    <label for="dm-reason">เหตุผล (ไม่บังคับ)</label>
    <input id="dm-reason" type="text" placeholder="เช่น ส่งซ้ำ / กรอกผิดสาขา">
    <div class="dm-err" id="dm-err"></div>
    <div class="dm-actions">
      <button type="button" class="btn btn-cancel" id="dm-cancel">ยกเลิก</button>
      <button type="button" class="btn btn-danger" id="dm-ok">ยืนยันลบ</button>
    </div>
  </div>
</div>`

const DELETE_MODAL_SCRIPT = `
(function(){
  var dm = document.getElementById('dm'), cur = null;
  function close(){ dm.hidden = true; cur = null; }
  window.openDelete = function(id, label){
    cur = id;
    document.getElementById('dm-doc').textContent = label;
    document.getElementById('dm-err').textContent = '';
    document.getElementById('dm-reason').value = '';
    var by = document.getElementById('dm-by');
    try { by.value = localStorage.getItem('gc_hr_name') || ''; } catch (e) {}
    dm.hidden = false;
    (by.value ? document.getElementById('dm-reason') : by).focus();
  };
  document.getElementById('dm-cancel').addEventListener('click', close);
  dm.addEventListener('click', function(e){ if (e.target === dm) close(); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && !dm.hidden) close(); });
  document.getElementById('dm-ok').addEventListener('click', async function(){
    var by = document.getElementById('dm-by').value.trim(), err = document.getElementById('dm-err'), btn = this;
    if (!by) { err.textContent = 'กรุณากรอกชื่อผู้ลบ'; document.getElementById('dm-by').focus(); return; }
    try { localStorage.setItem('gc_hr_name', by); } catch (e) {}
    btn.disabled = true; err.textContent = '';
    try {
      var res = await fetch('/hr/' + cur + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, by: by, reason: document.getElementById('dm-reason').value.trim() }) });
      var data = await res.json().catch(function(){ return {}; });
      if (!res.ok) { err.textContent = res.status === 401 ? 'หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' : 'ลบไม่สำเร็จ: ' + (data.error || res.status); btn.disabled = false; return; }
      window.location = '/hr?status=all&deleted=' + encodeURIComponent(data.code);
    } catch (e) { err.textContent = 'เชื่อมต่อไม่ได้ กรุณาลองใหม่'; btn.disabled = false; }
  });
})();`

export default app
