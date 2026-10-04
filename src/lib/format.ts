/**
 * One date format for the whole app (htask-1791116230138 #12): every date
 * is DD/MM/YYYY (Christian year), date-times DD/MM/YYYY HH:mm in Bangkok
 * time — previously the inspector list showed 22/09/2026 while HR showed
 * 22/9/69.
 */
export function fmtDateTH(d: any): string {
  if (!d) return "-"
  const v = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
  const [y, m, day] = v.split("-")
  if (!y || !m || !day) return "-"
  return `${day}/${m}/${y}`
}

export function fmtDateTimeTH(d: any): string {
  if (!d) return "-"
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return "-"
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(dt)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`
}
