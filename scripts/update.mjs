// Haalt de aluminiumkoers en EUR/USD op en werkt public/aluminium.json bij.
// Draait via GitHub Actions; de API-sleutel staat als geheim (METALPRICEAPI_KEY).
import fs from 'node:fs';

const KEY = process.env.METALPRICEAPI_KEY;
const API = process.env.API_BASE || 'https://api.metalpriceapi.com/v1';
const FILE = 'public/aluminium.json';
const OZ_PER_TONNE = 32150.7466;          // troy ounces per metrische ton
const TZ = 'Europe/Amsterdam';
const KEEP_DAYS = 1100;

if (!KEY) { console.error('METALPRICEAPI_KEY ontbreekt'); process.exit(1); }

const r2 = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const dayOf = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts * 1000));
const iso = (d) => d.toISOString().slice(0, 10);

async function get(path, params) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { 'X-API-KEY': KEY } });
  const j = await res.json();
  if (!j.success) throw new Error(path + ': ' + JSON.stringify(j.error || j));
  return j;
}

function point(rates) {
  if (!rates) return null;
  const usdOz = rates.USDALU ?? (rates.ALU ? 1 / rates.ALU : null);
  const fx = rates.USDEUR ?? (rates.EUR ? 1 / rates.EUR : null);
  if (!usdOz || !fx) return null;
  const usd = usdOz * OZ_PER_TONNE;
  if (!(usd > 800 && usd < 8000) || !(fx > 0.7 && fx < 1.8)) return null; // plausibiliteit
  return { usd: r2(usd, 2), eur: r2(usd / fx, 2), fx: r2(fx, 5) };
}

let data = { updated: null, ts: null, latest: null, history: [], intraday: [], meta: {} };
try { data = { ...data, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* eerste run */ }
const hist = new Map(data.history.map((p) => [p.d, p]));

// Eenmalige backfill: twee jaar dagkoersen (2 requests)
if (!data.meta.backfilled) {
  try {
    const now = new Date();
    const back = (n) => { const d = new Date(now); d.setUTCDate(d.getUTCDate() - n); return iso(d); };
    for (const [s, e] of [[back(730), back(366)], [back(365), back(1)]]) {
      const j = await get('/timeframe', { start_date: s, end_date: e, base: 'USD', currencies: 'ALU,EUR' });
      const rows = Array.isArray(j.rates)
        ? j.rates.map((x) => [dayOf(x.timestamp), x.rates])
        : Object.entries(j.rates || {});
      for (const [d, rates] of rows) { const p = point(rates); if (p) hist.set(d, { d, ...p }); }
    }
    data.meta.backfilled = true;
  } catch (e) { console.warn('Backfill mislukt, volgende run opnieuw:', e.message); }
}

// Actuele koers (1 request)
const j = await get('/latest', { base: 'USD', currencies: 'ALU,EUR' });
const p = point(j.rates);
if (!p) throw new Error('Onbruikbare waarde ontvangen: ' + JSON.stringify(j.rates));
const ts = j.timestamp || Math.floor(Date.now() / 1000);
const d = dayOf(ts);
const wd = new Date(d + 'T12:00:00Z').getUTCDay();
if (wd !== 0 && wd !== 6) hist.set(d, { d, ...p });   // weekend niet als handelsdag opslaan

const intra = (data.intraday || []).filter((x) => dayOf(x.t) === d && x.t !== ts);
intra.push({ t: ts, usd: p.usd, eur: p.eur });

data.updated = new Date().toISOString();
data.ts = ts;
data.latest = p;
data.history = [...hist.values()].sort((a, b) => a.d.localeCompare(b.d)).slice(-KEEP_DAYS);
data.intraday = intra.sort((a, b) => a.t - b.t).slice(-48);

fs.mkdirSync('public', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(data));
console.log(`OK ${d}: ${p.usd} USD/t, ${p.eur} EUR/t, EUR/USD ${p.fx}; historie ${data.history.length} dagen`);
