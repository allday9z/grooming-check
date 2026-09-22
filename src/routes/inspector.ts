import { Hono } from "hono"
import { renderPage, esc, statusBadge } from "../ui/layout"
import { CHECKLIST_ITEMS, CATEGORY_LABELS, CHECKLIST_TOTAL, POSITIONS, BRANCHES } from "../lib/checklist"
import { createDraft, getByToken, listAll, parseJsonbArray } from "../lib/inspections"
import { listPhotoItemIds } from "../lib/photos"

const app = new Hono()

function fmtDateTH(d: any): string {
  if (!d) return "-"
  const v = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
  const [y, m, day] = v.split("-")
  return `${day}/${m}/${y}`
}

app.get("/", async (c) => {
  const rows = await listAll()
  const rowsHtml = rows.length
    ? rows.map((r: any) => {
        const clickable = r.status === "draft" || r.status === "rejected" ? `/inspect/${r.public_token}` : `/inspect/${r.public_token}`
        return `
        <tr class="clickable" onclick="window.location='${clickable}'">
          <td>${esc(r.branch)}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${esc(r.inspector_name)}<br><span style="color:#94a3b8;font-size:11.5px;">${esc(r.position === "อื่นๆ" ? r.position_other : r.position)}</span></td>
          <td>${fmtDateTH(r.inspect_date)}</td>
          <td>${r.score != null ? `${r.score}/${CHECKLIST_TOTAL}` : "-"}</td>
          <td>${r.overall_result === "pass" ? '<span class="badge approved">ผ่าน</span>' : r.overall_result === "fail" ? '<span class="badge rejected">ไม่ผ่าน</span>' : "-"}</td>
          <td>${r.percent != null ? `${r.percent}%` : "-"}</td>
        </tr>`
      }).join("")
    : `<tr><td colspan="7" style="text-align:center;color:#94a3b8;">ยังไม่มีรายการตรวจ</td></tr>`

  const body = `
    <div class="top-nav">
      <h1 style="margin:0;">รายการตรวจ Grooming</h1>
      <a href="/hr">🔒 สำหรับฝ่าย HR</a>
    </div>
    <a class="btn" href="/inspect/new" style="display:block;margin-bottom:16px;">+ สร้างรายการตรวจใหม่</a>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>สาขา</th><th>สถานะ</th><th>ผู้ตรวจ</th><th>วันที่ตรวจ</th><th>คะแนน</th><th>ผลรวม</th><th>%</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>`
  return c.html(renderPage({ title: "รายการตรวจ Grooming", body, wide: true }))
})

app.get("/new", async (c) => {
  const { token } = await createDraft(
    { inspectorName: "", position: "", positionOther: null, branch: "", inspectDate: new Date().toISOString().slice(0, 10), items: [] },
    "ผู้ตรวจ (ยังไม่ระบุชื่อ)"
  )
  return c.redirect(`/inspect/${token}`)
})

function optionsHtml(list: string[], selected: string): string {
  return list.map((v) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(v)}</option>`).join("")
}

app.get("/:token", async (c) => {
  const token = c.req.param("token")
  const insp = await getByToken(token)
  if (!insp) return c.text("ไม่พบรายการตรวจ หรือลิงก์ไม่ถูกต้อง", 404)

  const editable = insp.status === "draft" || insp.status === "rejected"
  const photoItemIds = new Set(await listPhotoItemIds(insp.id))
  const itemsById = new Map(parseJsonbArray<any>(insp.items).map((i) => [i.itemId, i]))

  const rejectBanner = insp.status === "rejected" && insp.hr_comment
    ? `<div class="reject-banner"><b>ถูกตีกลับโดย ${esc(insp.hr_reviewer)}</b><p style="margin:6px 0 0;">${esc(insp.hr_comment)}</p></div>`
    : ""

  const categoryOrder = ["uniform", "personal", "card"]
  const checklistHtml = categoryOrder.map((cat) => {
    const items = CHECKLIST_ITEMS.filter((i) => i.category === cat)
    const itemsHtml = items.map((def) => {
      const cur = itemsById.get(def.itemId)
      const result = cur?.result ?? null
      const note = cur?.note ?? ""
      const hasPhoto = photoItemIds.has(def.itemId)
      const doneClass = result === "pass" ? " done-pass" : result === "fail" ? " done-fail" : ""
      return `
      <div class="check-item${doneClass}" data-item="${def.itemId}">
        <div class="check-item-label">${esc(def.label)}</div>
        <div class="check-opts">
          <button type="button" class="check-opt-btn pass${result === "pass" ? " active" : ""}" data-result="pass" ${editable ? "" : "disabled"}>✅ ผ่าน</button>
          <button type="button" class="check-opt-btn fail${result === "fail" ? " active" : ""}" data-result="fail" ${editable ? "" : "disabled"}>❌ ไม่ผ่าน</button>
        </div>
        <div class="note-box" style="display:${result === "fail" ? "block" : "none"};margin-top:8px;">
          <textarea class="note-input" rows="2" placeholder="ระบุหมายเหตุ (บังคับ)" ${editable ? "" : "disabled"}>${esc(note)}</textarea>
          <div class="errmsg note-err">กรุณาระบุหมายเหตุ</div>
        </div>
        <div class="photo-box" style="display:${result === "pass" ? "block" : "none"};margin-top:8px;">
          <div class="photo-row">
            ${editable ? `<label class="btn btn-ghost" style="padding:8px 14px;font-size:12.5px;cursor:pointer;">📷 ${hasPhoto ? "ถ่ายใหม่" : "ถ่ายรูป"}<input type="file" accept="image/*" capture="environment" class="photo-input" style="display:none;"></label>` : ""}
            <img class="photo-thumb" src="${hasPhoto ? `/api/inspect/${token}/photo/${def.itemId}` : ""}" style="display:${hasPhoto ? "block" : "none"};" onclick="openLightbox(this.src)">
            <span class="photo-status" style="font-size:12px;color:#94a3b8;">${hasPhoto ? "แนบรูปแล้ว" : "ยังไม่มีรูป"}</span>
          </div>
          <div class="errmsg photo-err">กรุณาแนบรูปถ่ายเป็นหลักฐาน</div>
        </div>
      </div>`
    }).join("")
    return `<div class="checklist-cat">${esc(CATEGORY_LABELS[cat]!)}</div>${itemsHtml}`
  }).join("")

  const body = `
    <div class="top-nav"><a href="/inspect">← รายการตรวจทั้งหมด</a></div>
    ${rejectBanner}
    <div class="card">
      <h1 style="margin:0 0 4px;">แบบตรวจ Grooming ${statusBadge(insp.status)}</h1>
      <p class="sub">รอบตรวจที่ ${insp.cycle}</p>

      <div class="field">
        <label>ชื่อผู้ตรวจ<span class="req">*</span></label>
        <input type="text" id="f-name" value="${esc(insp.inspector_name)}" ${editable ? "" : "disabled"}>
      </div>
      <div class="field">
        <label>ตำแหน่ง<span class="req">*</span></label>
        <select id="f-position" ${editable ? "" : "disabled"}>
          <option value="">-- เลือกตำแหน่ง --</option>
          ${optionsHtml(POSITIONS, insp.position)}
          <option value="อื่นๆ" ${insp.position === "อื่นๆ" ? "selected" : ""}>อื่นๆ (ระบุ)</option>
        </select>
      </div>
      <div class="field" id="f-position-other-box" style="display:${insp.position === "อื่นๆ" ? "block" : "none"};">
        <label>ระบุตำแหน่ง<span class="req">*</span></label>
        <input type="text" id="f-position-other" value="${esc(insp.position_other ?? "")}" ${editable ? "" : "disabled"}>
      </div>
      <div class="field">
        <label>สาขา<span class="req">*</span></label>
        <select id="f-branch" ${editable ? "" : "disabled"}>
          <option value="">-- เลือกสาขา --</option>
          ${optionsHtml(BRANCHES, insp.branch)}
        </select>
      </div>
      <div class="field">
        <label>วันที่ตรวจ<span class="req">*</span></label>
        <input type="date" id="f-date" value="${insp.inspect_date instanceof Date ? insp.inspect_date.toISOString().slice(0, 10) : String(insp.inspect_date).slice(0, 10)}" ${editable ? "" : "disabled"}>
      </div>
    </div>

    <div class="card">
      <h2>รายการตรวจ Grooming (${CHECKLIST_TOTAL} ข้อ)</h2>
      <div class="progress-bar-wrap"><div class="progress-bar-fill" id="progress-fill" style="width:0%;"></div></div>
      <p class="sub" style="margin-bottom:16px;">ตรวจแล้ว <b id="progress-count">0</b> / ${CHECKLIST_TOTAL} ข้อ · ผ่าน <b id="pass-count">0</b> · ไม่ผ่าน <b id="fail-count">0</b> · <b id="percent-count">0</b>%</p>
      ${checklistHtml}
    </div>

    ${editable ? `
    <button type="button" class="btn" id="submit-btn" style="width:100%;" disabled>ส่งให้ HR ตรวจสอบ</button>
    <p class="errmsg" id="submit-hint" style="text-align:center;margin-top:8px;">กรุณากรอกข้อมูลและตรวจให้ครบทุกข้อก่อนส่ง</p>
    ` : ""}
    <div class="status-line" id="status-line" style="text-align:center;"></div>
  `

  const scripts = `
(function() {
  var TOKEN = ${JSON.stringify(token)};
  var EDITABLE = ${editable};
  var CHECKLIST_TOTAL = ${CHECKLIST_TOTAL};
  function $(id) { return document.getElementById(id); }

  function collectState() {
    var items = Array.prototype.map.call(document.querySelectorAll('.check-item'), function(el) {
      var activeBtn = el.querySelector('.check-opt-btn.active');
      var result = activeBtn ? activeBtn.getAttribute('data-result') : null;
      var noteInput = el.querySelector('.note-input');
      return { itemId: el.getAttribute('data-item'), result: result, note: noteInput ? noteInput.value : '' };
    });
    return {
      inspectorName: $('f-name').value.trim(),
      position: $('f-position').value,
      positionOther: $('f-position').value === 'อื่นๆ' ? $('f-position-other').value.trim() : null,
      branch: $('f-branch').value,
      inspectDate: $('f-date').value,
      items: items,
    };
  }

  function updateProgress() {
    var items = document.querySelectorAll('.check-item');
    var done = 0, pass = 0, fail = 0;
    items.forEach(function(el) {
      var activeBtn = el.querySelector('.check-opt-btn.active');
      if (activeBtn) { done++; if (activeBtn.getAttribute('data-result') === 'pass') pass++; else fail++; }
    });
    $('progress-count').textContent = done;
    $('pass-count').textContent = pass;
    $('fail-count').textContent = fail;
    var percent = Math.round(pass / CHECKLIST_TOTAL * 100);
    $('percent-count').textContent = percent;
    $('progress-fill').style.width = (done / CHECKLIST_TOTAL * 100) + '%';
    return { done: done, pass: pass, fail: fail };
  }

  function itemValid(el) {
    var activeBtn = el.querySelector('.check-opt-btn.active');
    if (!activeBtn) return false;
    var result = activeBtn.getAttribute('data-result');
    if (result === 'fail') {
      var note = el.querySelector('.note-input').value.trim();
      return !!note;
    }
    if (result === 'pass') {
      var thumb = el.querySelector('.photo-thumb');
      return thumb && thumb.style.display !== 'none' && thumb.src && !thumb.src.endsWith('/');
    }
    return false;
  }

  function updateSubmitState() {
    if (!EDITABLE) return;
    var items = document.querySelectorAll('.check-item');
    var allValid = Array.prototype.every.call(items, itemValid);
    var headerOk = $('f-name').value.trim() && $('f-branch').value && $('f-date').value && $('f-position').value &&
      ($('f-position').value !== 'อื่นๆ' || $('f-position-other').value.trim());
    var ok = allValid && headerOk;
    $('submit-btn').disabled = !ok;
    $('submit-hint').classList.toggle('show', !ok);
  }

  function checkItemErrors(el) {
    var activeBtn = el.querySelector('.check-opt-btn.active');
    var result = activeBtn ? activeBtn.getAttribute('data-result') : null;
    var noteErr = el.querySelector('.note-err');
    var photoErr = el.querySelector('.photo-err');
    if (result === 'fail') {
      var note = el.querySelector('.note-input').value.trim();
      if (noteErr) noteErr.classList.toggle('show', !note);
    } else if (noteErr) noteErr.classList.remove('show');
    if (result === 'pass') {
      var thumb = el.querySelector('.photo-thumb');
      var hasPhoto = thumb && thumb.style.display !== 'none';
      if (photoErr) photoErr.classList.toggle('show', !hasPhoto);
    } else if (photoErr) photoErr.classList.remove('show');
  }

  var saveTimer = null;
  function scheduleAutosave() {
    if (!EDITABLE) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function() {
      fetch('/api/inspect/' + TOKEN + '/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectState())
      }).then(function(res) {
        if (res.ok) $('status-line').textContent = 'บันทึกร่างอัตโนมัติแล้ว';
      }).catch(function() {});
    }, 700);
  }

  if (EDITABLE) {
    document.querySelectorAll('.check-item').forEach(function(el) {
      el.querySelectorAll('.check-opt-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var result = btn.getAttribute('data-result');
          el.querySelectorAll('.check-opt-btn').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          el.classList.remove('done-pass', 'done-fail');
          el.classList.add(result === 'pass' ? 'done-pass' : 'done-fail');
          el.querySelector('.note-box').style.display = result === 'fail' ? 'block' : 'none';
          el.querySelector('.photo-box').style.display = result === 'pass' ? 'block' : 'none';
          checkItemErrors(el);
          updateProgress(); updateSubmitState(); scheduleAutosave();
        });
      });
      var noteInput = el.querySelector('.note-input');
      if (noteInput) noteInput.addEventListener('input', function() { checkItemErrors(el); updateSubmitState(); scheduleAutosave(); });

      var photoInput = el.querySelector('.photo-input');
      if (photoInput) photoInput.addEventListener('change', function() {
        var file = photoInput.files[0];
        if (!file) return;
        var itemId = el.getAttribute('data-item');
        $('status-line').textContent = 'กำลังบีบอัดรูป...';
        compressImage(file, 1280, 0.8).then(function(blob) {
          $('status-line').textContent = 'กำลังอัปโหลดรูป...';
          var fd = new FormData();
          fd.append('photo', blob, itemId + '.jpg');
          return fetch('/api/inspect/' + TOKEN + '/photo/' + itemId, { method: 'POST', body: fd });
        }).then(function(res) { return res.json(); }).then(function(data) {
          if (data.ok) {
            var thumb = el.querySelector('.photo-thumb');
            thumb.src = '/api/inspect/' + TOKEN + '/photo/' + itemId + '?t=' + Date.now();
            thumb.style.display = 'block';
            el.querySelector('.photo-status').textContent = 'แนบรูปแล้ว';
            checkItemErrors(el); updateSubmitState();
            $('status-line').textContent = 'แนบรูปเรียบร้อยแล้ว';
          } else {
            $('status-line').textContent = 'เกิดข้อผิดพลาด: ' + (data.error || '');
          }
        }).catch(function() { $('status-line').textContent = 'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่'; });
      });
    });

    ['f-name', 'f-branch', 'f-date'].forEach(function(id) { $(id).addEventListener('input', function() { updateSubmitState(); scheduleAutosave(); }); $(id).addEventListener('change', function() { updateSubmitState(); scheduleAutosave(); }); });
    $('f-position').addEventListener('change', function() {
      $('f-position-other-box').style.display = $('f-position').value === 'อื่นๆ' ? 'block' : 'none';
      updateSubmitState(); scheduleAutosave();
    });
    var posOther = $('f-position-other'); if (posOther) posOther.addEventListener('input', function() { updateSubmitState(); scheduleAutosave(); });

    $('submit-btn').addEventListener('click', async function() {
      $('submit-btn').disabled = true;
      $('status-line').className = 'status-line';
      $('status-line').textContent = 'กำลังส่งเรื่อง...';
      try {
        var res = await fetch('/api/inspect/' + TOKEN + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectState()) });
        var data = await res.json();
        if (!res.ok) { $('status-line').className = 'status-line err'; $('status-line').textContent = 'เกิดข้อผิดพลาด: ' + (data.error || ''); updateSubmitState(); return; }
        $('status-line').className = 'status-line ok';
        $('status-line').textContent = 'ส่งเรื่องเรียบร้อยแล้ว ✅ กำลังโหลดหน้าใหม่...';
        setTimeout(function() { window.location.reload(); }, 1200);
      } catch (e) {
        $('status-line').className = 'status-line err';
        $('status-line').textContent = 'เกิดข้อผิดพลาด กรุณาลองใหม่';
        updateSubmitState();
      }
    });
  }

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

  return c.html(renderPage({ title: "แบบตรวจ Grooming", body, scripts, wide: true }))
})

export default app
