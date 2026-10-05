import { Hono } from "hono"
import { renderPage, esc, statusBadge } from "../ui/layout"
import { CHECKLIST_ITEMS, CATEGORY_LABELS, CHECKLIST_TOTAL, POSITIONS, BRANCHES, GROUP_PHOTO_SLOTS } from "../lib/checklist"
import { getByToken, listFiltered, listForExport, parseJsonbArray, openRevisionIds, purgeEmptyDrafts, dateOnly, planDueState, inspectionCode, PASS_THRESHOLD_PERCENT } from "../lib/inspections"
import { planDueBadge } from "../ui/layout"
import { listPhotoKinds } from "../lib/photos"
import { fmtDateTH, fmtDateTimeTH } from "../lib/format"
import { filtersFromQuery, filterBarHtml, paginationHtml, xlsxResponse, reportHtml, LIST_STYLES } from "../lib/report"

const app = new Hono()

app.get("/", async (c) => {
  // Self-heal the empty drafts left over from the old "create on open"
  // behaviour (htask-1791116230138 #9) — cheap, and only touches drafts
  // that have no name, branch, checked item or photo.
  await purgeEmptyDrafts().catch(() => 0)
  const f = filtersFromQuery((k) => c.req.query(k))
  const { rows, total, page, pages } = await listFiltered(f, f.page)
  const rowsHtml = rows.length
    ? rows.map((r: any) => `
        <tr class="clickable" onclick="window.location='/inspect/${r.public_token}'">
          <td><b>${inspectionCode(r.id)}</b></td>
          <td>${esc(r.branch) || "-"}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${esc(r.inspector_name) || "-"}<br><span style="color:#94a3b8;font-size:11.5px;">${esc(r.position === "อื่นๆ" ? r.position_other : r.position)}</span></td>
          <td>${fmtDateTH(r.inspect_date)}</td>
          <td>${r.score != null ? `${r.score}/${CHECKLIST_TOTAL}` : "-"}</td>
          <td>${r.overall_result === "pass" ? '<span class="badge approved">ผ่าน</span>' : r.overall_result === "fail" ? '<span class="badge rejected">ไม่ผ่าน</span>' : "-"}</td>
          <td>${r.percent != null ? `${r.percent}%` : "-"}</td>
          <td>${r.status === "draft" ? `<button type="button" class="btn btn-danger btn-xs" onclick="event.stopPropagation();deleteDraft('${esc(r.public_token)}',this)">ลบฉบับร่าง</button>` : ""}</td>
        </tr>`).join("")
    : `<tr><td colspan="9" style="text-align:center;color:#94a3b8;">ไม่พบรายการตรวจ</td></tr>`

  const body = `
    <div class="top-nav">
      <h1 style="margin:0;">รายการตรวจ Grooming</h1>
      <a href="/hr">🔒 สำหรับฝ่าย HR →</a>
    </div>
    <a class="btn" href="/inspect/new" style="display:block;margin-bottom:16px;">+ สร้างรายการตรวจใหม่</a>
    ${filterBarHtml("/inspect", f)}
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>รหัสการตรวจ</th><th>สาขา</th><th>สถานะ</th><th>ผู้ตรวจ</th><th>วันที่ตรวจ</th><th>คะแนน</th><th>ผลรวม</th><th>%</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      ${paginationHtml("/inspect", f, page, pages, total)}
    </div>`
  const scripts = `
    async function deleteDraft(token, btn) {
      if (!confirm('ลบฉบับร่างนี้?')) return;
      btn.disabled = true;
      var res = await fetch('/api/inspect/' + token + '/delete', { method: 'POST' });
      if (res.ok) window.location.reload(); else { btn.disabled = false; alert('ลบไม่สำเร็จ'); }
    }`
  return c.html(renderPage({ title: "รายการตรวจ Grooming", body, scripts, styles: LIST_STYLES, wide: true }))
})

app.get("/export.xlsx", async (c) => {
  const f = filtersFromQuery((k) => c.req.query(k))
  return xlsxResponse(await listForExport(f), "grooming-inspections")
})

app.get("/report", async (c) => {
  const f = filtersFromQuery((k) => c.req.query(k))
  return c.html(reportHtml("รายงานรายการตรวจ Grooming", await listForExport(f), f))
})

function optionsHtml(list: string[], selected: string): string {
  return list.map((v) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(v)}</option>`).join("")
}

// "New" just renders an empty form — the draft row is created on the first
// autosave/photo (POST /api/inspect/create), so merely opening this page no
// longer leaves an empty draft behind (htask-1791116230138 #9).
app.get("/new", async (c) => c.html(renderForm(null, { before: new Set(), after: new Set() })))

app.get("/:token", async (c) => {
  const insp = await getByToken(c.req.param("token"))
  if (!insp) return c.text("ไม่พบรายการตรวจ หรือลิงก์ไม่ถูกต้อง", 404)
  return c.html(renderForm(insp, await listPhotoKinds(insp.id)))
})

function renderForm(insp: any | null, photos: { before: Set<string>; after: Set<string> }): string {
  const isNew = !insp
  const token = insp?.public_token ?? null
  const status = insp?.status ?? "draft"
  const items = parseJsonbArray<any>(insp?.items)
  const itemsById = new Map(items.map((i) => [i.itemId, i]))
  const openRev = status === "rejected" ? openRevisionIds(items) : []
  // Revision mode (htask-1791116230138 #7): the inspector sees which items
  // HR flagged and why, and can change ONLY those — header and every other
  // item are read-only (the server enforces the same).
  const revisionMode = openRev.length > 0
  const editable = status === "draft" || status === "rejected"
  const headerEditable = editable && !revisionMode
  const photoUrl = (itemId: string, kind: string) => `/api/inspect/${token}/photo/${itemId}?kind=${kind}`

  const rejectBanner = status === "rejected"
    ? revisionMode
      ? `<div class="reject-banner"><b>HR (${esc(insp.hr_reviewer)}) ขอให้แก้ไข ${openRev.length} ข้อ</b>
          <p style="margin:6px 0 0;">แก้ไขได้เฉพาะข้อที่ไฮไลต์สีส้มด้านล่าง — แต่ละข้อต้องระบุการแก้ไข (Corrective action) และแนบรูปหลังแก้ไข (After) แล้วกดส่งกลับ</p>
          ${insp.hr_comment ? `<p style="margin:6px 0 0;">หมายเหตุเพิ่มเติม: ${esc(insp.hr_comment)}</p>` : ""}</div>`
      : insp.hr_comment ? `<div class="reject-banner"><b>ถูกตีกลับโดย ${esc(insp.hr_reviewer)}</b><p style="margin:6px 0 0;">${esc(insp.hr_comment)}</p></div>` : ""
    : ""

  const categoryOrder = ["uniform", "personal", "card"]
  const checklistHtml = categoryOrder.map((cat) => {
    const defs = CHECKLIST_ITEMS.filter((i) => i.category === cat)
    const itemsHtml = defs.map((def) => {
      const cur = itemsById.get(def.itemId)
      const result = cur?.result ?? null
      const note = cur?.note ?? ""
      const isRev = openRev.includes(def.itemId)
      const itemEditable = editable && (!revisionMode || isRev)
      const hasBefore = photos.before.has(def.itemId)
      const hasAfter = photos.after.has(def.itemId)
      const doneClass = result === "pass" ? " done-pass" : result === "fail" ? " done-fail" : ""
      const lockedTag = revisionMode && !isRev ? `<span class="item-tag ok">✔ HR ยืนยันแล้ว</span>` : cur?.confirmed && status !== "draft" ? `<span class="item-tag ok">✔ HR ยืนยันแล้ว</span>` : ""
      const revBox = isRev ? `
        <div class="rev-box">
          <div class="rev-title">HR ขอให้แก้ไข (Request revision) — รอบที่ ${cur.revision.cycle}</div>
          <div class="rev-comment">${esc(cur.revision.comment)}</div>
          <div class="rev-by">โดย ${esc(cur.revision.by)} · ${fmtDateTimeTH(cur.revision.at)}</div>
        </div>` : ""
      const beforePhoto = `
        <div class="photo-box" style="display:${result || hasBefore ? "block" : "none"};margin-top:8px;">
          <div class="mini-label photo-label">${result === "fail" ? 'รูปสภาพที่ไม่ผ่าน (ใช้เป็นรูป Before)<span class="req">*</span>' : 'รูปประกอบ (ไม่บังคับ)'}</div>
          <div class="photo-row">
            ${itemEditable && !revisionMode ? `<label class="btn btn-ghost btn-sm">📷 ${hasBefore ? "ถ่ายใหม่" : "ถ่ายรูป"}<input type="file" accept="image/*" capture="environment" class="photo-input" data-kind="before" style="display:none;"></label>` : ""}
            <img class="photo-thumb before-thumb" src="${hasBefore ? photoUrl(def.itemId, "before") : ""}" style="display:${hasBefore ? "block" : "none"};" onclick="openLightbox(this.src)">
            <span class="photo-status" style="font-size:12px;color:#94a3b8;">${revisionMode ? (hasBefore ? "รูปก่อนแก้ไข (Before)" : "ไม่มีรูปก่อนแก้ไข") : hasBefore ? "แนบรูปแล้ว" : "ยังไม่มีรูป"}</span>
          </div>
          <div class="errmsg photo-err">ข้อที่ไม่ผ่านต้องแนบรูปสภาพที่ไม่ผ่าน</div>
        </div>`
      const afterBox = isRev ? `
        <div class="after-box">
          <div class="field" style="margin:0 0 8px;">
            <label>การแก้ไขที่ทำ (Corrective action)<span class="req">*</span></label>
            <textarea class="corrective-input" rows="2" placeholder="อธิบายสิ่งที่แก้ไขแล้ว" ${itemEditable ? "" : "disabled"}>${esc(cur?.corrective?.note ?? "")}</textarea>
            <div class="errmsg corrective-err">กรุณาระบุการแก้ไข</div>
          </div>
          <div class="photo-row">
            <label class="btn btn-sm">📷 ${hasAfter ? "ถ่ายรูปหลังแก้ไขใหม่" : "ถ่ายรูปหลังแก้ไข (After)"}<input type="file" accept="image/*" capture="environment" class="photo-input" data-kind="after" style="display:none;"></label>
            <img class="photo-thumb after-thumb" src="${hasAfter ? photoUrl(def.itemId, "after") : ""}" style="display:${hasAfter ? "block" : "none"};" onclick="openLightbox(this.src)">
            <span class="photo-status-after" style="font-size:12px;color:#94a3b8;">${hasAfter ? "แนบรูปหลังแก้ไขแล้ว" : "ยังไม่มีรูปหลังแก้ไข"}</span>
          </div>
          <div class="errmsg after-err">กรุณาแนบรูปหลังแก้ไข (After)</div>
        </div>` : hasAfter ? `
        <div class="ba-compare">
          <div><div class="ba-label">ก่อน (Before)</div>${hasBefore ? `<img class="photo-thumb" src="${photoUrl(def.itemId, "before")}" onclick="openLightbox(this.src)">` : `<span class="sub">ไม่มีรูป</span>`}</div>
          <div><div class="ba-label">หลัง (After)</div><img class="photo-thumb" src="${photoUrl(def.itemId, "after")}" onclick="openLightbox(this.src)"></div>
          ${cur?.corrective?.note ? `<div class="ba-note">Corrective action: ${esc(cur.corrective.note)}</div>` : ""}
        </div>` : ""
      return `
      <div class="check-item${doneClass}${isRev ? " rev-item" : ""}${revisionMode && !isRev ? " locked-item" : ""}" data-item="${def.itemId}" data-rev="${isRev ? 1 : 0}">
        <div class="check-item-label">${esc(def.label)} ${lockedTag}</div>
        ${revBox}
        <div class="check-opts">
          <button type="button" class="check-opt-btn pass${result === "pass" ? " active" : ""}" data-result="pass" ${itemEditable ? "" : "disabled"}>✅ ผ่าน</button>
          <button type="button" class="check-opt-btn fail${result === "fail" ? " active" : ""}" data-result="fail" ${itemEditable ? "" : "disabled"}>❌ ไม่ผ่าน</button>
        </div>
        <div class="note-box" style="display:${result === "fail" ? "block" : "none"};margin-top:8px;">
          <label class="mini-label">หมายเหตุ (สิ่งที่ไม่ผ่าน)<span class="req">*</span></label>
          <textarea class="note-input" rows="2" placeholder="ระบุหมายเหตุ (บังคับ)" ${itemEditable ? "" : "disabled"}>${esc(note)}</textarea>
          <div class="errmsg note-err">กรุณาระบุหมายเหตุ</div>
          <label class="mini-label" style="margin-top:8px;">วิธีแก้ไข<span class="req">*</span></label>
          <textarea class="fix-input" rows="2" placeholder="ระบุวิธีแก้ไข (บังคับ)" ${itemEditable ? "" : "disabled"}>${esc(cur?.fix ?? "")}</textarea>
          <div class="errmsg fix-err">กรุณาระบุวิธีแก้ไข</div>
        </div>
        ${beforePhoto}
        ${afterBox}
      </div>`
    }).join("")
    return `<div class="checklist-cat">${esc(CATEGORY_LABELS[cat]!)}</div>${itemsHtml}`
  }).join("")

  const dis = headerEditable ? "" : "disabled"
  const inspectDate = insp ? dateOnly(insp.inspect_date) : new Date().toISOString().slice(0, 10)
  const body = `
    <div class="top-nav"><a href="/inspect">← รายการตรวจทั้งหมด</a>${!isNew && status === "draft" ? `<button type="button" class="btn btn-danger btn-sm" id="delete-draft-btn">ลบฉบับร่างนี้</button>` : ""}</div>
    ${rejectBanner}
    <div class="card">
      <h1 style="margin:0 0 4px;">แบบตรวจ Grooming ${isNew ? '<span class="badge draft">ใหม่ (ยังไม่บันทึก)</span>' : statusBadge(status)}</h1>
      <p class="sub">${isNew ? "ระบบจะบันทึกฉบับร่างให้อัตโนมัติเมื่อเริ่มกรอกข้อมูล" : `รหัสการตรวจ <b>${inspectionCode(insp.id)}</b> · รอบตรวจที่ ${insp.cycle}`}</p>

      <div class="field"><label>ชื่อผู้ตรวจ<span class="req">*</span></label><input type="text" id="f-name" value="${esc(insp?.inspector_name ?? "")}" ${dis}></div>
      <div class="field"><label>อีเมลผู้ตรวจ <span style="font-weight:400;color:#6b7a7a;">(ไม่บังคับ — สำหรับรับแจ้งเตือนเมื่อ HR ขอให้แก้ไข/อนุมัติ)</span></label><input type="text" inputmode="email" id="f-email" value="${esc(insp?.inspector_email ?? "")}" placeholder="name@uficon.com" ${dis}><div class="errmsg" id="email-err">รูปแบบอีเมลไม่ถูกต้อง</div></div>
      <div class="field">
        <label>ตำแหน่ง<span class="req">*</span></label>
        <select id="f-position" ${dis}>
          <option value="">-- เลือกตำแหน่ง --</option>
          ${optionsHtml(POSITIONS, insp?.position ?? "")}
          <option value="อื่นๆ" ${insp?.position === "อื่นๆ" ? "selected" : ""}>อื่นๆ (ระบุ)</option>
        </select>
      </div>
      <div class="field" id="f-position-other-box" style="display:${insp?.position === "อื่นๆ" ? "block" : "none"};"><label>ระบุตำแหน่ง<span class="req">*</span></label><input type="text" id="f-position-other" value="${esc(insp?.position_other ?? "")}" ${dis}></div>
      <div class="field"><label>สาขา<span class="req">*</span></label><select id="f-branch" ${dis}><option value="">-- เลือกสาขา --</option>${optionsHtml(BRANCHES, insp?.branch ?? "")}</select></div>
      <div class="field"><label>วันที่ตรวจ<span class="req">*</span></label><input type="date" id="f-date" value="${inspectDate}" ${dis}></div>
    </div>

    <div class="card">
      <h2>รายการตรวจ Grooming (${CHECKLIST_TOTAL} ข้อ)</h2>
      <div class="progress-bar-wrap"><div class="progress-bar-fill" id="progress-fill" style="width:0%;"></div></div>
      <p class="sub" style="margin-bottom:16px;">ตรวจแล้ว <b id="progress-count">0</b> / ${CHECKLIST_TOTAL} ข้อ · ผ่าน <b id="pass-count">0</b> · ไม่ผ่าน <b id="fail-count">0</b> · <b id="percent-count">0</b>% <span id="overall-badge"></span> <span style="color:#94a3b8;">(เกณฑ์: ผ่าน ≥ ${PASS_THRESHOLD_PERCENT}%)</span></p>
      ${checklistHtml}
    </div>

    <div class="card">
      <h2>ง. แนบรูปรวมที่ตรวจวันนี้ <span style="font-weight:400;font-size:13px;color:#6b7a7a;">สูงสุด ${GROUP_PHOTO_SLOTS.length} รูป · ไม่บังคับ</span></h2>
      <div class="group-grid">
        ${GROUP_PHOTO_SLOTS.map((slot, i) => {
          const has = photos.before.has(slot)
          const canEdit = editable && !revisionMode
          return `<div class="group-slot" data-slot="${slot}">
            <img class="group-img" src="${has ? photoUrl(slot, "before") : ""}" style="display:${has ? "block" : "none"};" onclick="openLightbox(this.src)">
            <div class="group-empty" style="display:${has ? "none" : "flex"};">รูปที่ ${i + 1}</div>
            ${canEdit ? `<div class="group-actions"><label class="btn btn-ghost btn-xs">📷 ${has ? "เปลี่ยน" : "เพิ่มรูป"}<input type="file" accept="image/*" class="group-input" style="display:none;"></label><button type="button" class="btn btn-danger btn-xs group-del" style="display:${has ? "inline-block" : "none"};">ลบ</button></div>` : ""}
          </div>`
        }).join("")}
      </div>
    </div>

    <div class="card plan-card">
      <h2>แผนการแก้ไข (ถ้ามี) <span style="font-weight:400;font-size:13px;color:#6b7a7a;">ไม่บังคับกรอก</span> ${insp ? planDueBadge(planDueState(insp)) : ""}</h2>
      <div class="field"><label>ปัญหาที่พบ</label><textarea id="f-plan-problem" rows="2" ${editable ? "" : "disabled"}>${esc(insp?.plan_problem ?? "")}</textarea></div>
      <div class="field"><label>แนวทางแก้ไข (ข้อความสั้น)</label><input type="text" id="f-plan-solution" maxlength="300" value="${esc(insp?.plan_solution ?? "")}" ${editable ? "" : "disabled"}></div>
      <div class="field" style="max-width:260px;"><label>กำหนดเสร็จ (Due Date)</label><input type="date" id="f-plan-due" value="${insp?.plan_due_date ? dateOnly(insp.plan_due_date) : ""}" ${editable ? "" : "disabled"}></div>
    </div>

    ${editable ? `
    <button type="button" class="btn" id="submit-btn" style="width:100%;" disabled>${revisionMode ? "ส่งการแก้ไขกลับให้ HR (Corrective action submitted)" : "ส่งให้ HR ตรวจสอบ"}</button>
    <p class="errmsg" id="submit-hint" style="text-align:center;margin-top:8px;">${revisionMode ? "กรุณาระบุการแก้ไขและแนบรูปหลังแก้ไขให้ครบทุกข้อที่ถูกขอแก้" : "กรุณากรอกข้อมูลและตรวจให้ครบทุกข้อก่อนส่ง"}</p>
    ` : ""}
    <div class="status-line" id="status-line" style="text-align:center;"></div>
  `

  const scripts = `
(function() {
  var TOKEN = ${JSON.stringify(token)};
  var EDITABLE = ${editable};
  var REVISION_MODE = ${revisionMode};
  var CHECKLIST_TOTAL = ${CHECKLIST_TOTAL};
  var PASS_THRESHOLD = ${PASS_THRESHOLD_PERCENT};
  function $(id) { return document.getElementById(id); }
  var EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

  function collectState() {
    var items = Array.prototype.map.call(document.querySelectorAll('.check-item'), function(el) {
      var activeBtn = el.querySelector('.check-opt-btn.active');
      var noteInput = el.querySelector('.note-input');
      var corr = el.querySelector('.corrective-input');
      var fixInput = el.querySelector('.fix-input');
      return { itemId: el.getAttribute('data-item'), result: activeBtn ? activeBtn.getAttribute('data-result') : null, note: noteInput ? noteInput.value : '', fix: fixInput ? fixInput.value : '', correctiveNote: corr ? corr.value : '' };
    });
    return {
      inspectorName: $('f-name').value.trim(),
      inspectorEmail: $('f-email').value.trim(),
      position: $('f-position').value,
      positionOther: $('f-position').value === 'อื่นๆ' ? $('f-position-other').value.trim() : null,
      branch: $('f-branch').value,
      inspectDate: $('f-date').value,
      planProblem: $('f-plan-problem').value.trim(),
      planSolution: $('f-plan-solution').value.trim(),
      planDueDate: $('f-plan-due').value,
      items: items,
    };
  }

  // Draft row is created lazily on the first real change (no empty drafts).
  var creating = null;
  function ensureToken() {
    if (TOKEN) return Promise.resolve(TOKEN);
    if (creating) return creating;
    creating = fetch('/api/inspect/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign(collectState(), { force: true })) })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.token) throw new Error(d.error || 'create_failed');
        TOKEN = d.token;
        history.replaceState(null, '', '/inspect/' + TOKEN);
        return TOKEN;
      });
    creating.catch(function() { creating = null; });
    return creating;
  }

  function updateProgress() {
    var done = 0, pass = 0, fail = 0;
    document.querySelectorAll('.check-item').forEach(function(el) {
      var a = el.querySelector('.check-opt-btn.active');
      if (a) { done++; if (a.getAttribute('data-result') === 'pass') pass++; else fail++; }
    });
    $('progress-count').textContent = done; $('pass-count').textContent = pass; $('fail-count').textContent = fail;
    var percent = Math.round(pass / CHECKLIST_TOTAL * 100);
    $('percent-count').textContent = percent;
    $('overall-badge').innerHTML = done === CHECKLIST_TOTAL ? (percent >= PASS_THRESHOLD ? '<span class="badge approved">ผ่าน</span>' : '<span class="badge rejected">ไม่ผ่าน</span>') : '';
    $('progress-fill').style.width = (done / CHECKLIST_TOTAL * 100) + '%';
  }

  function visible(img) { return img && img.style.display !== 'none' && img.getAttribute('src'); }
  function itemValid(el) {
    var a = el.querySelector('.check-opt-btn.active');
    if (!a) return false;
    var result = a.getAttribute('data-result');
    if (result === 'fail' && (!el.querySelector('.note-input').value.trim() || !el.querySelector('.fix-input').value.trim())) return false;
    // Only failed items need a photo (photo of the failing condition) —
    // passed items don't (README, htask-1791123159751).
    if (result === 'fail' && !visible(el.querySelector('.before-thumb')) && !visible(el.querySelector('.after-thumb'))) return false;
    if (el.getAttribute('data-rev') === '1') {
      if (!el.querySelector('.corrective-input').value.trim()) return false;
      if (!visible(el.querySelector('.after-thumb'))) return false;
    }
    return true;
  }
  function emailOk() { var v = $('f-email').value.trim(); return !v || EMAIL_RE.test(v); }

  function updateSubmitState() {
    if (!EDITABLE) return;
    var allValid = Array.prototype.every.call(document.querySelectorAll('.check-item'), itemValid);
    var headerOk = $('f-name').value.trim() && $('f-branch').value && $('f-date').value && $('f-position').value &&
      ($('f-position').value !== 'อื่นๆ' || $('f-position-other').value.trim()) && emailOk();
    var ok = allValid && headerOk;
    $('submit-btn').disabled = !ok;
    $('submit-hint').classList.toggle('show', !ok);
    $('email-err').classList.toggle('show', !emailOk());
  }

  function checkItemErrors(el) {
    var a = el.querySelector('.check-opt-btn.active');
    var result = a ? a.getAttribute('data-result') : null;
    var noteErr = el.querySelector('.note-err'), photoErr = el.querySelector('.photo-err');
    if (noteErr) noteErr.classList.toggle('show', result === 'fail' && !el.querySelector('.note-input').value.trim());
    var fixErr = el.querySelector('.fix-err');
    if (fixErr) fixErr.classList.toggle('show', result === 'fail' && !el.querySelector('.fix-input').value.trim());
    if (photoErr) photoErr.classList.toggle('show', result === 'fail' && !REVISION_MODE && !visible(el.querySelector('.before-thumb')) && !visible(el.querySelector('.after-thumb')));
    var pl = el.querySelector('.photo-label');
    if (pl) pl.innerHTML = result === 'fail' ? 'รูปสภาพที่ไม่ผ่าน (ใช้เป็นรูป Before)<span class="req">*</span>' : 'รูปประกอบ (ไม่บังคับ)';
    if (el.getAttribute('data-rev') === '1') {
      el.querySelector('.corrective-err').classList.toggle('show', !el.querySelector('.corrective-input').value.trim());
      el.querySelector('.after-err').classList.toggle('show', !visible(el.querySelector('.after-thumb')));
    }
  }

  var saveTimer = null;
  function scheduleAutosave() {
    if (!EDITABLE) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function() {
      var st = collectState();
      if (!TOKEN && !st.inspectorName && !st.branch && !st.position && !st.planProblem && !st.planSolution && !st.items.some(function(i) { return i.result || i.note; })) return;
      ensureToken().then(function(t) {
        return fetch('/api/inspect/' + t + '/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectState()) });
      }).then(function(res) { if (res && res.ok) $('status-line').textContent = 'บันทึกร่างอัตโนมัติแล้ว'; }).catch(function() {});
    }, 700);
  }

  if (EDITABLE) {
    document.querySelectorAll('.check-item').forEach(function(el) {
      el.querySelectorAll('.check-opt-btn').forEach(function(btn) {
        if (btn.disabled) return;
        btn.addEventListener('click', function() {
          var result = btn.getAttribute('data-result');
          el.querySelectorAll('.check-opt-btn').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          el.classList.remove('done-pass', 'done-fail');
          el.classList.add(result === 'pass' ? 'done-pass' : 'done-fail');
          el.querySelector('.note-box').style.display = result === 'fail' ? 'block' : 'none';
          var pb = el.querySelector('.photo-box');
          if (pb && !REVISION_MODE) pb.style.display = 'block';
          checkItemErrors(el); updateProgress(); updateSubmitState(); scheduleAutosave();
        });
      });
      ['.note-input', '.fix-input', '.corrective-input'].forEach(function(sel) {
        var inp = el.querySelector(sel);
        if (inp && !inp.disabled) inp.addEventListener('input', function() { checkItemErrors(el); updateSubmitState(); scheduleAutosave(); });
      });
      el.querySelectorAll('.photo-input').forEach(function(photoInput) {
        photoInput.addEventListener('change', function() {
          var file = photoInput.files[0];
          if (!file) return;
          var itemId = el.getAttribute('data-item');
          var kind = photoInput.getAttribute('data-kind') || 'before';
          $('status-line').textContent = 'กำลังบีบอัดรูป...';
          var blobP = compressImage(file, 1280, 0.8);
          Promise.all([blobP, ensureToken()]).then(function(v) {
            $('status-line').textContent = 'กำลังอัปโหลดรูป...';
            var fd = new FormData();
            fd.append('photo', v[0], itemId + '-' + kind + '.jpg');
            return fetch('/api/inspect/' + v[1] + '/photo/' + itemId + '?kind=' + kind, { method: 'POST', body: fd });
          }).then(function(res) { return res.json(); }).then(function(data) {
            if (data.ok) {
              var thumb = el.querySelector(kind === 'after' ? '.after-thumb' : '.before-thumb');
              thumb.src = '/api/inspect/' + TOKEN + '/photo/' + itemId + '?kind=' + kind + '&t=' + Date.now();
              thumb.style.display = 'block';
              var st = el.querySelector(kind === 'after' ? '.photo-status-after' : '.photo-status');
              if (st) st.textContent = kind === 'after' ? 'แนบรูปหลังแก้ไขแล้ว' : 'แนบรูปแล้ว';
              checkItemErrors(el); updateSubmitState(); scheduleAutosave();
              $('status-line').textContent = 'แนบรูปเรียบร้อยแล้ว';
            } else {
              $('status-line').textContent = 'เกิดข้อผิดพลาด: ' + (data.error || '');
            }
          }).catch(function() { $('status-line').textContent = 'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่'; });
          photoInput.value = '';
        });
      });
    });

    ['f-name', 'f-email', 'f-branch', 'f-date', 'f-plan-problem', 'f-plan-solution', 'f-plan-due'].forEach(function(id) {
      var e = $(id); if (!e || e.disabled) return;
      e.addEventListener('input', function() { updateSubmitState(); scheduleAutosave(); });
      e.addEventListener('change', function() { updateSubmitState(); scheduleAutosave(); });
    });
    if (!$('f-position').disabled) $('f-position').addEventListener('change', function() {
      $('f-position-other-box').style.display = $('f-position').value === 'อื่นๆ' ? 'block' : 'none';
      updateSubmitState(); scheduleAutosave();
    });
    var posOther = $('f-position-other'); if (posOther && !posOther.disabled) posOther.addEventListener('input', function() { updateSubmitState(); scheduleAutosave(); });

    // "ง. แนบรูปรวมที่ตรวจวันนี้" — up to 5 optional overall photos.
    document.querySelectorAll('.group-slot').forEach(function(slotEl) {
      var slot = slotEl.getAttribute('data-slot');
      var input = slotEl.querySelector('.group-input');
      var img = slotEl.querySelector('.group-img'), empty = slotEl.querySelector('.group-empty'), del = slotEl.querySelector('.group-del');
      if (input) input.addEventListener('change', function() {
        var file = input.files[0]; if (!file) return;
        $('status-line').textContent = 'กำลังอัปโหลดรูปรวม...';
        Promise.all([compressImage(file, 1280, 0.8), ensureToken()]).then(function(v) {
          var fd = new FormData(); fd.append('photo', v[0], slot + '.jpg');
          return fetch('/api/inspect/' + v[1] + '/photo/' + slot + '?kind=before', { method: 'POST', body: fd });
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (!d.ok) { $('status-line').textContent = 'เกิดข้อผิดพลาด: ' + (d.error || ''); return; }
          img.src = '/api/inspect/' + TOKEN + '/photo/' + slot + '?kind=before&t=' + Date.now();
          img.style.display = 'block'; empty.style.display = 'none'; if (del) del.style.display = 'inline-block';
          $('status-line').textContent = 'แนบรูปรวมแล้ว';
        }).catch(function() { $('status-line').textContent = 'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่'; });
        input.value = '';
      });
      if (del) del.addEventListener('click', function() {
        if (!TOKEN || !confirm('ลบรูปนี้?')) return;
        fetch('/api/inspect/' + TOKEN + '/photo/' + slot + '/delete', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.ok) { img.style.display = 'none'; img.src = ''; empty.style.display = 'flex'; del.style.display = 'none'; }
        });
      });
    });


    $('submit-btn').addEventListener('click', async function() {
      $('submit-btn').disabled = true;
      $('status-line').className = 'status-line';
      $('status-line').textContent = 'กำลังส่งเรื่อง...';
      try {
        var t = await ensureToken();
        var res = await fetch('/api/inspect/' + t + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectState()) });
        var data = await res.json();
        if (!res.ok) { $('status-line').className = 'status-line err'; $('status-line').textContent = 'ส่งไม่ได้: ' + (data.message || data.error || ''); updateSubmitState(); return; }
        $('status-line').className = 'status-line ok';
        $('status-line').textContent = 'ส่งเรื่องเรียบร้อยแล้ว ✅ กำลังโหลดหน้าใหม่...';
        setTimeout(function() { window.location.href = '/inspect/' + t; }, 1000);
      } catch (e) {
        $('status-line').className = 'status-line err';
        $('status-line').textContent = 'เกิดข้อผิดพลาด กรุณาลองใหม่';
        updateSubmitState();
      }
    });
  }

  var del = $('delete-draft-btn');
  if (del) del.addEventListener('click', async function() {
    if (!confirm('ลบฉบับร่างนี้?')) return;
    var res = await fetch('/api/inspect/' + TOKEN + '/delete', { method: 'POST' });
    if (res.ok) window.location.href = '/inspect'; else alert('ลบไม่สำเร็จ');
  });

  updateProgress();
  updateSubmitState();
})();

function compressImage(file, maxWidth, quality) {
  return new Promise(function(resolve, reject) {
    var img = new Image();
    var reader = new FileReader();
    reader.onload = function(e) {
      img.onload = function() {
        var scale = Math.min(1, maxWidth / img.width);
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(function(blob) { blob ? resolve(blob) : reject(new Error('compress failed')); }, 'image/jpeg', quality);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
`
  return renderPage({ title: "แบบตรวจ Grooming", body, scripts, wide: true })
}

export default app
