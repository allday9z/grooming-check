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
import { parseJsonbArray, type ListFilters } from "./inspections"

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
    <div class="fb-field fb-search"><label>ค้นหา</label><input type="text" name="q" value="${esc(f.q ?? "")}" placeholder="ชื่อผู้ตรวจ / สาขา / ตำแหน่ง"></div>
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
  const header = ["สาขา", "วันที่ตรวจ", "ผู้ตรวจ", "ตำแหน่ง", "สถานะ", "คะแนน", "%", "ผลรวม", "รอบ", "ส่งเมื่อ", "ผู้ตรวจสอบ (HR)", ...CHECKLIST_ITEMS.map((i) => i.label)]
  const data = rows.map((r) => {
    const items = new Map(parseJsonbArray<any>(r.items).map((i) => [i.itemId, i]))
    return [
      r.branch, fmtDateTH(r.inspect_date), r.inspector_name, positionOf(r), STATUS_LABEL[r.status] || r.status,
      r.score != null ? `${r.score}/${CHECKLIST_TOTAL}` : "", r.percent ?? "", resultLabel(r), r.cycle,
      r.submitted_at ? fmtDateTimeTH(r.submitted_at) : "", r.hr_reviewer ?? "",
      ...CHECKLIST_ITEMS.map((def) => {
        const it = items.get(def.itemId)
        if (!it?.result) return ""
        return (it.result === "pass" ? "ผ่าน" : "ไม่ผ่าน") + (it.note ? ` — ${it.note}` : "")
      }),
    ]
  })
  const ws = XLSX.utils.aoa_to_sheet([header, ...data])
  ws["!cols"] = header.map((h, i) => ({ wch: i < 11 ? Math.max(10, h.length + 2) : 18 }))
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
  const body = rows.map((r) => `<tr><td>${esc(r.branch)}</td><td>${fmtDateTH(r.inspect_date)}</td><td>${esc(r.inspector_name)}<br><small>${esc(positionOf(r))}</small></td><td>${esc(STATUS_LABEL[r.status] || r.status)}</td><td>${r.score != null ? `${r.score}/${CHECKLIST_TOTAL} (${r.percent}%)` : "-"}</td><td>${resultLabel(r)}</td><td>${r.submitted_at ? fmtDateTimeTH(r.submitted_at) : "-"}</td></tr>`).join("")
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
<table><thead><tr><th>สาขา</th><th>วันที่ตรวจ</th><th>ผู้ตรวจ</th><th>สถานะ</th><th>คะแนน</th><th>ผลรวม</th><th>ส่งเมื่อ</th></tr></thead><tbody>${body || `<tr><td colspan="7">ไม่พบรายการ</td></tr>`}</tbody></table>
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
