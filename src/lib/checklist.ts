/**
 * The 14 fixed grooming checklist items, from the original Google Form
 * (UFicon-CHK-001) per the requirement doc's appendix (10.1). itemId codes
 * (u1-u6, p1-p5, c1-c3) are the same keys used in the legacy form/prototype
 * — kept identical so historical data references stay meaningful if this
 * ever needs to be cross-referenced against the old Google Sheet.
 */
export interface ChecklistItem {
  itemId: string
  category: "uniform" | "personal" | "card"
  label: string
}

export const CATEGORY_LABELS: Record<string, string> = {
  uniform: "ก. เครื่องแต่งกาย",
  personal: "ข. บุคลิกภาพและความสะอาด",
  card: "ค. บัตรพนักงาน",
}

export const CHECKLIST_ITEMS: ChecklistItem[] = [
  { itemId: "u1", category: "uniform", label: "สวมยูนิฟอร์มถูกต้องตามที่กำหนด" },
  { itemId: "u2", category: "uniform", label: "เสื้อสะอาด ไม่ยับ ไม่มีคราบ ไม่มีกลิ่น" },
  { itemId: "u3", category: "uniform", label: "กางเกงสีสุภาพ ไม่ฉีกขาด ไม่มีลวดลาย" },
  { itemId: "u4", category: "uniform", label: "รองเท้าเป็นแบบหุ้มส้น สะอาด" },
  { itemId: "u5", category: "uniform", label: "ไม่สวมเสื้อคลุมทับยูนิฟอร์มด้านนอก" },
  { itemId: "u6", category: "uniform", label: "เครื่องประดับเรียบง่าย ไม่เยอะ" },
  { itemId: "p1", category: "personal", label: "ทรงผมเรียบร้อย ไม่รกรุงรัง" },
  { itemId: "p2", category: "personal", label: "หนวดเคราสะอาด (พนักงานชาย)" },
  { itemId: "p3", category: "personal", label: "แต่งหน้าโทนสุภาพ (พนักงานหญิง)" },
  { itemId: "p4", category: "personal", label: "ไม่มีกลิ่นตัว" },
  { itemId: "p5", category: "personal", label: "เล็บสั้น สะอาด ไม่ฉูดฉาด" },
  { itemId: "c1", category: "card", label: "ติดบัตรพนักงานด้วยสายคล้องที่กำหนด" },
  { itemId: "c2", category: "card", label: "มองเห็นชื่อ-สกุลได้ชัดเจน" },
  { itemId: "c3", category: "card", label: "บัตรและสายคล้องสะอาด" },
]

export const CHECKLIST_TOTAL = CHECKLIST_ITEMS.length // 14

export const POSITIONS = ["Area Manager - Apple", "Store Manager", "Assistant Store Manager", "Sales Supervisor"]

// 28 branch codes, per requirement doc appendix 10.3 — static for MVP;
// doc explicitly flags this should eventually pull from a central HR/branch
// system instead of being hardcoded here.
export const BRANCHES = [
  "HES-KBI", "HES-TMN", "HMD-CCS", "HMD-CNV", "HMD-CWN", "HMD-EMQ", "HMD-HKT", "HMD-KKC", "HMD-MVH",
  "IM-FI", "IM-TM", "IM-TR",
  "IS-FI", "IS-KBI", "IS-KKC", "IS-PN", "IS-TA", "IS-TK", "IS-TM", "IS-TR",
  "US-PSU", "US-SR", "US-SRU", "US-SW", "US-SWOK", "US-UBRU", "US-WU", "US-WUH",
]
