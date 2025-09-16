// applet.js
// SpaceForce Intel Applet — DeepSeek-tuned (v5.3 with advanced caching)
// Primary: EliteBGS v5 (faction boards). Fallback/extra: EDSM (system, stations, bodies, traffic/deaths).
// INARA: commander profiles only. Archive (BGS guide) from your GitHub raw JSON.
// Lore-friendly outputs. Never invent numbers. Allow stale with timestamps. Strong NLU router + diagnostics + robust cache.

const APP_NAME = "SpaceForce-IntelApplet";
const APP_VERSION = "5.3.0";

// ---------- Data sources ----------
const INARA_API = "https://inara.cz/inapi/v1/";
const ELITEBGS_API = "https://elitebgs.app/api/ebgs/v5";      // factions/systems (presence, influence, states)
const EDSM_SYS_API = "https://www.edsm.net/api-v1";            // system info
const EDSM_SYSTEM_API = "https://www.edsm.net/api-system-v1";  // factions (fallback), stations/bodies/activity

// ---------- Archive JSON (GitHub RAW) ----------
const RAW = "https://raw.githubusercontent.com/Benjanesvi/aicord-elitedangerous/main/data";
const BGS_CHUNKS_URL = `${RAW}/bgs_chunks.json`;
const BGS_INDEX_URL  = `${RAW}/bgs_index.json`;

// Optional market relay (leave "" to disable)
const MARKET_API_BASE = "";

// Behavior
const LORE_ERRORS = true;
const ALLOW_STALE = true;              // do not block if data is old; append timestamp
const SHOW_TEACH_SNIPPETS = true;
const HTTP_TIMEOUT_MS = 12000;
const MAX_LINES = 16;

const ADMINS = new Set(["Benjanesvi"]);
const UA = { "User-Agent": `${APP_NAME}/${APP_VERSION} (+EliteBGS+EDSM+INARA)` };

// ---- Cache tuning ----
const CACHE_MAX_ENTRIES = 1000;               // overall cap (LRU)
const TTL = {
  bgs:     3 * 60 * 1000,     // 3m — EliteBGS boards update often
  edsm:    5 * 60 * 1000,     // 5m — systems/stations/bodies/activity
  inara:  15 * 60 * 1000,     // 15m — commander profiles change rarely
  archive:24 * 60 * 60 * 1000,// 24h — static guide
  market:  1 * 60 * 1000      // 1m — if you enable a market relay
};
const NEG_TTL_MS = 2 * 60 * 1000; // negative cache (404/204) to avoid hammering

// ---------- Canonicalization ----------
const CANONICAL_NAMES = {
  "black sun crew": "Black Sun Crew",
  "space force": "Space Force",
  "oblivion fleet": "Oblivion Fleet",
  "jerome archer": "Jerome Archer",
  "bsc": "Black Sun Crew",
  "of": "Oblivion Fleet"
};
const SYSTEM_ALIASES = {
  "14850": "LTT 14850",
  "ltt14850": "LTT 14850",
  "ltt-14850": "LTT 14850",
  "ltt 14850": "LTT 14850",
  "guragwe": "Guragwe"
};
const SPACEFORCE_OVERRIDES = {
  ltt14850: { "Black Sun Crew": { note: "Black Sun Crew cannot retreat in LTT 14850 (home system)." } }
};

// ---------- Utils ----------
function norm(s){ return typeof s==="string" ? s.trim() : s; }
function okStr(s){ return typeof s==="string" && s.trim().length>0; }
function nowISO(){ return new Date().toISOString(); }
function timeout(ms){ return new Promise((_,rej)=>setTimeout(()=>rej(new Error(`timeout ${ms}ms`)), ms)); }
async function fetchWithTimeout(url, opts={}, ms=HTTP_TIMEOUT_MS){ return Promise.race([fetch(url, opts), timeout(ms)]); }
function canonicalizeName(raw){ if(!raw) return raw; const k=raw.toLowerCase().trim(); return CANONICAL_NAMES[k] || raw; }
function canonicalizeSystem(raw){
  if(!raw) return raw;
  const key = raw.toLowerCase().trim();
  if (SYSTEM_ALIASES[key]) return SYSTEM_ALIASES[key];
  const m = key.match(/\bltt[-\s]?(\d{4,5})\b/i);
  if (m) return `LTT ${m[1]}`;
  return raw;
}
function pctFromUnit(n){ if(typeof n!=="number") return "N/A"; const v=(n>=0&&n<=1)?n*100:n; return `${v.toFixed(1)}%`; }
function msToAgo(ms){ const s=Math.max(0,Math.floor(ms/1000)); const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60); if(d) return `${d}d ${h}h`; if(h) return `${h}h ${m}m`; return `${m}m`; }
function loreErrorLine(kind){
  if(!LORE_ERRORS) return String(kind||"error");
  switch(kind){
    case "network": return "The lines are jammed. I’ll use what intel we have on hand.";
    case "parse":   return "Data feed came through scrambled. Falling back to known records.";
    case "notfound":return "No records on that one. Check the name and I’ll re-run the scan.";
    default:        return "Intel link flickered. Using stored reports.";
  }
}
function appendTickLine(text, ts){
  if(!ts) return text;
  const when = new Date(String(ts)); if (isNaN(when.getTime())) return text;
  const age = Date.now()-when.getTime();
  return `${text}\n_Last update: ${when.toISOString()} (${msToAgo(age)} ago)_`;
}
function extractTimestamp(...objs){
  for(const o of objs||[]){
    if(!o) continue;
    const cands=[o.lastUpdate,o.factionsUpdated,o.updated_at,o.updatedAt,o.updateTime,o.date,o.dateLastUpdate,o.information?.lastUpdate,o.deaths?.lastDay,o.traffic?.lastDay];
    for(const c of cands){ if(c) return c; }
  }
  return null;
}
function bullets(items){ return items.filter(Boolean).map(s=>s.startsWith("•")?s:`• ${s}`).join("\n"); }

// ---- LRU Cache with TTL + negative caching + stale-on-error ----
const _CACHE = new Map(); // key -> {ts, ttl, data, ok, status, etag, lastMod}

// promote key to most-recent
function _touchLRU(key) {
  const val = _CACHE.get(key);
  if (val !== undefined) {
    _CACHE.delete(key);
    _CACHE.set(key, val);
  }
}

function cacheGetFresh(key) {
  const v = _CACHE.get(key);
  if (!v) return null;
  const fresh = (Date.now() - v.ts) <= v.ttl;
  if (fresh) _touchLRU(key);
  return fresh ? v : null;
}
function cacheGetAny(key) {
  const v = _CACHE.get(key);
  if (!v) return null;
  _touchLRU(key);
  return v; // may be stale
}
function cacheSet(key, payload) {
  // payload: { data, ttl, ok, status, etag?, lastMod? }
  _CACHE.set(key, { ...payload, ts: Date.now() });
  // LRU prune
  while (_CACHE.size > CACHE_MAX_ENTRIES) {
    const firstKey = _CACHE.keys().next().value;
    _CACHE.delete(firstKey);
  }
}

// Generic cached JSON GET (supports ETag/Last-Modified; stale-on-error)
async function fetchJSONCached(url, bucket, opts = {}) {
  const ttl = TTL[bucket] ?? (5 * 60 * 1000);
  const key = `${bucket}:${url}`;
  const fresh = cacheGetFresh(key);
  if (fresh) return { json: fresh.data, stale: false, status: fresh.status };

  const stale = cacheGetAny(key);

  try {
    const headers = { ...(opts.headers||{}), ...UA };
    if (stale?.etag) headers["If-None-Match"] = stale.etag;
    if (stale?.lastMod) headers["If-Modified-Since"] = stale.lastMod;

    const res = await fetchWithTimeout(url, { ...opts, headers });

    if (res.status === 304 && stale) {
      cacheSet(key, { data: stale.data, ttl, ok: true, status: 200, etag: stale.etag, lastMod: stale.lastMod });
      return { json: stale.data, stale: false, status: 200 };
    }

    if (!res.ok) {
      if (res.status === 404 || res.status === 204) {
        cacheSet(key, { data: null, ttl: NEG_TTL_MS, ok: false, status: res.status });
      }
      if (stale && ALLOW_STALE) {
        return { json: stale.data, stale: true, status: stale.status ?? 200 };
      }
      return { error: "network", status: res.status };
    }

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch {
      if (stale && ALLOW_STALE) return { json: stale.data, stale: true, status: stale.status ?? 200 };
      return { error: "parse" };
    }

    cacheSet(key, {
      data: json, ttl, ok: true, status: res.status,
      etag: res.headers.get("ETag") || undefined,
      lastMod: res.headers.get("Last-Modified") || undefined
    });
    return { json, stale: false, status: res.status };
  } catch {
    if (stale && ALLOW_STALE) return { json: stale.data, stale: true, status: stale.status ?? 200 };
    return { error: "network" };
  }
}

// Cache-aware rate guard
const RATE = new Map();
function rateOk(who="guild"){ const now=Date.now(); const arr=(RATE.get(who)||[]).filter(t=>now-t<5000); arr.push(now); RATE.set(who,arr); return arr.length<=6; }

// ---------- INARA (commanders only; memoized) ----------
async function inaraCommanderProfile(searchName){
  const key = `inara:cmdr:${searchName.toLowerCase()}`;
  const ttl = TTL.inara;
  const fresh = cacheGetFresh(key);
  if (fresh) return { event: fresh.data, stale: false };

  const stale = cacheGetAny(key);

  const body = {
    header: { appName: APP_NAME, appVersion: APP_VERSION, isBeingDeveloped: false, APIkey: "{{INARA_API_KEY}}" },
    events: [{ eventName: "getCommanderProfile", eventTimestamp: nowISO(), eventData: { searchName } }]
  };

  try {
    const res = await fetchWithTimeout(INARA_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      if ((res.status === 404 || res.status === 204)) {
        cacheSet(key, { data: null, ttl: NEG_TTL_MS, ok: false, status: res.status });
      }
      if (stale && ALLOW_STALE) return { event: stale.data, stale: true };
      return { error: "network", status: res.status };
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch {
      if (stale && ALLOW_STALE) return { event: stale.data, stale: true };
      return { error: "parse" };
    }
    const ev = json?.events?.[0];
    cacheSet(key, { data: ev, ttl, ok: true, status: 200 });
    return { event: ev, stale: false };
  } catch {
    if (stale && ALLOW_STALE) return { event: stale.data, stale: true };
    return { error: "network" };
  }
}
function formatCommander(ev){
  if(!ev || ev.eventStatus===204) return loreErrorLine("notfound");
  if(ev.eventStatus!==200) return loreErrorLine("unknown");
  const d=ev.eventData||{};
  const name = canonicalizeName(d.commanderName || d.userName || "Unknown CMDR");
  const ranks = Array.isArray(d.commanderRanksPilot)&&d.commanderRanksPilot.length
    ? d.commanderRanksPilot.map(r=>`${r.rankName}: ${r.rankValue}${r.rankProgress!=null?` (${Math.round(r.rankProgress*100)}%)`:""}`).join(", ")
    : "N/A";
  const squad = canonicalizeName(d.commanderSquadron?.SquadronName || "N/A");
  const url = d.inaraURL || ""; const ql = d.commanderSquadron?.inaraURL || "";
  return bullets([`**${name}**`,`Ranks: ${ranks}`,`Squadron: ${squad}`, ql&&`Squadron page: ${ql}`, url&&`INARA profile: ${url}`]);
}

// ---------- EDSM (fallback + stations/bodies/activity; cached) ----------
async function edsmJSON(url){ return fetchJSONCached(url, "edsm"); }
async function edsmSystem(system){ const s=encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYS_API}/system?systemName=${s}&showInformation=1&showPrimaryStar=1&showCoordinates=1&showPermit=1`); }
async function edsmSystemFactions(system){ const s=encodeURIComponent(system); return edsmJSON(`${EDSM_SYSTEM_API}/factions?systemName=${s}`); }
async function edsmSystemStations(system){ const s=encodeURIComponent(system); return edsmJSON(`${EDSM_SYSTEM_API}/stations?systemName=${s}`); }
async function edsmSystemBodies(system){ const s=encodeURIComponent(system); return edsmJSON(`${EDSM_SYSTEM_API}/bodies?systemName=${s}`); }
async function edsmTraffic(system){ const s=encodeURIComponent(system); return edsmJSON(`${EDSM_SYSTEM_API}/traffic?systemName=${s}`); }
async function edsmDeaths(system){ const s=encodeURIComponent(system); return edsmJSON(`${EDSM_SYSTEM_API}/deaths?systemName=${s}`); }

// ---------- EliteBGS (primary boards; cached) ----------
async function bgsJSON(url){ return fetchJSONCached(url, "bgs"); }
async function bgsSystem(system){ const s=encodeURIComponent(system); return bgsJSON(`${ELITEBGS_API}/systems?name=${s}`); }
async function bgsFaction(faction){ const f=encodeURIComponent(faction); return bgsJSON(`${ELITEBGS_API}/factions?name=${f}`); }

// Map EliteBGS → our formatter shapes
function mapBgsSystemToSnapshot(bgs){
  const doc = Array.isArray(bgs)&&bgs.length ? bgs[0] : null; if(!doc) return null;
  const sysDoc = {
    name: doc.name || "Unknown",
    information: { allegiance: doc.allegiance || doc.allegiancePrimary || "Unknown", government: doc.government || "Unknown", population: doc.population ?? "?" },
    lastUpdate: doc.updated_at || doc.updatedAt || doc.updateTime || null
  };
  const factions = (doc.factions||[]).map(f=>({
    name: f.name,
    influence: typeof f.influence==="number" ? f.influence : (typeof f.influence24h==="number" ? f.influence24h : 0),
    state: (Array.isArray(f.active_states)&&f.active_states[0]?.state) || f.state || null,
    pendingStates: Array.isArray(f.pending_states) ? f.pending_states.map(s=>({state:s.state})) : [],
    recoveringStates: Array.isArray(f.recovering_states) ? f.recovering_states.map(s=>({state:s.state})) : []
  }));
  const facDoc = { factions, factionsUpdated: doc.updated_at || doc.updatedAt || null };
  return { sysDoc, facDoc };
}
function pickFactionInSystemFromBgs(factionName, bgsFactionDoc, systemName){
  const doc = Array.isArray(bgsFactionDoc)&&bgsFactionDoc.length ? bgsFactionDoc[0] : null; if(!doc) return null;
  const pres = (doc.faction_presence||[]).find(p => (p.system_name||"").toLowerCase()===systemName.toLowerCase());
  if(!pres) return null;
  return {
    name: doc.name,
    influence: pres.influence ?? 0,
    state: (Array.isArray(pres.active_states)&&pres.active_states[0]?.state) || null,
    pendingStates: Array.isArray(pres.pending_states) ? pres.pending_states.map(s=>({state:s.state})) : [],
    recoveringStates: Array.isArray(pres.recovering_states) ? pres.recovering_states.map(s=>({state:s.state})) : []
  };
}

// ---------- Formatters ----------
function formatSystemSnapshot(sysDoc, factionsDoc){
  if(!sysDoc || sysDoc.name==null) return loreErrorLine("notfound");
  const info=sysDoc.information||{};
  const lines=[`**${sysDoc.name}** — Allegiance: ${info.allegiance||"?"}, Gov: ${info.government||"?"}, Pop: ${info.population??"?"}`];
  const factions=factionsDoc?.factions||[];
  if(Array.isArray(factions)&&factions.length){
    for(const f of factions){
      const name=canonicalizeName(f.name||"Unknown Faction");
      const parts=[`${name}: ${pctFromUnit(f.influence)}`];
      if(f.state) parts.push(`state: ${f.state}`);
      if(Array.isArray(f.pendingStates)&&f.pendingStates.length) parts.push(`pending: ${f.pendingStates.map(x=>x.state).join(", ")}`);
      if(Array.isArray(f.recoveringStates)&&f.recoveringStates.length) parts.push(`recovering: ${f.recoveringStates.map(x=>x.state).join(", ")}`);
      if(sysDoc.name.toLowerCase()==="ltt 14850" && name==="Black Sun Crew") parts.push(SPACEFORCE_OVERRIDES.ltt14850["Black Sun Crew"].note);
      lines.push(`• ${parts.join(" | ")}`);
    }
  } else {
    lines.push("• No faction board visible. The system stands, even if the board is dark.");
  }
  return appendTickLine(lines.join("\n"), extractTimestamp(sysDoc, factionsDoc));
}
function formatFactionInSystem(systemName, factionsDoc, factionFilter){
  const list=factionsDoc?.factions||[]; if(!list.length) return `No faction board in sight for **${systemName}**.`;
  const matches = list.filter(f => !factionFilter || (f.name||"").toLowerCase()===factionFilter.toLowerCase());
  if(!matches.length) return `No presence for **${factionFilter}** in **${systemName}**.`;
  const lines = matches.map(f=>{
    const name=canonicalizeName(f.name);
    const parts=[`**${name}** in **${systemName}** — Influence: ${pctFromUnit(f.influence)}`];
    if(f.state) parts.push(`state: ${f.state}`);
    if(Array.isArray(f.pendingStates)&&f.pendingStates.length) parts.push(`pending: ${f.pendingStates.map(x=>x.state).join(", ")}`);
    if(Array.isArray(f.recoveringStates)&&f.recoveringStates.length) parts.push(`recovering: ${f.recoveringStates.map(x=>x.state).join(", ")}`);
    if(systemName.toLowerCase()==="ltt 14850" && name==="Black Sun Crew") parts.push(SPACEFORCE_OVERRIDES.ltt14850["Black Sun Crew"].note);
    return parts.join(" | ");
  });
  return appendTickLine(lines.join("\n"), extractTimestamp(factionsDoc));
}
function formatStations(systemName, stationsDoc, limit=MAX_LINES){
  const arr=stationsDoc?.stations||[]; if(!arr.length) return `No stations recorded in **${systemName}** at hand.`;
  const lines=[`**${systemName} — Stations** (up to ${limit})`];
  lines.push(...arr.slice(0,limit).map(s=>{
    const owner=canonicalizeName(s.controllingFaction?.name || s.controllingMinorFaction || s.faction || "Unknown");
    const flags=[s.haveMarket&&"market", s.haveShipyard&&"shipyard", s.haveOutfitting&&"outfitting"].filter(Boolean).join(", ");
    return `• ${s.name} — ${s.type||"?"} | Owner: ${owner}${flags?` | ${flags}`:""}`;
  }));
  return appendTickLine(lines.join("\n"), extractTimestamp(stationsDoc));
}
function formatBodies(systemName, bodiesDoc, limit=MAX_LINES){
  const list=bodiesDoc?.bodies||[]; if(!list.length) return `No bodies listed for **${systemName}** at hand.`;
  const lines=[`**${systemName} — Bodies** (sample up to ${limit})`];
  lines.push(...list.slice(0,limit).map(b=>{
    const kind=b.type||b.subType||"?";
    const grav=(b.gravity!=null)?`${(b.gravity.toFixed?b.gravity.toFixed(2):b.gravity)}g`
              :(b.surfaceGravity!=null)?`${(b.surfaceGravity.toFixed?b.surfaceGravity.toFixed(2):b.surfaceGravity)}g`:"?";
    const mats=Array.isArray(b.materials)?b.materials.slice(0,4).map(m=>`${m.name} ${Math.round(m.percentage)}%`).join(", "):"";
    return `• ${b.name}: ${kind}${grav?` | gravity: ${grav}`:""}${mats?` | mats: ${mats}`:""}`;
  }));
  return appendTickLine(lines.join("\n"), extractTimestamp(bodiesDoc));
}
function formatTrafficDeaths(systemName, trafficDoc, deathsDoc){
  const t=trafficDoc||{}, d=deathsDoc||{};
  const tDay=t?.traffic?.day ?? "?", tWeek=t?.traffic?.week ?? "?";
  const dDay=d?.deaths?.day ?? "?", dWeek=d?.deaths?.week ?? "?";
  return appendTickLine(`**${systemName} — Activity**\n• Traffic: ${tDay} (24h), ${tWeek} (7d)\n• Deaths: ${dDay} (24h), ${dWeek} (7d)`, extractTimestamp(trafficDoc, deathsDoc));
}

// ---------- Archive (BGS Guide; cached) ----------
let BGS_ARCHIVE=null;
function _tok(s){ return (s||"").toLowerCase().replace(/[^a-z0-9\s\-]/g," ").split(/\s+/).filter(w=>w.length>2); }
function _idfScore(qTokens,text,idf){ const words=_tok(text), tf={}; for(const w of words) tf[w]=(tf[w]||0)+1; let s=0; for(const q of qTokens) s+=(tf[q]||0)*(idf[q]||1); return s/Math.sqrt(words.length||1); }
function highlight(s,terms){ let out=s; for(const t of terms){ const re=new RegExp(`\\b(${t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})\\b`,"ig"); out=out.replace(re,"**$1**"); } return out; }
async function loadArchive(){
  if(BGS_ARCHIVE) return BGS_ARCHIVE;
  try{
    const c = await fetchJSONCached(BGS_CHUNKS_URL, "archive");
    const i = await fetchJSONCached(BGS_INDEX_URL, "archive");
    const chunks = c.json || [];
    const idx = i.json || {};
    BGS_ARCHIVE={chunks, idf:idx.idf||{}, N:idx.N||chunks.length}; return BGS_ARCHIVE;
  }catch{
    return { chunks:[], idf:{}, N:0 };
  }
}
async function archiveSearch(query,limit=5){
  const {chunks,idf}=await loadArchive(); const terms=_tok(query);
  if(!terms.length||!chunks.length) return [];
  const scored=chunks.map(c=>({ c, s:_idfScore(terms,c.text,idf) +
      (c.systems||[]).reduce((a,s)=>a+(query.toLowerCase().includes(String(s).toLowerCase())?1:0),0) +
      (c.factions||[]).reduce((a,f)=>a+(query.toLowerCase().includes(String(f).toLowerCase())?1:0),0)
    }))
    .sort((a,b)=>b.s-a.s).slice(0,limit).filter(x=>x.s>0.25)
    .map(x=>({ page:x.c.page, snippet:x.c.text.length>520?x.c.text.slice(0,520)+"…":x.c.text, terms }));
  return scored;
}

// ---------- Markets (optional relay; cached) ----------
async function marketFor(system, station){
  if (!MARKET_API_BASE) return { error: "disabled" };
  const url = `${MARKET_API_BASE}/market?system=${encodeURIComponent(system)}&station=${encodeURIComponent(station)}`;
  return fetchJSONCached(url, "market");
}
async function commodityNear(commodity, near, maxLy=30){
  if (!MARKET_API_BASE) return { error: "disabled" };
  const url = `${MARKET_API_BASE}/find?commodity=${encodeURIComponent(commodity)}&near=${encodeURIComponent(near)}&maxLy=${encodeURIComponent(maxLy)}`;
  return fetchJSONCached(url, "market");
}

// ---------- NLU router (DeepSeek-friendly) ----------
function parseQuery(qRaw){
  const q=(qRaw||"").toLowerCase();

  // Forced router keywords for testing / forcing runs
  if(/^ping$/.test(q)) return { intent:"bgs_ping" };
  if(/^diag\b|^debug\b|diagnostic/.test(q)) return { intent:"debug" };

  const mCmdr = q.match(/\b(?:cmdr|commander)\s+([a-z0-9 _\-]+)\b/i);
  if(mCmdr) return { intent:"commander_profile", name:mCmdr[1].trim() };

  let sys=null; for(const k of Object.keys(SYSTEM_ALIASES)) if(q.includes(k)) sys=SYSTEM_ALIASES[k];
  const mLTT=q.match(/\bltt[-\s]?([0-9]{4,5})\b/i); if(mLTT) sys=`LTT ${mLTT[1]}`;
  const mSys=q.match(/\b(?:in|system|for)\s+([A-Za-z0-9\- ]{3,})\b/i); if(mSys&&!sys) sys=mSys[1];

  let faction=""; if(q.includes("black sun crew")) faction="Black Sun Crew";
  else if(q.includes("oblivion fleet")) faction="Oblivion Fleet";
  else if(q.includes("space force")) faction="Space Force";
  else { const mf=q.match(/\bfaction\s+([a-z0-9\- ']+)\b/i); if(mf) faction=mf[1].trim(); }

  const wantsMarket=/\bmarket|prices|sell price|buy price|where to buy|where to sell|profit\b/i.test(q);
  const mStation=q.match(/\b(?:at|station)\s+([A-Za-z0-9\- ']{3,})\b/i);
  const mCommodity=q.match(/\b(?:commodity|good|buy|sell)\s+([A-Za-z0-9\- ']{2,})\b/i);

  const wantsArchive=/\b(guide|manual|how does|why does|bgs report|archive|history|explain|mechanics|doctrine)\b/i.test(q);
  const wantsIntel=/\b(intel|sitrep|overview|brief|snapshot)\b/i.test(q);
  const wantsSystem=/system (status|snapshot)|what'?s happening in|status of|overview/i.test(q);
  const wantsInfluence=/influence|who (controls?|owns?)|percent|share|states?\b/i.test(q);
  const wantsStations=/\b(station|stations|port|outpost|carrier)\b/i.test(q);
  const wantsBodies=/\b(bodies|planets?|moons?)\b/i.test(q);
  const wantsActivity=/\b(traffic|deaths|activity)\b/i.test(q);

  if(wantsArchive) return { intent:"bgs_archive_search", q:qRaw };

  if(wantsMarket && MARKET_API_BASE){
    if(mStation&&sys) return { intent:"station_market", system:sys, station:mStation[1].trim() };
    if(mCommodity&&sys) return { intent:"commodity_search", commodity:mCommodity[1].trim(), near:sys };
  }

  if((wantsSystem||wantsInfluence)&&sys&&faction) return { intent:"faction_status", system:sys, faction };
  if(wantsIntel&&sys) return { intent:"system_intel", system:sys };
  if(wantsSystem&&sys) return { intent:"system_status", system:sys };
  if(wantsStations&&sys) return { intent:"station_status", system:sys };
  if(wantsBodies&&sys) return { intent:"bodies_status", system:sys };
  if(wantsActivity&&sys) return { intent:"activity_status", system:sys };

  if(faction&&sys) return { intent:"faction_status", system:sys, faction };
  if(sys) return { intent:"system_status", system:sys };
  if(faction) return { intent:"faction_status", system:"", faction };

  return { intent:"unknown" };
}

// ---------- MAIN ----------
export async function run(input){
  console.log(`[${APP_NAME}] v${APP_VERSION} input=`, JSON.stringify(input||{}, null, 2));

  try{
    if(!rateOk("guild")) return "Comms are saturated. One at a time, and we’ll get you your snapshot.";

    const rawQ = input?.q || "";
    let intent = input?.intent;
    if(!intent || intent==="unknown"){ const routed=parseQuery(rawQ); input={...input,...routed}; intent=input.intent; }

    const debugRequested=/\bdebug|diag|diagnostic\b/i.test(rawQ);
    const isAdmin=Array.from(ADMINS).some(nm=>(rawQ||"").toLowerCase().includes(nm.toLowerCase())) || Boolean(input?.debug);

    // Health check
    if(intent==="bgs_ping") return `Applet online — ${APP_NAME} v${APP_VERSION}`;

    // Cache / LRU stats (optional)
    if (/^cache stats?$/.test((input?.q||"").toLowerCase())) {
      return `Cache entries: ${_CACHE.size} | Max: ${CACHE_MAX_ENTRIES}
BGS TTL: ${TTL.bgs/60000}m | EDSM TTL: ${TTL.edsm/60000}m | INARA TTL: ${TTL.inara/60000}m | Archive TTL: ${TTL.archive/3600000}h`;
    }

    if(debugRequested&&isAdmin) return "DEBUG " + JSON.stringify({ routed: input }, null, 2);

    // Commander (INARA)
    if(intent==="commander_profile"){
      const name=norm(input?.name); if(!okStr(name)) return loreErrorLine("notfound");
      const res = await inaraCommanderProfile(name);
      if(res.error) return loreErrorLine(res.error);
      return formatCommander(res.event);
    }

    // System snapshot — EliteBGS then EDSM
    if(intent==="system_status"){
      const sys=canonicalizeSystem(norm(input?.system)); if(!okStr(sys)) return loreErrorLine("notfound");
      const bgs=await bgsSystem(sys);
      if(!bgs.error && Array.isArray(bgs.json) && bgs.json.length){
        const mapped=mapBgsSystemToSnapshot(bgs.json);
        return formatSystemSnapshot(mapped.sysDoc, mapped.facDoc);
      }
      const [sysRes,facRes]=await Promise.all([edsmSystem(sys),edsmSystemFactions(sys)]);
      if(sysRes.error && !ALLOW_STALE) return loreErrorLine("network");
      return formatSystemSnapshot(sysRes.json || { name: sys }, facRes.error ? null : facRes.json);
    }

    // Faction status — EliteBGS first
    if(intent==="faction_status"){
      const sys=canonicalizeSystem(norm(input?.system||""));
      const faction=canonicalizeName(norm(input?.faction));
      if(!okStr(faction)) return loreErrorLine("notfound");

      if(okStr(sys)){
        const [bgsSys,bgsFac]=await Promise.all([bgsSystem(sys), bgsFaction(faction)]);
        if(!bgsSys.error && !bgsFac.error && Array.isArray(bgsSys.json) && bgsSys.json.length){
          const mapped=mapBgsSystemToSnapshot(bgsSys.json);
          const fromFac=pickFactionInSystemFromBgs(faction,bgsFac.json,sys);
          if(fromFac){
            const facDoc={ factions:[fromFac], factionsUpdated:mapped.facDoc?.factionsUpdated };
            return formatFactionInSystem(sys, facDoc, faction);
          }
          return formatFactionInSystem(sys, mapped.facDoc, faction);
        }
        const facFallback = await edsmSystemFactions(sys);
        if(facFallback.error && !ALLOW_STALE) return loreErrorLine("network");
        return formatFactionInSystem(sys, facFallback.json || {factions:[]}, faction);
      }
      return `Name the system for ${faction}, and I’ll pull their standing there.`;
    }

    // Full intel bundle
    if(intent==="system_intel"){
      const sys=canonicalizeSystem(norm(input?.system)); if(!okStr(sys)) return loreErrorLine("notfound");

      let display=sys, headerBlock="", facDocForBsc=null;
      const bgs=await bgsSystem(sys);
      if(!bgs.error && Array.isArray(bgs.json) && bgs.json.length){
        const mapped=mapBgsSystemToSnapshot(bgs.json);
        display=mapped.sysDoc.name||sys;
        headerBlock=formatSystemSnapshot(mapped.sysDoc, mapped.facDoc);
        facDocForBsc=mapped.facDoc;
      } else {
        const [sysRes,facRes]=await Promise.all([edsmSystem(sys),edsmSystemFactions(sys)]);
        display=sysRes.json?.name||sys;
        headerBlock=sysRes.error?`**${display}** — Intel line held. Using known boards.`:formatSystemSnapshot(sysRes.json, facRes.error?null:facRes.json);
        facDocForBsc=facRes.error?null:facRes.json;
      }

      const blocks=[headerBlock];
      if(facDocForBsc?.factions?.length){
        const bscLine=formatFactionInSystem(display, facDocForBsc, "Black Sun Crew");
        if(!/No presence/i.test(bscLine)) blocks.push(bscLine);
      }

      const [stnRes,bodRes,traffRes,deathRes]=await Promise.all([edsmSystemStations(display),edsmSystemBodies(display),edsmTraffic(display),edsmDeaths(display)]);
      blocks.push(stnRes.error?"Stations: board not responding.":formatStations(display, stnRes.json, 10));
      blocks.push(bodRes.error?"Bodies: charts unavailable; use nav scanners.":formatBodies(display, bodRes.json, 8));
      blocks.push((traffRes.error||deathRes.error)?"Activity: sensor history thin. Fly attentive.":formatTrafficDeaths(display, traffRes.json, deathRes.json));

      if(SHOW_TEACH_SNIPPETS){
        const picks=await archiveSearch(`influence states ${display}`,1);
        if(picks.length){ const p=picks[0]; blocks.push(`**Doctrine**\n${highlight(p.snippet,p.terms)}\n_Source: Squadron archive (static), p.${p.page}_`); }
      }
      return blocks.join("\n\n");
    }

    // Stations / Bodies / Activity (EDSM)
    if(intent==="station_status"){
      const sys=canonicalizeSystem(norm(input?.system)); if(!okStr(sys)) return loreErrorLine("notfound");
      const {json,error}=await edsmSystemStations(sys); if(error && !ALLOW_STALE) return loreErrorLine("network");
      return formatStations(sys, json||{stations:[]});
    }
    if(intent==="bodies_status"){
      const sys=canonicalizeSystem(norm(input?.system)); if(!okStr(sys)) return loreErrorLine("notfound");
      const {json,error}=await edsmSystemBodies(sys); if(error && !ALLOW_STALE) return loreErrorLine("network");
      return formatBodies(sys, json||{bodies:[]});
    }
    if(intent==="activity_status"){
      const sys=canonicalizeSystem(norm(input?.system)); if(!okStr(sys)) return loreErrorLine("notfound");
      const [traff,death]=await Promise.all([edsmTraffic(sys), edsmDeaths(sys)]);
      if((traff.error||death.error) && !ALLOW_STALE) return loreErrorLine("network");
      return formatTrafficDeaths(sys, traff.json||{}, death.json||{});
    }

    // Markets (optional relay)
    if(intent==="station_market"){
      if(!MARKET_API_BASE) return "Market relays are offline for this channel. Ask an officer to enable them.";
      const sys=canonicalizeSystem(norm(input?.system)), station=norm(input?.station);
      if(!okStr(sys)||!okStr(station)) return "Name both the system and station.";
      const {json,error}=await marketFor(sys,station); if(error) return loreErrorLine("network");
      if(!json?.commodities?.length) return `No market board visible for **${station}**, **${sys}**.`;
      const top=json.commodities.filter(c=>c.sell!=null).sort((a,b)=>(b.sell??0)-(a.sell??0)).slice(0,12)
        .map(c=>`• ${c.name}: sell ${c.sell}cr | buy ${c.buy??"—"}cr | supply ${c.supply??"?"} | demand ${c.demand??"?"}`).join("\n");
      const head=`**Market — ${json.station}, ${json.system}**`;
      const stamp=json.updatedAt?new Date(json.updatedAt).toISOString():null;
      return appendTickLine(`${head}\n${top}`, stamp);
    }
    if(intent==="commodity_search"){
      if(!MARKET_API_BASE) return "Commodity searches are offline; market relay not enabled.";
      const commodity=norm(input?.commodity), near=canonicalizeSystem(norm(input?.near)), maxLy=Number(input?.maxLy||30);
      if(!okStr(commodity)||!okStr(near)) return "Name the commodity and the reference system.";
      const {json,error}=await commodityNear(commodity,near,maxLy); if(error) return loreErrorLine("network");
      const list=(json?.results||[]).slice(0,12).map(r=>`• ${r.station} — ${r.system} (${r.distLy}ly) | sell ${r.sell??"—"} | buy ${r.buy??"—"} | supply ${r.supply??"?"}`);
      if(!list.length) return `No ${commodity} hits within ${maxLy}ly of ${near}.`;
      return `**${commodity} near ${near} (${maxLy}ly)**\n`+list.join("\n");
    }

    // Archive (what/why/how)
    if(intent==="bgs_archive_search"){
      const q=String(input?.q||"").trim();
      const looksLive=/\b(influence|current|today|now|pending|recovering|who controls)\b/i.test(q);
      const mSys=q.match(/\b(?:in|system|for)\s+([A-Za-z0-9\- ]{3,})\b/i);
      let preface="";
      if(looksLive && mSys){
        const system=canonicalizeSystem(mSys[1]);
        const bgs=await bgsSystem(system);
        if(!bgs.error && Array.isArray(bgs.json)&&bgs.json.length){
          const mapped=mapBgsSystemToSnapshot(bgs.json);
          preface=formatSystemSnapshot(mapped.sysDoc,mapped.facDoc)+`\n\n`;
        }else{
          preface=loreErrorLine("network")+`\n(Attempted live read for **${system}**)`+"\n\n";
        }
      }
      const picks=await archiveSearch(q,5);
      if(!picks.length) return preface+"The archive is quiet on that. Try a different keyword or name a system/faction/state.";
      const lines=picks.map(p=>`• p.${p.page}\n${highlight(p.snippet,p.terms)}`).join("\n\n");
      return preface+`**Archive excerpts**\n${lines}\n\n_Last update: squadron archive (static). Source: “Complete BGS Guide 2025 v3.0” (CC BY-NC-SA)._`;
    }

    // Fallback help
    return "Say the word. System intel, faction standing, stations, bodies, activity, a commander’s record, markets (if enabled), or the BGS archive for what/why/how.";
  }catch(e){
    console.log(`[${APP_NAME}] ERROR`, e?.stack || String(e));
    return loreErrorLine("unknown");
  }
}
