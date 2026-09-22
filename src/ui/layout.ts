export function renderPage(opts: { title: string; body: string; styles?: string; scripts?: string; wide?: boolean }): string {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${opts.title}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Kanit:wght@500;600;700&family=Sarabun:wght@400;500;600;700&display=swap');
  :root { --brand:#0a5f66; --brand-dark:#074a50; --bg:#f4f7f7; --card:#ffffff; --border:#dde5e5; --text:#1f2d2d; --muted:#6b7a7a; --pass:#1a7f3c; --fail:#c22b2b; --pending:#b45309; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: "Sarabun", "Segoe UI", Tahoma, sans-serif; background: var(--bg); color: var(--text); }
  h1, h2, h3, .kanit { font-family: "Kanit", "Sarabun", sans-serif; }
  .page { max-width: ${opts.wide ? "1120px" : "640px"}; margin: 0 auto; padding: 16px 14px 64px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  h1 { font-size: 20px; color: var(--brand-dark); margin: 0 0 4px; }
  h2 { font-size: 16px; color: var(--brand-dark); margin: 0 0 12px; }
  p.sub { color: var(--muted); margin: 0 0 16px; font-size: 13.5px; }
  .top-nav { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:8px; }
  .top-nav a { color: var(--brand); font-size:13.5px; text-decoration:none; }
  .btn { display:inline-block; background: var(--brand); color:#fff; border:none; padding:12px 22px; border-radius:8px; font-size:14.5px; font-weight:600; cursor:pointer; text-decoration:none; text-align:center; font-family:inherit; }
  .btn:hover { background: var(--brand-dark); }
  .btn:disabled { opacity:0.55; cursor:not-allowed; }
  .btn-ghost { background:#fff; color: var(--brand); border:1.5px solid var(--brand); }
  .btn-danger { background: var(--fail); }
  .field { margin-bottom: 14px; }
  .field label { display:block; font-weight:600; font-size:13.5px; margin-bottom:6px; }
  .field .req { color: var(--fail); margin-left:2px; }
  .field input[type=text], .field input[type=date], .field select, .field textarea { width:100%; padding:10px 11px; border:1.5px solid var(--border); border-radius:8px; font-size:15px; font-family:inherit; background:#fff; }
  .field input:focus, .field select:focus, .field textarea:focus { outline:none; border-color: var(--brand); }
  .errmsg { color: var(--fail); font-size:12px; margin-top:4px; display:none; }
  .errmsg.show { display:block; }
  .status-line { margin-top:14px; font-size:14px; min-height:20px; }
  .status-line.err { color: var(--fail); }
  .status-line.ok { color: var(--pass); font-weight:600; }
  .badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:700; }
  .badge.draft { background:#eef0f0; color:#4b5a5a; }
  .badge.pending { background:#fff3e0; color: var(--pending); }
  .badge.approved { background:#e4f7ea; color: var(--pass); }
  .badge.rejected { background:#fdeaea; color: var(--fail); }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse: collapse; font-size:13.5px; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--border); white-space:nowrap; }
  th { color: var(--muted); font-weight:600; font-size:12px; }
  tr.clickable { cursor:pointer; }
  tr.clickable:hover { background:#f7fafa; }
  .stat-grid { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
  .stat-box { flex:1 1 130px; background:#fff; border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  .stat-box .num { font-size:24px; font-weight:700; color: var(--brand-dark); }
  .stat-box .label { font-size:12px; color: var(--muted); }
  .tabs { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px; }
  .tab { padding:8px 14px; border-radius:8px; font-size:13.5px; font-weight:600; text-decoration:none; color: var(--muted); background:#eef0f0; }
  .tab.active { background: var(--brand); color:#fff; }
  .checklist-cat { font-size:13px; font-weight:700; color: var(--brand-dark); text-transform:uppercase; letter-spacing:.02em; margin: 18px 0 8px; }
  .check-item { border:1.5px solid var(--border); border-radius:10px; padding:14px; margin-bottom:10px; }
  .check-item.done-pass { border-color:#86e0ab; background:#f4fbf6; }
  .check-item.done-fail { border-color:#f0a8a8; background:#fdf5f5; }
  .check-item-label { font-size:14px; font-weight:600; margin-bottom:10px; }
  .check-opts { display:flex; gap:10px; margin-bottom:8px; }
  .check-opt-btn { flex:1; padding:10px; border-radius:8px; border:1.5px solid var(--border); background:#fff; font-size:13.5px; font-weight:600; cursor:pointer; font-family:inherit; color:var(--text); }
  .check-opt-btn.pass.active { background: var(--pass); color:#fff; border-color: var(--pass); }
  .check-opt-btn.fail.active { background: var(--fail); color:#fff; border-color: var(--fail); }
  .photo-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .photo-thumb { width:64px; height:64px; object-fit:cover; border-radius:8px; border:1px solid var(--border); cursor:zoom-in; }
  .progress-bar-wrap { background:#eef2f2; border-radius:8px; height:10px; overflow:hidden; margin:8px 0 4px; }
  .progress-bar-fill { height:100%; background: var(--brand); transition: width .2s; }
  .lightbox { position: fixed; inset:0; background: rgba(10,15,20,0.9); z-index:200; display:none; align-items:center; justify-content:center; padding:20px; cursor:zoom-out; }
  .lightbox img { max-width:100%; max-height:100%; border-radius:6px; }
  .reject-banner { background:#fff3e0; border:1px solid #f0c674; border-radius:10px; padding:14px 16px; margin-bottom:16px; }
  .reject-banner b { color:#9c4a03; }
  ${opts.styles ?? ""}
  @media (max-width: 640px) {
    .field input[type=text], .field select { font-size:16px; }
  }
</style>
</head>
<body>
<div class="page">
${opts.body}
</div>
<div id="lightbox" class="lightbox" onclick="this.style.display='none'"><img id="lightbox-img" src="" alt=""></div>
<script>
  function openLightbox(url) { document.getElementById('lightbox-img').src = url; document.getElementById('lightbox').style.display = 'flex'; }
</script>
<script>${opts.scripts ?? ""}</script>
</body>
</html>`
}

export function esc(s: any): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "ฉบับร่าง",
  pending: "รอ HR ตรวจสอบ",
  approved: "อนุมัติแล้ว",
  rejected: "ตีกลับ",
}

export function statusBadge(status: string): string {
  return `<span class="badge ${status}">${STATUS_LABEL[status] || status}</span>`
}
