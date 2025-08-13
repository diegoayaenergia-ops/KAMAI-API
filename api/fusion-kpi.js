// /api/fusion-kpi.ts
export const config = { runtime: "edge" };

const BASE = "https://la5.fusionsolar.huawei.com";
const LOGIN = "/thirdData/login";
const REAL  = "/thirdData/getStationRealKpi";
const DAY   = "/thirdData/getKpiStationDay";

function parseSetCookie(h: Headers, name: string): string | null {
  // Junta múltiplos Set-Cookie e acha o valor do cookie "name"
  const arr = h.getSetCookie ? h.getSetCookie() as any : [];
  const raw = arr?.length ? arr.join(",") : h.get("set-cookie") || "";
  const idx = raw.indexOf(name + "=");
  if (idx < 0) return null;
  const sub = raw.slice(idx + name.length + 1);
  const semi = sub.indexOf(";");
  return (semi >= 0 ? sub.slice(0, semi) : sub).trim();
}

export default async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const user = searchParams.get("user") || Deno.env.get("FUSION_USER") || "";
  const pass = searchParams.get("pass") || Deno.env.get("FUSION_PASS") || "";
  const station = searchParams.get("station") || "NE=39256366";
  const kind = searchParams.get("kind") || "real"; // real | day
  const collectTime = searchParams.get("collectTime"); // ms (só p/ kind=day)

  if (!user || !pass) {
    return new Response(JSON.stringify({ ok:false, error:"missing-credentials" }), { status: 400 });
  }

  // LOGIN
  const lr = await fetch(BASE + LOGIN, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept":"application/json, text/plain, */*" },
    body: JSON.stringify({ userName: user, systemCode: pass })
  });

  const xsrfHeader = lr.headers.get("XSRF-TOKEN") || lr.headers.get("xsrf-token");
  const xsrfCookie = parseSetCookie(lr.headers, "XSRF-TOKEN");
  const jsess = parseSetCookie(lr.headers, "JSESSIONID") || parseSetCookie(lr.headers, "SESSION");

  if (!jsess) {
    const body = await lr.text();
    return new Response(JSON.stringify({ ok:false, step:"login", status: lr.status, xsrfHeader, body }), { status: 502 });
  }

  const cookie = [
    xsrfCookie ? `XSRF-TOKEN=${xsrfCookie}` : null,
    `JSESSIONID=${jsess}`
  ].filter(Boolean).join("; ");

  const headers: Record<string,string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Cookie": cookie
  };
  if (xsrfHeader || xsrfCookie) headers["XSRF-TOKEN"] = xsrfHeader || xsrfCookie!;

  // KPI
  const url = BASE + (kind === "day" ? DAY : REAL);
  const body = kind === "day"
    ? JSON.stringify({ stationCodes: station, collectTime: Number(collectTime) || 0 })
    : JSON.stringify({ stationCodes: station });

  const kr = await fetch(url, { method: "POST", headers, body });
  const j = await kr.json();

  // Resposta simplificada
  if (!j?.success) {
    return new Response(JSON.stringify({ ok:false, step:"kpi", status: kr.status, ...j }), { status: 502 });
  }

  if (kind === "real") {
    const item = (Array.isArray(j.data) ? j.data[0] : j.data) || {};
    const map  = item.dataItemMap || {};
    const when = j.params?.currentTime || Date.now();
    return new Response(JSON.stringify({
      ok:true,
      date: new Date(when).toISOString(),
      day_power: Number(map.day_power) || 0,
      month_power: Number(map.month_power) || 0
    }), { headers: { "Content-Type":"application/json" }});
  } else {
    const rows = (j.data || []).map((r: any) => {
      const d = r.dataItemMap || {};
      const val = [d.ongrid_power, d.PVYield, d.inverter_power, d.theory_power]
        .map(Number).find((x) => !isNaN(x)) || null;
      return { dateMs: r.collectTime, value: val };
    });
    return new Response(JSON.stringify({ ok:true, rows }), { headers: { "Content-Type":"application/json" }});
  }
};
