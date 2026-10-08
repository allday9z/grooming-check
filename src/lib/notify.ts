/**
 * Email notifications (htask-1791116230138 #10):
 *  - HR gets an email whenever an audit is submitted / re-submitted.
 *  - The inspector gets an email when HR sends items back for revision or
 *    approves — only if they entered an email (there's no login/user list).
 * Same company SMTP relay as the PRF/PR/TPF app. Failures are logged and
 * swallowed: a mail hiccup must never block a submit or a review.
 */
import nodemailer from "nodemailer"
import { CHECKLIST_ITEMS } from "./checklist"
import { fmtDateTH } from "./format"
import { inspectionCode } from "./inspections"

const APP_ORIGIN = process.env.APP_ORIGIN ?? "https://grooming-check.coolify.pve01.prod.uficon.com"
const HR_EMAILS = (process.env.HR_NOTIFY_EMAILS ?? "").split(/[,;\s]+/).filter(Boolean)
const FROM = process.env.SMTP_FROM ?? '"UFicon Grooming Check" <no-reply@uficon.com>'

const transporter = process.env.SMTP_PASSWORD
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? "mail.uficon.com",
      port: Number(process.env.SMTP_PORT ?? 25),
      secure: false,
      auth: { user: process.env.SMTP_USER ?? "no-reply@uficon.com", pass: process.env.SMTP_PASSWORD },
      tls: { rejectUnauthorized: false },
    })
  : null

function esc(s: any): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}
function label(itemId: string): string {
  return CHECKLIST_ITEMS.find((i) => i.itemId === itemId)?.label ?? itemId
}

function shell(title: string, bodyHtml: string, link: string, cta: string): string {
  return `<div style="font-family:Arial,'Sarabun',sans-serif;background:#f4f7f7;padding:20px 10px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #dde5e5;">
    <div style="background:#0a5f66;color:#fff;padding:18px 22px;"><div style="font-size:12px;opacity:.85;">UFicon Grooming Check</div><div style="font-size:18px;font-weight:700;margin-top:4px;">${esc(title)}</div></div>
    <div style="padding:18px 22px;font-size:14px;color:#1f2d2d;line-height:1.6;">${bodyHtml}
      <p style="margin:18px 0 0;"><a href="${link}" style="background:#0a5f66;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;">${esc(cta)}</a></p>
    </div>
  </div></div>`
}

async function send(to: string[], subject: string, html: string): Promise<void> {
  if (!to.length) return
  if (!transporter) { console.log("[notify] SMTP not configured — skipped:", subject, "→", to.join(",")); return }
  try {
    await transporter.sendMail({ from: FROM, to: to.join(","), subject, html })
    console.log("[notify] sent:", subject, "→", to.join(","))
  } catch (e) {
    console.error("[notify] failed:", subject, e)
  }
}

// The button opens the submitted audit itself (read-only /inspect/<token>)
// rather than the HR dashboard — Preeyapan, htask-1791358206756.
export function notifyHrSubmitted(insp: any, resubmittedItems: string[]): void {
  const resub = resubmittedItems.length > 0
  const body = `
    <p>${resub ? "ผู้ตรวจส่งการแก้ไข (Corrective action submitted) กลับมาแล้ว" : "มีรายการตรวจ Grooming ใหม่รอหัวหน้างานตรวจสอบ"}</p>
    <table style="font-size:14px;">
      <tr><td style="color:#6b7a7a;padding-right:12px;">รหัสการตรวจ</td><td><b>${inspectionCode(insp.id)}</b></td></tr>
      <tr><td style="color:#6b7a7a;padding-right:12px;">สาขา</td><td><b>${esc(insp.branch)}</b></td></tr>
      <tr><td style="color:#6b7a7a;padding-right:12px;">ผู้ตรวจ</td><td>${esc(insp.inspector_name)}</td></tr>
      <tr><td style="color:#6b7a7a;padding-right:12px;">วันที่ตรวจ</td><td>${fmtDateTH(insp.inspect_date)}</td></tr>
      <tr><td style="color:#6b7a7a;padding-right:12px;">คะแนน</td><td>${insp.score ?? "-"}/${CHECKLIST_ITEMS.length} (${insp.percent ?? "-"}%)</td></tr>
    </table>
    ${resub ? `<p style="margin-top:12px;">ข้อที่แก้ไข: ${resubmittedItems.map((id) => esc(label(id))).join(", ")}</p>` : ""}`
  void send(HR_EMAILS, `[Grooming] ${inspectionCode(insp.id)} ${resub ? "ส่งการแก้ไขกลับมา" : "รายการตรวจใหม่"} — ${insp.branch} ${fmtDateTH(insp.inspect_date)}`, shell(resub ? "ส่งการแก้ไขกลับมาแล้ว" : "รายการตรวจใหม่รอตรวจสอบ", body, `${APP_ORIGIN}/inspect/${insp.public_token}`, "ดูรายการที่ส่งแล้ว"))
}

export function notifyInspectorReviewed(insp: any, status: "approved" | "rejected", revisions: { itemId: string; comment: string }[], reviewer: string, overallComment: string | null): void {
  if (!insp.inspector_email) return
  const link = `${APP_ORIGIN}/inspect/${insp.public_token}`
  if (status === "approved") {
    const body = `<p>รายการตรวจสาขา <b>${esc(insp.branch)}</b> วันที่ ${fmtDateTH(insp.inspect_date)} ได้รับการยืนยันจากหัวหน้างาน (${esc(reviewer)}) แล้ว</p>${overallComment ? `<p>หมายเหตุ: ${esc(overallComment)}</p>` : ""}`
    void send([insp.inspector_email], `[Grooming] ${inspectionCode(insp.id)} อนุมัติแล้ว — ${insp.branch} ${fmtDateTH(insp.inspect_date)}`, shell("รายการตรวจได้รับการอนุมัติ", body, link, "เปิดดูรายการตรวจ"))
    return
  }
  const list = revisions.map((r) => `<li><b>${esc(label(r.itemId))}</b><br><span style="color:#9c4a03;">${esc(r.comment)}</span></li>`).join("")
  const body = `<p>หัวหน้างาน (${esc(reviewer)}) ขอให้แก้ไขรายการตรวจรหัส <b>${inspectionCode(insp.id)}</b> สาขา <b>${esc(insp.branch)}</b> วันที่ ${fmtDateTH(insp.inspect_date)} จำนวน ${revisions.length} ข้อ:</p>
    <ul>${list}</ul>${overallComment ? `<p>หมายเหตุเพิ่มเติม: ${esc(overallComment)}</p>` : ""}
    <p>กรุณาแก้ไขเฉพาะข้อที่ระบุ แนบรูปหลังแก้ไข (After) และระบุการแก้ไข แล้วกดส่งกลับ</p>`
  void send([insp.inspector_email], `[Grooming] ${inspectionCode(insp.id)} ขอให้แก้ไข ${revisions.length} ข้อ — ${insp.branch} ${fmtDateTH(insp.inspect_date)}`, shell("หัวหน้างานขอให้แก้ไขรายการตรวจ", body, link, "เปิดแก้ไขรายการตรวจ"))
}
