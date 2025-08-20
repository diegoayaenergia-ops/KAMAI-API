export const config = { runtime: "edge" };

const BASE = "https://la5.fusionsolar.huawei.com";
const LOGIN = `${BASE}/thirdData/login`;
const DAY   = `${BASE}/thirdData/getKpiStationDay`;
const HOUR  = `${BASE}/thirdData/getKpiStationHour`;

const UA = "Mozilla/5.0 (compatible; KamaiProxy/1.0)";

function extract(all: string, key: string): string | null {
  const m = all.match(new RegExp(`${key}=([^;]+)`));
  return m ? `${key}=${m[1]}` : null;
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function postRetry(url: string, body: any, headers: Record<string,string>, tries=5) {
  let last: any = null;
  for (let i=0;i<tries;i++){
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type":"application/json", "accept":"application/json", ...headers },
      body: JSON.stringify(body)
    });
    const txt = await res.text();
    const js  = txt ? JSON.parse(txt) : {};
    const throttled = res.status===429 || res.status===503 ||
      (js && js.success===false && (js.failCode===407 || js.data==="ACCESS_FREQUENCY_IS_TOO_HIGH"));
    if (!throttled && res.ok) return js;
    last = js;
    await sleep( (3 * (2**i) * 1000) + Math.random()*500 );
  }
  throw new Error("Falha após retries: "+JSON.stringify(last));
}

async function login(user: string, pass: string) {
  const res = await fetch(LOGIN, {
    method: "POST",
    headers: { "content-type":"application/json", "accept":"application/json", "user-agent": UA, "origin": BASE, "referer": BASE+"/" },
    body: JSON.stringify({ userName: user, systemCode: pass })
  });

  const setCookie = res.headers.get("set-cookie") || "";
  const xsrfCookie = extract(setCookie, "XSRF-TOKEN");
  const webAuth    = extract(setCookie, "web-auth");
  const jsession   = extract(setCookie, "JSESSIONID");
  const lang       = extract(setCookie, "language");
  const tokenHdr   = res.headers.get("XSRF-TOKEN"); // às vezes vem aqui

  const token = xsrfCookie ? xsrfCookie.split("=")[1] : (tokenHdr || "");
  const cookieHeader = [ xsrfCookie || (token ? `XSRF-TOKEN=${token}` : null), webAuth, jsession, lang ]
                        .filter(Boolean).join("; ");

  if (!cookieHeader || !token) throw new Error("Login ok, mas sem XSRF/cookies.");

  const baseHeaders = {
    "XSRF-TOKEN": token,
    "cookie": cookieHeader,
    "user-agent": UA,
    "origin": BASE,
    "referer": BASE+"/",
    "x-requested-with": "XMLHttpRequest"
  };
  return baseHeaders;
}

type Row = { Data: string, Usina: string, StationCode: string, geracao_total_kWh: number|null };

function pick(dm:any){
  const o = Number(dm?.ongrid_power ?? NaN);
  const p = Number(dm?.PVYield ?? NaN);
  const i = Number(dm?.inverter_power ?? NaN);
  const t = Number(dm?.theory_power ?? NaN);
  return Number.isFinite(o) ? o : Number.isFinite(p) ? p : Number.isFinite(i) ? i : (Number.isFinite(t) ? t : null);
}

function collectMs(y:number,m:number,d:number){
  // UTC-3
  const dt = new Date(Date.UTC(y, m-1, d, 3, 0, 0)); // 00:00-03:00 = 03:00 UTC
  return dt.getTime();
}

async function dayMonth(headers:any, stationCodes:string, y:number, m:number){
  const body = { stationCodes, collectTime: collectMs(y,m,1) };
  return await postRetry(DAY, body, headers);
}

async function sumHourForDate(headers:any, stationCodes:string, dateIso:string){
  const [yy,mm,dd] = dateIso.split("-").map(Number);
  const body = { stationCodes, collectTime: collectMs(yy,mm,dd) };
  const js = await postRetry(HOUR, body, headers);
  const items:any[] = js?.data || [];
  const acc: Record<string,number> = {};
  for (const it of items){
    const code = String((it.stationCode || "NE=?")).replace("NE=","").trim();
    const v = pick(it.dataItemMap||{});
    if (v!=null){
      acc[code] = (acc[code]||0) + Number(v);
    }
  }
  const rows: Row[] = Object.keys(acc).map(code => ({
    Data: dateIso, Usina: `NE=${code}`, StationCode: code, geracao_total_kWh: acc[code]
  }));
  return rows;
}

export default async function handler(req: Request) {
  try{
    const { searchParams } = new URL(req.url);
    const stations = searchParams.get("stations") || "NE=39256366";
    const start    = searchParams.get("start")    || "2025-08-01";
    const end      = searchParams.get("end")      || "2025-08-31";
    // opcional: map names via ?name_39256366=UFV_PIRA_SP...
    const nameMap: Record<string,string> = {};
    for (const [k,v] of searchParams.entries()){
      if (k.startsWith("name_")) nameMap[k.slice(5)] = v;
    }

    const USER = process.env.FUSION_USER!;
    const PASS = process.env.FUSION_PASS!;
    const headers = await login(USER, PASS);

    const dtIni = new Date(start+"T00:00:00");
    const dtFim = new Date(end+"T00:00:00");
    const rows: Row[] = [];

    // loop de meses
    for (let y=dtIni.getFullYear(), m=dtIni.getMonth()+1; (y<dtFim.getFullYear()) || (y===dtFim.getFullYear() && m<=dtFim.getMonth()+1); ){
      const js = await dayMonth(headers, stations, y, m);
      const items:any[] = js?.data || [];

      // janela do mês limitada
      const first = new Date(y, m-1, 1);
      const last  = new Date(y, m, 0);
      const winS  = new Date(Math.max(first.getTime(), dtIni.getTime()));
      const winE  = new Date(Math.min(last.getTime(),  dtFim.getTime()));

      const dailyMap: Record<string, Record<string, number|null>> = {}; // dateIso -> code -> val

      for (const it of items){
        const codeRaw = String(it.stationCode||"NE=?").trim();
        const code = codeRaw.replace("NE=","");
        const tsms = Number(it.collectTime||0);
        const d = new Date(tsms);
        // ajustar para UTC-3
        const dLoc = new Date(d.getTime() - 3*3600*1000);
        const dateIso = dLoc.toISOString().slice(0,10);
        const val = pick(it.dataItemMap||{});
        if (!dailyMap[dateIso]) dailyMap[dateIso] = {};
        dailyMap[dateIso][code] = val;
      }

      // preenche dias do intervalo do mês
      for (let d=new Date(winS); d<=winE; d.setDate(d.getDate()+1)){
        const dateIso = d.toISOString().slice(0,10);
        const codes = stations.split(",").map(s => s.trim()).filter(Boolean).map(s => s.replace("NE=",""));
        for (const code of codes){
          const val = (dailyMap[dateIso]||{})[code] ?? null;
          rows.push({ Data: dateIso, Usina: nameMap[code] || `NE=${code}`, StationCode: code, geracao_total_kWh: val });
        }
      }

      // próximo mês
      m = (m===12) ? 1 : m+1;
      if (m===1) y++;
    }

    // completa nulls somando por hora
    const missingDates = Array.from(new Set(rows.filter(r=>r.geracao_total_kWh==null).map(r=>r.Data))).sort();
    for (const dIso of missingDates){
      const hourRows = await sumHourForDate(headers, stations, dIso);
      for (const hr of hourRows){
        const i = rows.findIndex(r => r.Data===dIso && r.StationCode===hr.StationCode);
        if (i>=0 && rows[i].geracao_total_kWh==null){
          rows[i].geracao_total_kWh = hr.geracao_total_kWh;
        }
      }
      await sleep(1000); // paz com rate limit
    }

    // ordena
    rows.sort((a,b)=> (a.Usina.localeCompare(b.Usina) || a.Data.localeCompare(b.Data)));

    return new Response(JSON.stringify({ rows }), {
      headers: {
        "content-type":"application/json; charset=utf-8",
        "access-control-allow-origin":"*"
      }
    });
  }catch(e:any){
    return new Response(JSON.stringify({ error: String(e?.message||e) }), { status: 500, headers: {"content-type":"application/json"} });
  }
}
