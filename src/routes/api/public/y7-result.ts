import { createFileRoute } from "@tanstack/react-router";

/**
 * Public proxy to natega.youm7.com — bypasses CORS + cookie handshake
 * so a static frontend (Lovable preview / GitHub Pages / anywhere) can
 * fetch a student's Thanaweya result as clean JSON.
 *
 *   GET  /api/public/y7-result?seat=2930788&system=1
 *   POST /api/public/y7-result   (JSON body { seat, system })
 *
 * Returns:
 *   { ok, seat, name, status, education, section, subjects:[{name,score,max,pct}],
 *     total, maxTotal, percentage, source }
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Grab cookies from Set-Cookie headers (single-header or split). */
function collectCookies(res: Response, jar: Map<string, string>) {
  // Undici Response exposes getSetCookie() on modern runtimes.
  const anyRes = res as unknown as { headers: Headers & { getSetCookie?: () => string[] } };
  const arr: string[] =
    typeof anyRes.headers.getSetCookie === "function"
      ? anyRes.headers.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
  for (const raw of arr) {
    const first = raw.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Parse the student-result block from the returned HTML. */
function parseResultHtml(html: string, seat: number) {
  const rootIdx = html.indexOf("student-result");
  if (rootIdx < 0) return null;
  const block = html.slice(rootIdx, rootIdx + 20000);

  const pickText = (cls: string) => {
    const re = new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)</`, "i");
    const m = block.match(re);
    return m ? stripTags(m[1]) : "";
  };

  const rawName = pickText("student-result__name");
  const name = rawName.replace(/^\s*(الاسم|الأسم)\s*[:：]\s*/, "").trim();

  // Meta lines: <p class="student-result__school|__seat">label: value</p>
  const meta: Record<string, string> = {};
  const metaRe = /<p[^>]*class="student-result__(?:school|seat)[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = metaRe.exec(block))) {
    const t = stripTags(mm[1]);
    const idx = t.indexOf(":");
    if (idx > 0) meta[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }

  // Subjects table.
  const subjects: Array<{ name: string; score: number | null; max: number | null; pct: number | null; note?: string }> = [];
  const tblMatch = block.match(/<table[\s\S]*?<\/table>/i);
  if (tblMatch) {
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(tblMatch[0]))) {
      const cells = Array.from(rm[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((c) =>
        stripTags(c[1]),
      );
      if (cells.length < 2) continue;
      const label = cells[0];
      if (!label || /المادة|النسبة المئوية الكلية|مجموع الدرجات/.test(label)) continue;
      const scoreCell = cells[1] || "";
      const pctCell = cells[2] || "";
      const sm = scoreCell.match(/([\d.]+|غير مقرر)\s*\/\s*([\d.]+)/);
      let score: number | null = null;
      let max: number | null = null;
      let note: string | undefined;
      if (sm) {
        if (sm[1] === "غير مقرر") note = "غير مقرر";
        else score = parseFloat(sm[1]);
        max = parseFloat(sm[2]);
      }
      const pm = pctCell.match(/([\d.]+)\s*%/);
      const pct = pm ? parseFloat(pm[1]) : null;
      subjects.push({ name: label, score, max, pct, ...(note ? { note } : {}) });
    }
  }

  // Overall total + percentage.
  const totalMatch = block.match(/مجموع الدرجات[^<]*<[^>]*>[\s\S]*?([\d.]+)\s*\/\s*([\d.]+)/);
  const pctMatch = block.match(/النسبة المئوية الكلية[^<]*<[^>]*>[\s\S]*?([\d.]+)\s*%/);

  return {
    seat,
    name,
    status: meta["حالة الطالب"] || "",
    education: meta["نوعية التعليم"] || "",
    section: meta["الشعبة"] || "",
    subjects,
    total: totalMatch ? parseFloat(totalMatch[1]) : null,
    maxTotal: totalMatch ? parseFloat(totalMatch[2]) : null,
    percentage: pctMatch ? parseFloat(pctMatch[1]) : null,
  };
}

async function fetchResult(seat: number, system: number) {
  const jar = new Map<string, string>();

  // 1) POST the seat. Server replies 302 + Set-Cookie(.T.rs=…) that stashes
  //    the seat in a short-lived session. fetch() does NOT propagate cookies
  //    through redirects, so handle the redirect manually.
  const post = await fetch("https://natega.youm7.com/Result/1", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ar,en;q=0.8",
      Origin: "https://natega.youm7.com",
      Referer: "https://natega.youm7.com/",
    },
    body: `seating_no=${encodeURIComponent(String(seat))}&system=${encodeURIComponent(String(system))}`,
    redirect: "manual",
  });
  collectCookies(post, jar);

  // 2) Follow the redirect (GET /Result/1) with the fresh session cookie.
  const loc = post.headers.get("location") || "/Result/1";
  const followUrl = new URL(loc, "https://natega.youm7.com/").toString();
  const get = await fetch(followUrl, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ar,en;q=0.8",
      Referer: "https://natega.youm7.com/",
      Cookie: cookieHeader(jar),
    },
    redirect: "follow",
  });
  if (!get.ok) throw new Error(`Upstream ${get.status}`);
  const html = await get.text();
  const parsed = parseResultHtml(html, seat);
  if (!parsed || !parsed.name) {
    return { ok: false as const, error: "لم يتم العثور على نتيجة بهذا الرقم." };
  }
  return { ok: true as const, source: "youm7", ...parsed };
}

async function handle(seatRaw: string | null, systemRaw: string | null) {
  const seat = parseInt(String(seatRaw || "").replace(/\D/g, ""), 10);
  const system = parseInt(String(systemRaw || "1").replace(/\D/g, ""), 10) || 1;
  if (!seat || String(seat).length < 4) return json({ ok: false, error: "رقم جلوس غير صالح." }, 400);
  try {
    const data = await fetchResult(seat, system);
    return json(data, data.ok ? 200 : 404);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message || "تعذّر الاتصال بالخادم." }, 502);
  }
}

export const Route = createFileRoute("/api/public/y7-result")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => {
        const u = new URL(request.url);
        return handle(u.searchParams.get("seat"), u.searchParams.get("system"));
      },
      POST: async ({ request }) => {
        let seat: string | null = null;
        let system: string | null = null;
        const ct = request.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const b = (await request.json().catch(() => ({}))) as { seat?: unknown; system?: unknown };
          seat = b.seat == null ? null : String(b.seat);
          system = b.system == null ? null : String(b.system);
        } else {
          const fd = await request.formData().catch(() => null);
          if (fd) {
            seat = (fd.get("seat") as string) || (fd.get("seating_no") as string) || null;
            system = (fd.get("system") as string) || null;
          }
        }
        return handle(seat, system);
      },
    },
  },
});