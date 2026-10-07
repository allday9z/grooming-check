/**
 * Shared list tooling for the inspector list (/inspect) and the HR
 * dashboard (/hr) — htask-1791116230138 #11: branch + date-range filters,
 * free-text search, pagination, and Excel / PDF export of exactly what the
 * filters select.
 */
import * as XLSX from "xlsx"
import { BRANCHES, CHECKLIST_ITEMS, CHECKLIST_TOTAL } from "./checklist"
import { esc, STATUS_LABEL } from "../ui/layout"
import { fmtDateTH, fmtDateTimeTH } from "./format"
import { parseJsonbArray, planDueState, inspectionCode, PASS_RULE_LABEL, type ListFilters } from "./inspections"
import { CATEGORY_LABELS } from "./checklist"

export function filtersFromQuery(q: (k: string) => string | undefined): ListFilters & { page: number } {
  const page = parseInt(q("page") || "1", 10)
  return {
    status: q("status") || undefined,
    branch: q("branch") || undefined,
    from: q("from") || undefined,
    to: q("to") || undefined,
    q: q("q") || undefined,
    page: isNaN(page) ? 1 : page,
  }
}

export function queryString(f: Record<string, any>, overrides: Record<string, any> = {}): string {
  const merged = { ...f, ...overrides }
  const p = new URLSearchParams()
  for (const k of ["status", "branch", "from", "to", "q", "page"]) {
    const v = merged[k]
    if (v != null && v !== "" && !(k === "page" && Number(v) === 1)) p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ""
}

export function filterBarHtml(basePath: string, f: ListFilters, opts: { keepStatus?: boolean } = {}): string {
  const branchOpts = BRANCHES.map((b) => `<option value="${esc(b)}"${b === f.branch ? " selected" : ""}>${esc(b)}</option>`).join("")
  const exportQs = queryString(f as any)
  return `
  <form class="filter-bar" method="get" action="${basePath}">
    ${opts.keepStatus && f.status ? `<input type="hidden" name="status" value="${esc(f.status)}">` : ""}
    <div class="fb-field fb-search"><label>ค้นหา</label><input type="text" name="q" value="${esc(f.q ?? "")}" placeholder="รหัส GC-xxxxx / ชื่อผู้ตรวจ / สาขา"></div>
    <div class="fb-field"><label>สาขา</label><select name="branch"><option value="">ทุกสาขา</option>${branchOpts}</select></div>
    <div class="fb-field"><label>ตั้งแต่วันที่</label><input type="date" name="from" value="${esc(f.from ?? "")}"></div>
    <div class="fb-field"><label>ถึงวันที่</label><input type="date" name="to" value="${esc(f.to ?? "")}"></div>
    <div class="fb-actions">
      <button type="submit" class="btn">ค้นหา</button>
      <a class="btn btn-ghost" href="${basePath}${opts.keepStatus && f.status ? `?status=${encodeURIComponent(f.status)}` : ""}">ล้าง</a>
      <a class="btn btn-ghost" href="${basePath}/export.xlsx${exportQs}">Excel</a>
      <a class="btn btn-ghost" href="${basePath}/report${exportQs}" target="_blank" rel="noopener">PDF</a>
    </div>
  </form>`
}

export function paginationHtml(basePath: string, f: ListFilters, page: number, pages: number, total: number): string {
  if (pages <= 1) return `<p class="sub" style="margin:10px 0 0;">ทั้งหมด ${total} รายการ</p>`
  const link = (p: number, label: string, disabled = false, active = false) =>
    disabled ? `<span class="pg-btn disabled">${label}</span>` : `<a class="pg-btn${active ? " active" : ""}" href="${basePath}${queryString(f as any, { page: p })}">${label}</a>`
  const nums: string[] = []
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) nums.push(link(p, String(p), false, p === page))
  return `<div class="pagination">
    ${link(page - 1, "‹ ก่อนหน้า", page <= 1)}${nums.join("")}${link(page + 1, "ถัดไป ›", page >= pages)}
    <span class="sub" style="margin-left:8px;">หน้า ${page}/${pages} · ทั้งหมด ${total} รายการ</span>
  </div>`
}

function positionOf(r: any): string {
  return r.position === "อื่นๆ" ? r.position_other || "อื่นๆ" : r.position || ""
}
function resultLabel(r: any): string {
  return r.overall_result === "pass" ? "ผ่าน" : r.overall_result === "fail" ? "ไม่ผ่าน" : "-"
}

export function exportXlsx(rows: any[]): Uint8Array {
  const header = ["รหัสการตรวจ", "สาขา", "วันที่ตรวจ", "ผู้ตรวจ", "ตำแหน่ง", "สถานะ", "คะแนน", "%", "ผลรวม", "รอบ", "ส่งเมื่อ", "ผู้ตรวจสอบ (HR)",
    "แผนแก้ไข: ปัญหาที่พบ", "แผนแก้ไข: แนวทางแก้ไข", "แผนแก้ไข: กำหนดเสร็จ", "แผนแก้ไข: สถานะกำหนด", ...CHECKLIST_ITEMS.map((i) => i.label)]
  const data = rows.map((r) => {
    const items = new Map(parseJsonbArray<any>(r.items).map((i) => [i.itemId, i]))
    return [
      inspectionCode(r.id), r.branch, fmtDateTH(r.inspect_date), r.inspector_name, positionOf(r), STATUS_LABEL[r.status] || r.status,
      r.score != null ? `${r.score}/${CHECKLIST_TOTAL}` : "", r.percent ?? "", resultLabel(r), r.cycle,
      r.submitted_at ? fmtDateTimeTH(r.submitted_at) : "", r.hr_reviewer ?? "",
      r.plan_problem ?? "", r.plan_solution ?? "", r.plan_due_date ? fmtDateTH(r.plan_due_date) : "", dueLabel(planDueState(r)),
      ...CHECKLIST_ITEMS.map((def) => {
        const it = items.get(def.itemId)
        if (!it?.result) return ""
        return (it.result === "pass" ? "ผ่าน" : "ไม่ผ่าน") + (it.note ? ` — ${it.note}` : "") + (it.fix ? ` | วิธีแก้ไข: ${it.fix}` : "")
      }),
    ]
  })
  const ws = XLSX.utils.aoa_to_sheet([header, ...data])
  ws["!cols"] = header.map((h, i) => ({ wch: i < 12 ? Math.max(10, h.length + 2) : i < 16 ? 22 : 18 }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Grooming")
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array
}

export function xlsxResponse(rows: any[], name: string): Response {
  return new Response(exportXlsx(rows), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  })
}

/** Print-ready page; opens the browser print dialog so the user can "Save as PDF". */
export function reportHtml(title: string, rows: any[], f: ListFilters): string {
  const filt = [f.status && f.status !== "all" ? `สถานะ: ${STATUS_LABEL[f.status] || f.status}` : "", f.branch ? `สาขา: ${f.branch}` : "", f.from ? `ตั้งแต่ ${fmtDateTH(f.from)}` : "", f.to ? `ถึง ${fmtDateTH(f.to)}` : "", f.q ? `ค้นหา: ${f.q}` : ""].filter(Boolean).join(" · ") || "ทุกรายการ"
  const body = rows.map((r) => `<tr><td>${inspectionCode(r.id)}</td><td>${esc(r.branch)}</td><td>${fmtDateTH(r.inspect_date)}</td><td>${esc(r.inspector_name)}<br><small>${esc(positionOf(r))}</small></td><td>${esc(STATUS_LABEL[r.status] || r.status)}</td><td>${r.score != null ? `${r.score}/${CHECKLIST_TOTAL} (${r.percent}%)` : "-"}</td><td>${resultLabel(r)}</td><td>${r.submitted_at ? fmtDateTimeTH(r.submitted_at) : "-"}</td><td>${r.plan_due_date ? `${fmtDateTH(r.plan_due_date)}${planDueState(r) === "overdue" ? " ⚠ เกินกำหนด" : planDueState(r) === "soon" ? " ⏰ ใกล้กำหนด" : ""}<br><small>${esc(r.plan_solution ?? "")}</small>` : "-"}</td></tr>`).join("")
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap');
  body { font-family: "Sarabun", sans-serif; color: #1f2d2d; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; color: #074a50; } p { margin: 0 0 12px; font-size: 13px; color: #6b7a7a; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; } th, td { border: 1px solid #cfd8d8; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #eef4f4; } small { color: #6b7a7a; }
  @media print { body { margin: 10mm; } .noprint { display: none; } }
</style></head><body>
<div class="noprint" style="margin-bottom:12px;"><button onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button></div>
<h1>${esc(title)}</h1><p>${esc(filt)} · ${rows.length} รายการ · ออกรายงานเมื่อ ${fmtDateTimeTH(new Date())}</p>
<table><thead><tr><th>รหัส</th><th>สาขา</th><th>วันที่ตรวจ</th><th>ผู้ตรวจ</th><th>สถานะ</th><th>คะแนน</th><th>ผลรวม</th><th>ส่งเมื่อ</th><th>แผนแก้ไข (กำหนดเสร็จ)</th></tr></thead><tbody>${body || `<tr><td colspan="9">ไม่พบรายการ</td></tr>`}</tbody></table>
<script>window.addEventListener('load', function() { setTimeout(function() { window.print(); }, 400); });</script>
</body></html>`
}

export const LIST_STYLES = `
  .filter-bar { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; background:#fff; border:1px solid var(--border); border-radius:12px; padding:12px 14px; margin-bottom:14px; }
  .fb-field { display:flex; flex-direction:column; gap:4px; min-width:140px; flex:1 1 140px; }
  .fb-search { flex:2 1 220px; }
  .fb-field label { font-size:12px; font-weight:600; color: var(--muted); }
  .fb-field input, .fb-field select { padding:8px 10px; border:1.5px solid var(--border); border-radius:8px; font-size:14px; font-family:inherit; background:#fff; }
  .fb-actions { display:flex; gap:6px; flex-wrap:wrap; }
  .fb-actions .btn { padding:9px 14px; font-size:13.5px; }
  .pagination { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:12px; }
  .pg-btn { padding:6px 11px; border-radius:7px; border:1px solid var(--border); background:#fff; color: var(--brand); text-decoration:none; font-size:13px; font-weight:600; }
  .pg-btn.active { background: var(--brand); color:#fff; border-color: var(--brand); }
  .pg-btn.disabled { color:#b8c4c4; }
`

export function dueLabel(st: "overdue" | "soon" | "ok" | null): string {
  return st === "overdue" ? "เกินกำหนด" : st === "soon" ? "ใกล้ครบกำหนด" : st === "ok" ? "ตามกำหนด" : ""
}

// ---------------------------------------------------------------------------
// Summary report (htask-1791121739323 #15.3) — "รายงานสรุปผลตรวจเครื่องแต่งกาย
// พนักงานหน้าร้าน": overview, per-branch, per-item fail rate, corrective plans.
// Built from submitted audits only (drafts excluded) within the filters.

export interface SummaryData {
  total: number
  passed: number
  failed: number
  avgPercent: number
  byStatus: Record<string, number>
  branches: { branch: string; audits: number; passed: number; failed: number; avgPercent: number; lastDate: string; planOverdue: number }[]
  items: { itemId: string; category: string; label: string; checked: number; pass: number; fail: number; failRate: number }[]
  plans: { branch: string; date: string; inspector: string; problem: string; solution: string; due: string; dueState: string; status: string }[]
}

export function buildSummary(rows: any[]): SummaryData {
  const scored = rows.filter((r) => r.percent != null)
  // Count by the result stored when each audit was submitted, so the summary
  // always matches the ผ่าน/ไม่ผ่าน badge shown on that audit.
  const passed = scored.filter((r) => r.overall_result === "pass").length
  const byStatus: Record<string, number> = {}
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  const br = new Map<string, any>()
  for (const r of rows) {
    const b = br.get(r.branch) ?? { branch: r.branch, audits: 0, passed: 0, failed: 0, sum: 0, n: 0, lastDate: "", planOverdue: 0 }
    b.audits++
    if (r.percent != null) {
      b.n++
      b.sum += r.percent
      if (r.overall_result === "pass") b.passed++
      else b.failed++
    }
    const d = String(r.inspect_date instanceof Date ? r.inspect_date.toISOString() : r.inspect_date).slice(0, 10)
    if (d > b.lastDate) b.lastDate = d
    if (planDueState(r) === "overdue") b.planOverdue++
    br.set(r.branch, b)
  }
  const itemStats = CHECKLIST_ITEMS.map((def) => ({ itemId: def.itemId, category: def.category, label: def.label, checked: 0, pass: 0, fail: 0, failRate: 0 }))
  const idx = new Map(itemStats.map((s, i) => [s.itemId, i]))
  for (const r of rows) {
    for (const it of parseJsonbArray<any>(r.items)) {
      const s = itemStats[idx.get(it.itemId) ?? -1]
      if (!s || !it.result) continue
      s.checked++
      if (it.result === "pass") s.pass++
      else s.fail++
    }
  }
  for (const s of itemStats) s.failRate = s.checked ? Math.round((s.fail / s.checked) * 100) : 0
  const plans = rows
    .filter((r) => r.plan_problem || r.plan_solution || r.plan_due_date)
    .map((r) => ({
      branch: r.branch, date: fmtDateTH(r.inspect_date), inspector: r.inspector_name, problem: r.plan_problem ?? "", solution: r.plan_solution ?? "",
      due: r.plan_due_date ? fmtDateTH(r.plan_due_date) : "", dueState: dueLabel(planDueState(r)), status: STATUS_LABEL[r.status] || r.status,
    }))
  return {
    total: rows.length,
    passed,
    failed: scored.length - passed,
    avgPercent: scored.length ? Math.round(scored.reduce((a, r) => a + r.percent, 0) / scored.length) : 0,
    byStatus,
    branches: [...br.values()]
      .map((b) => ({ branch: b.branch, audits: b.audits, passed: b.passed, failed: b.failed, avgPercent: b.n ? Math.round(b.sum / b.n) : 0, lastDate: b.lastDate, planOverdue: b.planOverdue }))
      .sort((a, b) => a.branch.localeCompare(b.branch)),
    items: itemStats,
    plans,
  }
}

export function summaryFilterLine(f: ListFilters): string {
  return [f.branch ? `สาขา: ${f.branch}` : "ทุกสาขา", f.from ? `ตั้งแต่ ${fmtDateTH(f.from)}` : "", f.to ? `ถึง ${fmtDateTH(f.to)}` : ""].filter(Boolean).join(" · ")
}

export function summaryBodyHtml(d: SummaryData): string {
  const pct = (n: number) => `${n}%`
  return `
  <div class="sum-grid">
    <div class="sum-box"><div class="n">${d.total}</div><div class="l">รายการตรวจ (ส่งแล้ว)</div></div>
    <div class="sum-box"><div class="n" style="color:#1a7f3c;">${d.passed}</div><div class="l">ผ่าน (${PASS_RULE_LABEL})</div></div>
    <div class="sum-box"><div class="n" style="color:#c22b2b;">${d.failed}</div><div class="l">ไม่ผ่าน</div></div>
    <div class="sum-box"><div class="n">${pct(d.avgPercent)}</div><div class="l">คะแนนเฉลี่ย</div></div>
    <div class="sum-box"><div class="n">${d.byStatus.approved ?? 0} / ${d.byStatus.pending ?? 0} / ${d.byStatus.rejected ?? 0}</div><div class="l">อนุมัติ / รอตรวจ / รอแก้ไข</div></div>
  </div>
  <h3>สรุปรายสาขา</h3>
  <div class="table-wrap"><table class="sum-table"><thead><tr><th>สาขา</th><th>จำนวนตรวจ</th><th>ผ่าน</th><th>ไม่ผ่าน</th><th>คะแนนเฉลี่ย</th><th>ตรวจล่าสุด</th><th>แผนแก้ไขเกินกำหนด</th></tr></thead><tbody>
  ${d.branches.map((b) => `<tr><td>${esc(b.branch)}</td><td>${b.audits}</td><td>${b.passed}</td><td>${b.failed}</td><td>${pct(b.avgPercent)}</td><td>${fmtDateTH(b.lastDate)}</td><td>${b.planOverdue || "-"}</td></tr>`).join("") || `<tr><td colspan="7">ไม่พบข้อมูล</td></tr>`}
  </tbody></table></div>
  <h3>สรุปรายหัวข้อการตรวจ</h3>
  <div class="table-wrap"><table class="sum-table"><thead><tr><th>หมวด</th><th>หัวข้อ</th><th>ตรวจ</th><th>ผ่าน</th><th>ไม่ผ่าน</th><th>% ไม่ผ่าน</th></tr></thead><tbody>
  ${d.items.map((i) => `<tr${i.failRate >= 20 ? ' class="hot"' : ""}><td>${esc(CATEGORY_LABELS[i.category] ?? i.category)}</td><td class="wrap">${esc(i.label)}</td><td>${i.checked}</td><td>${i.pass}</td><td>${i.fail}</td><td>${pct(i.failRate)}</td></tr>`).join("")}
  </tbody></table></div>
  <h3>แผนการแก้ไข</h3>
  <div class="table-wrap"><table class="sum-table"><thead><tr><th>สาขา</th><th>วันที่ตรวจ</th><th>ผู้ตรวจ</th><th>ปัญหาที่พบ</th><th>แนวทางแก้ไข</th><th>กำหนดเสร็จ</th><th>สถานะกำหนด</th></tr></thead><tbody>
  ${d.plans.map((p) => `<tr${p.dueState === "เกินกำหนด" ? ' class="hot"' : ""}><td>${esc(p.branch)}</td><td>${p.date}</td><td>${esc(p.inspector)}</td><td class="wrap">${esc(p.problem)}</td><td class="wrap">${esc(p.solution)}</td><td>${p.due || "-"}</td><td>${esc(p.dueState) || "-"}</td></tr>`).join("") || `<tr><td colspan="7">ไม่มีแผนการแก้ไข</td></tr>`}
  </tbody></table></div>`
}

export const SUMMARY_STYLES = `
  .sum-grid { display:flex; gap:10px; flex-wrap:wrap; margin:6px 0 14px; }
  .sum-box { flex:1 1 140px; border:1px solid #cfd8d8; border-radius:10px; padding:10px 12px; background:#fff; }
  .sum-box .n { font-size:22px; font-weight:700; color:#074a50; }
  .sum-box .l { font-size:12px; color:#6b7a7a; }
  .sum-table { width:100%; border-collapse:collapse; font-size:12.5px; }
  .sum-table th, .sum-table td { border:1px solid #cfd8d8; padding:6px 8px; text-align:left; vertical-align:top; }
  .sum-table th { background:#eef4f4; }
  .sum-table td.wrap { white-space:normal; min-width:160px; }
  .sum-table tr.hot td { background:#fdf1f1; }
  h3 { font-size:15px; color:#074a50; margin:18px 0 8px; }
`

export function summaryPrintHtml(d: SummaryData, f: ListFilters): string {
  return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>รายงานสรุปผลตรวจเครื่องแต่งกายพนักงานหน้าร้าน</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap');
body { font-family:"Sarabun",sans-serif; color:#1f2d2d; margin:24px; } h1 { font-size:18px; margin:0 0 4px; color:#074a50; } p.meta { margin:0 0 10px; font-size:13px; color:#6b7a7a; }
${SUMMARY_STYLES}
@media print { body { margin:10mm; } .noprint { display:none; } h3 { break-after: avoid; } tr { break-inside: avoid; } }</style></head><body>
<div class="noprint" style="margin-bottom:12px;"><button onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button></div>
<h1>รายงานสรุปผลตรวจเครื่องแต่งกายพนักงานหน้าร้าน (Grooming Check)</h1>
<p class="meta">${esc(summaryFilterLine(f))} · ออกรายงานเมื่อ ${fmtDateTimeTH(new Date())}</p>
${summaryBodyHtml(d)}
<script>window.addEventListener('load', function() { setTimeout(function() { window.print(); }, 400); });</script>
</body></html>`
}

export function summaryXlsx(d: SummaryData, f: ListFilters): Uint8Array {
  const wb = XLSX.utils.book_new()
  const overview = [
    ["รายงานสรุปผลตรวจเครื่องแต่งกายพนักงานหน้าร้าน (Grooming Check)"],
    [summaryFilterLine(f)],
    [`ออกรายงานเมื่อ ${fmtDateTimeTH(new Date())}`],
    [],
    ["รายการตรวจ (ส่งแล้ว)", d.total],
    [`ผ่าน (${PASS_RULE_LABEL})`, d.passed],
    ["ไม่ผ่าน", d.failed],
    ["คะแนนเฉลี่ย (%)", d.avgPercent],
    ["อนุมัติแล้ว", d.byStatus.approved ?? 0],
    ["รอ HR ตรวจสอบ", d.byStatus.pending ?? 0],
    ["รอผู้ตรวจแก้ไข", d.byStatus.rejected ?? 0],
  ]
  const s1 = XLSX.utils.aoa_to_sheet(overview)
  s1["!cols"] = [{ wch: 34 }, { wch: 14 }]
  XLSX.utils.book_append_sheet(wb, s1, "ภาพรวม")
  const s2 = XLSX.utils.aoa_to_sheet([["สาขา", "จำนวนตรวจ", "ผ่าน", "ไม่ผ่าน", "คะแนนเฉลี่ย (%)", "ตรวจล่าสุด", "แผนแก้ไขเกินกำหนด"], ...d.branches.map((b) => [b.branch, b.audits, b.passed, b.failed, b.avgPercent, fmtDateTH(b.lastDate), b.planOverdue])])
  s2["!cols"] = [{ wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 16 }, { wch: 12 }, { wch: 18 }]
  XLSX.utils.book_append_sheet(wb, s2, "รายสาขา")
  const s3 = XLSX.utils.aoa_to_sheet([["หมวด", "หัวข้อ", "ตรวจ", "ผ่าน", "ไม่ผ่าน", "% ไม่ผ่าน"], ...d.items.map((i) => [CATEGORY_LABELS[i.category] ?? i.category, i.label, i.checked, i.pass, i.fail, i.failRate])])
  s3["!cols"] = [{ wch: 26 }, { wch: 40 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 10 }]
  XLSX.utils.book_append_sheet(wb, s3, "รายหัวข้อ")
  const s4 = XLSX.utils.aoa_to_sheet([["สาขา", "วันที่ตรวจ", "ผู้ตรวจ", "ปัญหาที่พบ", "แนวทางแก้ไข", "กำหนดเสร็จ", "สถานะกำหนด", "สถานะรายการ"], ...d.plans.map((p) => [p.branch, p.date, p.inspector, p.problem, p.solution, p.due, p.dueState, p.status])])
  s4["!cols"] = [{ wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 36 }, { wch: 30 }, { wch: 12 }, { wch: 14 }, { wch: 16 }]
  XLSX.utils.book_append_sheet(wb, s4, "แผนการแก้ไข")
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array
}
