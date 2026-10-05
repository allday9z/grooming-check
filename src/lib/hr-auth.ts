/**
 * Password gate for the HR section (htask-1791178152734 — Preeyapan asked
 * that "สำหรับฝ่าย HR" require a password). One shared HR password in env
 * HR_PASSWORD; on login we set an httpOnly cookie holding an HMAC of a fixed
 * label keyed by that password, so changing HR_PASSWORD logs everyone out.
 * Inspectors (/inspect) stay password-free as before.
 */
import type { Context, Next } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"

const COOKIE = "gc_hr"
const MAX_AGE = 60 * 60 * 24 * 7 // 7 days

function password(): string | null {
  return process.env.HR_PASSWORD || null
}

async function token(): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password() ?? ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("grooming-check-hr-v1"))
  return Buffer.from(sig).toString("hex")
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function checkHrPassword(input: string): boolean {
  const pw = password()
  return !!pw && safeEqual(input, pw)
}

export async function isHr(c: Context): Promise<boolean> {
  if (!password()) return false
  const v = getCookie(c, COOKIE)
  return !!v && safeEqual(v, await token())
}

export async function setHrCookie(c: Context): Promise<void> {
  setCookie(c, COOKIE, await token(), { httpOnly: true, sameSite: "Lax", secure: true, path: "/", maxAge: MAX_AGE })
}

export function clearHrCookie(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/" })
}

/** Only allow same-site relative paths as the post-login redirect. */
export function safeNext(next: string | undefined | null): string {
  const n = String(next ?? "")
  return n.startsWith("/hr") && !n.startsWith("//") ? n : "/hr"
}

/** Middleware: page requests go to the login page (keeping where they were
 * headed), API-style requests (POST / photos / exports) get 401. */
export async function requireHr(c: Context, next: Next) {
  if (await isHr(c)) return next()
  const url = new URL(c.req.url)
  const wantsPage = c.req.method === "GET" && !url.pathname.endsWith(".xlsx") && !url.pathname.includes("/photo/")
  if (wantsPage) return c.redirect(`/hr/login?next=${encodeURIComponent(url.pathname + url.search)}`)
  return c.json({ error: "hr_login_required" }, 401)
}
