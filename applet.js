// applet.js
// Kael Veyran — SpaceForce Intel Applet (v4.0)
// Live intel (EDSM + INARA) + Archive search (static guide JSON from GitHub)
// Lore-friendly errors, applet-first policy, allow-stale with timestamp line.

// ====== CONFIG ======
const INARA_API = "https://inara.cz/inapi/v1/";
const EDSM_SYS_API = "https://www.edsm.net/api-v1";
const EDSM_SYSTEM_API = "https://www.edsm.net/api-system-v1";

// TODO: set these to your repo raw URLs (branch can be main or master)
const RAW = "https://raw.githubusercontent.com/<USER>/<REPO>/<BRANCH>/data";
const BGS_CHUNKS_URL = `${RAW}/bgs_chunks.json`;
const BGS_INDEX_URL  = `${RAW}/bgs_index.json`;

// INARA key is injected by AICord secrets: add a secret named INARA_API_KEY
const APP_NAME = "SpaceForce-IntelApplet";
const APP_VERSION = "4.0.0";
const UA = { "User-Agent": "SpaceForce-IntelApplet/4.0 (+EDSM+INARA)" };
const HTTP_TIMEOUT_MS = 10000;

const LORE_ERRORS = true;    // convert technical failures into in-universe lines
const ALLOW_STALE = true;    // never refuse data for being old
const ENFORCE_LORE_ACCURACY = true; // never invent numbers; prefer applet results

// ====== CANONICALIZATION ======
const CANONICAL_NAMES = {
  "black sun crew": "Black Sun Crew",
  "space force": "Space Force",
  "oblivion fleet": "Oblivion Fleet",
  "jerome archer": "Jerome Archer",
  "bsc": "Black Sun Crew"
};
const SYSTEM_ALIASES = {
  "14850": "LTT 14850",
  "ltt14850": "LTT 14850",
  "ltt 14850": "LTT 14850",
  "ltt-14850": "LTT 14850",
  "guragwe": "Guragwe",
  "alrai sector fw-v b2-2": "Alrai Sector FW-V b2-2"
};
const SPACEFORCE_OVERRIDES = {
  ltt14850: { "Black Sun Crew": { note: "Black Sun Crew cannot retreat in LTT 14850 (home system)." } }
};

// ====== HELPERS ======
function norm(s){ return typeof s === "string" ? s.trim() : s; }
function okStr(s){ return typeof s === "string" && s.trim().length > 0; }
function timeout(ms){ return new Promise((_,rej)=>setTimeout(()=>rej(new Error(`timeout ${ms}ms`)), ms)); }
async function fetchWithTimeout(url, opts={}, ms=HTTP_TIMEOUT_MS){ return Promise.race([fetch(url, opts), timeout(ms)]); }
function canonicalizeName(raw){ if (!raw) return raw; const k = raw.toLowerCase().trim(); return CANONICAL_NAMES[k] || raw; }
function canonicalizeSystem(raw){
  if (!raw) return raw;
  const key = raw.toLowerCase().trim();
  if (SYSTEM_ALIASES[key]) return SYSTEM_ALIASES[key];
  const m = key.match(/\bltt[-\s]?(\d{4,5})\b/i);
  if (m) return `LTT ${m[1]}`;
  return raw;
}
function pctFromUnit(n){ if (typeof n !== "number") return "N/A"; const v=(n>=0&&n<=1)?n*100:n; return `${v.toFixed(1)}%`; }
function listStates(arr){ if (!Array.isArray(arr)||!arr.length) return "None"; return arr.map(s=>s.state||s.name||s).join(", "); }
function nowISO(){ return new Date().toISOString(); }
function msToAgo(ms){ const s=Math.max(0, Math.floor(ms/1000)); const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60); if(d) return `${d}d ${h}h`; if(h) return `${h}h ${m}m`; return `${m}m`; }
function loreErrorLine(kind){
  if (!LORE_ERRORS) return kind;
  switch(kind){
    case "network": return "The lines are jammed. I’ll use what intel we have on hand.";
    case "parse":   return "Data feed came through scrambled. Falling back to known records.";
    case "unknown": return "Intel link flickered. Using stored reports.";
    case "notfound":return "No records on that one. Check the name and I’ll re-run the scan.";
    default:        return "The void answers quiet. Using what we’ve got.";
  }
}
function appendTickLine(text, ts){
  if (!ts) return text;
  const when = (typeof ts === "number") ? new Date(ts) : new Date(String(ts));
  if (isNaN(when.getTime())) return text;
  const age = Date.now() - when.getTime();
  return `${text}\n_Last update: ${when.toISOString()} (${msToAgo(age)} ago)_`;
}
function extractTimestamp(...objs){
  for (const o of objs||[]){
    if (!o) continue;
    const cands = [
      o.lastUpdate, o.factionsUpdated, o.updated_at, o.updateTime, o.date, o.dateLastUpdate,
      o.information?.lastUpdate, o.deaths?.lastDay, o.traffic?.lastDay
    ];
    for (const c of cands){ if (c) return c; }
  }
  return null;
}

// ====== INARA (Commander) ======
async function callInara(eventName, eventData){
  const body = {
    header: { appName: APP_NAME, appVersion: APP_VERSION, isBeingDeveloped: false, APIkey: "{{INARA_API_KEY}}" },
    events: [{ eventName, eventTimestamp: nowISO(), eventData }]
  };
  try{
    const res = await fetchWithTimeout(INARA_API, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return { error: "network", status: res.status };
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { return { error: "parse" }; }
    const ev = json?.events?.[0]; if (!ev) return { error: "parse" };
    return { event: ev, raw: json };
  } catch { return { error: "network" }; }
}
function formatCommander(ev){
  if (ev.eventStatus === 204) return loreErrorLine("notfound");
  if (ev.eventStatus !== 200)  return loreErrorLine("unknown");
  const d = ev.eventData || {};
  const name = canonicalizeName(d.commanderName || d.userName || "Unknown CMDR");
  const ranks = Array.isArray(d.commanderRanksPilot)&&d.commanderRanksPilot.length
    ? d.commanderRanksPilot.map(r=>`${r.rankName}: ${r.rankValue}${r.rankProgress!=null?` (${Math.round(r.rankProgress*100)}%)`:""}`).join(", ")
    : "N/A";
  const squad = d.commanderSquadron?.SquadronName || "N/A";
  const squadURL = d.commanderSquadron?.inaraURL || "";
  const profileURL = d.inaraURL || "";
  let out = [`**${name}**`, `Ranks: ${ranks}`, `Squadron: ${canonicalizeName(squad)}`];
  if (squadURL) out.push(`Squadron page: ${squadURL}`);
  if (profileURL) out.push(`INARA profile: ${profileURL}`);
  return out.join("\n");
}
async function squadronQuicklink(name){
  const { error, event } = await callInara("getCommanderProfile", { searchName: name });
  if (error) return loreErrorLine(error);
  if (event.eventStatus !== 200) return loreErrorLine("unknown");
  const url = event?.eventData?.commanderSquadron?.inaraURL;
  return url ? `Squadron link: ${url}` : "No squadron record visible.";
}

// ====== EDSM (Systems / Factions / Stations / Bodies / Traffic / Deaths) ======
async function edsmJSON(url){
  try{
    const res = await fetchWithTimeout(url, { headers: UA });
    if (!res.ok) return { error: "network", status: res.status };
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { return { error: "parse" }; }
    return { json };
  } catch { return { error: "network" }; }
}
async function edsmSystem(system){ const s = encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYS_API}/system?systemName=${s}&showInformation=1&showPrimaryStar=1&showCoordinates=1&showPermit=1`); }
async function edsmSystemFactions(system){ const s = encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYSTEM_API}/factions?systemName=${s}`); }
async function edsmSystemStations(system){ const s = encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYSTEM_API}/stations?systemName=${s}`); }
async function edsmSystemBodies(system){ const s = encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYSTEM_API}/bodies?systemName=${s}`); }
async function edsmTraffic(system){ const s = encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYSTEM_API}/traffic?systemName=${s}`); }
async function edsmDeaths(system){ const s = encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYSTEM_API}/deaths?systemName=${s}`); }

// ====== FORMATTERS ======
function formatSystemSnapshot(sysDoc, factionsDoc){
  if (!sysDoc || sysDoc.name == null) return loreErrorLine("notfound");
  const info = sysDoc.information || {};
  const header = `**${sysDoc.name}** — Allegiance: ${info.allegiance||"?"}, Gov: ${info.government||"?"}, Pop: ${info.population??"?"}`;
  const lines = [header];

  const factions = factionsDoc?.factions || [];
  if (Array.isArray(factions) && factions.length){
    for (const f of factions){
      const name = canonicalizeName(f.name || "Unknown Faction");
      const inf = pctFromUnit(f.influence);
      const parts = [`• ${name}: ${inf}`];
      if (f.state) parts.push(`state: ${f.state}`);
      if (Array.isArray(f.pendingStates) && f.pendingStates.length) parts.push(`pending: ${f.pendingStates.map(x=>x.state).join(", ")}`);
      if (Array.isArray(f.recoveringStates) && f.recoveringStates.length) parts.push(`recovering: ${f.recoveringStates.map(x=>x.state).join(", ")}`);
      if (sysDoc.name.toLowerCase()==="ltt 14850" && name==="Black Sun Crew") parts.push(SPACEFORCE_OVERRIDES.ltt14850["Black Sun Crew"].note);
      lines.push(parts.join(" | "));
    }
  } else {
    lines.push("• No faction board visible. The system stands, even if the board is dark.");
  }
  const ts = extractTimestamp(sysDoc, factionsDoc);
  return appendTickLine(lines.join("\n"), ts);
}
function formatFactionInSystem(systemName, factionsDoc, factionFilter){
  const list = factionsDoc?.factions || [];
  if (!list.length) return `No faction board in sight for **${systemName}**.`;
  const matches = list.filter(f => !factionFilter || (f.name||"").toLowerCase() === factionFilter.toLowerCase());
  if (!matches.length) return `No presence for **${factionFilter}** in **${systemName}**.`;
  const out = matches.map(f => {
    const name = canonicalizeName(f.name);
    const inf = pctFromUnit(f.influence);
    const parts = [`**${name}** in **${systemName}** — Influence: ${inf}`];
    if (f.state) parts.push(`state: ${f.state}`);
    if (Array.isArray(f.pendingStates) && f.pendingStates.length) parts.push(`pending: ${f.pendingStates.map(x=>x.state).join(", ")}`);
    if (Array.isArray(f.recoveringStates) && f.recoveringStates.length) parts.push(`recovering: ${f.recoveringStates.map(x=>x.state).join(", ")}`);
    if (systemName.toLowerCase()==="ltt 14850" && name==="Black Sun Crew") parts.push(SPACEFORCE_OVERRIDES.ltt14850["Black Sun Crew"].note);
    return parts.join(" | ");
  }).join("\n");
  const ts = extractTimestamp(factionsDoc);
  return appendTickLine(out, ts);
}
function formatStations(systemName, stationsDoc, limit=8){
  const arr = stationsDoc?.stations || [];
  if (!arr.length) return `No stations recorded in **${systemName}** at hand.`;
  const head = `**${systemName} — Stations** (up to ${limit})`;
  const lines = arr.slice(0, limit).map(s=>{
    const owner = canonicalizeName(s.controllingFaction?.name || s.controllingMinorFaction || s.faction || "Unknown");
    const flags = [ s.haveMarket && "market", s.haveShipyard && "shipyard", s.haveOutfitting && "outfitting" ].filter(Boolean).join(", ");
    return `• ${s.name} — ${s.type || "?"} | Owner: ${owner}${flags?` | ${flags}`:""}`;
  });
  const ts = extractTimestamp(stationsDoc);
  return appendTickLine([head, ...lines].join("\n"), ts);
}
function formatBodies(systemName, bodiesDoc, limit=8){
  const list = bodiesDoc?.bodies || [];
  if (!list.length) return `No bodies listed for **${systemName}** at hand.`;
  const head = `**${systemName} — Bodies** (sample up to ${limit})`;
  const items = list.slice(0, limit).map(b=>{
    const kind = b.type || b.subType || "?";
    const grav = (b.gravity!=null) ? `${(b.gravity.toFixed ? b.gravity.toFixed(2) : b.gravity)}g`
                 : (b.surfaceGravity!=null ? `${(b.surfaceGravity.toFixed ? b.surfaceGravity.toFixed(2) : b.surfaceGravity)}g` : "?");
    const mats = Array.isArray(b.materials) ? b.materials.slice(0,4).map(m=>`${m.name} ${Math.round(m.percentage)}%`).join(", ") : "";
    return `• ${b.name}: ${kind}${grav?` | gravity: ${grav}`:""}${mats?` | mats: ${mats}`:""}`;
  });
  const ts = extractTimestamp(bodiesDoc);
  return appendTickLine([head, ...items].join("\n"), ts);
}
function formatTrafficDeaths(systemName, trafficDoc, deathsDoc){
  const t = trafficDoc || {}; const d = deathsDoc || {};
  const tDay = t?.traffic?.day ?? "?"; const tWeek = t?.traffic?.week ?? "?";
  const dDay = d?.deaths?.day ?? "?"; const dWeek = d?.deaths?.week ?? "?";
  const ts = extractTimestamp(trafficDoc, deathsDoc);
  return appendTickLine(`**${systemName} — Activity**\n• Traffic: ${tDay} (24h), ${tWeek} (7d)\n• Deaths: ${dDay} (24h), ${dWeek} (7d)`, ts);
}

// ====== ARCHIVE (Guide) ======
let BGS_ARCHIVE=null;
function _tok(s){ return (s||"").toLowerCase().replace(/[^a-z0-9\s\-]/g," ").split(/\s+/).filter(w=>w.length>2); }
function _score(qTokens, text, idf){
  const words = _tok(text), tf={}; for(const w of words) tf[w]=(tf[w]||0)+1;
  let s=0; for(const q of qTokens) s+= (tf[q]||0) * (idf[q]||1);
  return s / Math.sqrt(words.length||1);
}
function highlight(s, terms){
  let out=s; for(const t of terms){
    const re=new RegExp(`\\b(${t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})\\b`,"ig");
    out = out.replace(re,"**$1**");
  } return out;
}
async function loadArchive(){
  if (BGS_ARCHIVE) return BGS_ARCHIVE;
  try{
    const [cRes, iRes] = await Promise.all([fetchWithTimeout(BGS_CHUNKS_URL, {headers:UA}), fetchWithTimeout(BGS_INDEX_URL, {headers:UA})]);
    const chunks = JSON.parse(await cRes.text());
    const idx = JSON.parse(await iRes.text());
    BGS_ARCHIVE = { chunks, idf: idx.idf||{}, N: idx.N||chunks.length };
    return BGS_ARCHIVE;
  }catch{ return { chunks: [], idf: {}, N: 0 }; }
}

// ====== NLU ROUTER ======
function parseQuery(qRaw){
  const q = (qRaw||"").toLowerCase();

  const sys = (() => {
    for (const key of Object.keys(SYSTEM_ALIASES)) if (q.includes(key)) return SYSTEM_ALIASES[key];
    const m = q.match(/\bltt[-\s]?([0-9]{4,5})\b/); if (m) return `LTT ${m[1]}`;
    const s = q.match(/\b(?:system|in)\s+([a-z0-9\- ']+)\b/i); return s ? s[1] : "";
  })();

  const cmdr = (() => {
    let m = q.match(/\bcmdr\s+([a-z0-9 _\-]+)\b/i) || q.match(/\bcommander\s+([a-z0-9 _\-]+)\b/i);
    if (m) return m[1].trim();
    m = q.match(/\bwho\s+is\s+([a-z0-9 _\-]+)\b/i);
    return m ? m[1].trim() : "";
  })();

  const faction = (() => {
    const m = q.match(/\bfaction\s+([a-z0-9\- ']+)\b/i);
    if (m) return m[1].trim();
    if (q.includes("black sun crew")) return "Black Sun Crew";
    if (q.includes("oblivion fleet")) return "Oblivion Fleet";
    if (q.includes("space force")) return "Space Force";
    return "";
  })();

  const wantsIntel = /\b(intel|sitrep|overview|brief|snapshot)\b/i.test(q);
  const wantsSystem = /system (status|snapshot)|what'?s happening in|status of|overview/i.test(q);
  const wantsInfluence = /influence|who (controls?|owns?)|percent|share|states/i.test(q);
  const wantsStations = /\b(station|stations|port|outpost|carrier)\b/i.test(q);
  const wantsBodies = /\b(bodies|planets?|moons?)\b/i.test(q);
  const wantsCmdr = /\b(cmdr|commander|who is)\b/i.test(q);
  const wantsArchive = /\b(guide|manual|how does|why does|bgs report|archive|history|explain|mechanics)\b/i.test(q);
  const wantsDebug = /\bdebug|diag|diagnostic\b/i.test(q);

  if (wantsDebug) return { intent:"debug" };
  if (wantsCmdr && cmdr) return { intent:"commander_profile", name: cmdr };
  if (wantsArchive) return { intent:"bgs_archive_search", q: qRaw };
  if ((wantsSystem || wantsInfluence) && sys && faction) return { intent:"faction_status", system: sys, faction };
  if (wantsIntel && sys) return { intent:"system_intel", system: sys };
  if (wantsSystem && sys) return { intent:"system_status", system: sys };
  if (wantsStations && sys) return { intent:"station_status", system: sys };
  if (wantsBodies && sys) return { intent:"bodies_status", system: sys };

  if (faction && sys) return { intent:"faction_status", system: sys, faction };
  if (sys) return { intent:"system_status", system: sys };
  if (faction) return { intent:"faction_status", system: "", faction };
  if (cmdr) return { intent:"commander_profile", name: cmdr };

  return { intent:"unknown" };
}

// ====== MAIN ======
export async function run(input){
  try{
    const debug = Boolean(input?.debug) || /debug|diag|diagnostic/i.test(input?.q||"");

    // Always route if intent is missing
    let intent = input?.intent;
    if (!intent || intent==="unknown"){
      const routed = parseQuery(input?.q||"");
      input = { ...input, ...routed };
      intent = input.intent;
    }

    if (debug) return "DEBUG " + JSON.stringify({ routed: input }, null, 2);

    // Commander (INARA)
    if (intent === "commander_profile"){
      const name = norm(input?.name);
      if (!okStr(name)) return loreErrorLine("notfound");
      const { error, event } = await callInara("getCommanderProfile", { searchName: name });
      if (error) return loreErrorLine(error);
      return formatCommander(event);
    }

    // Quick squadron link via CMDR (INARA)
    if (intent === "squadron_quicklink"){
      const name = norm(input?.name);
      if (!okStr(name)) return loreErrorLine("notfound");
      return await squadronQuicklink(name);
    }

    // Full system intel bundle
    if (intent === "system_intel"){
      const sys = canonicalizeSystem(norm(input?.system));
      if (!okStr(sys)) return loreErrorLine("notfound");
      const [sysRes, facRes, stnRes, bodRes, traffRes, deathRes] = await Promise.all([
        edsmSystem(sys), edsmSystemFactions(sys), edsmSystemStations(sys), edsmSystemBodies(sys), edsmTraffic(sys), edsmDeaths(sys)
      ]);

      const blocks = [];
      if (sysRes.error) blocks.push(loreErrorLine(sysRes.error));
      const displayName = sysRes.json?.name || sys;

      const sysBlock = sysRes.error ? `**${displayName}** — Intel line held. Using known boards.` : formatSystemSnapshot(sysRes.json, facRes.error ? null : facRes.json);
      blocks.push(sysBlock);

      const facDoc = facRes.error ? null : facRes.json;
      if (facDoc?.factions?.length){
        const bscLine = formatFactionInSystem(displayName, facDoc, "Black Sun Crew");
        if (!/No presence/i.test(bscLine)) blocks.push(bscLine);
      }

      blocks.push(stnRes.error ? "Stations: board not responding." : formatStations(displayName, stnRes.json, 6));
      blocks.push(bodRes.error ? "Bodies: charts unavailable; use nav scanners." : formatBodies(displayName, bodRes.json, 6));
      const actBlock = (traffRes.error || deathRes.error)
        ? "Activity: sensor history thin. Fly attentive."
        : formatTrafficDeaths(displayName, traffRes.json, deathRes.json);
      blocks.push(actBlock);

      return blocks.join("\n\n");
    }

    // System snapshot
    if (intent === "system_status"){
      const sys = canonicalizeSystem(norm(input?.system));
      if (!okStr(sys)) return loreErrorLine("notfound");
      const [{ json: sysDoc, error: e1 }, { json: facDoc, error: e2 }] = await Promise.all([edsmSystem(sys), edsmSystemFactions(sys)]);
      if (e1 && !ALLOW_STALE) return loreErrorLine(e1);
      return formatSystemSnapshot(sysDoc || { name: sys }, e2 ? null : facDoc);
    }

    // Faction status in a system
    if (intent === "faction_status"){
      const sys = canonicalizeSystem(norm(input?.system||""));
      const faction = canonicalizeName(norm(input?.faction));
      if (!okStr(faction)) return loreErrorLine("notfound");
      if (okStr(sys)){
        const { json: facDoc, error } = await edsmSystemFactions(sys);
        if (error && !ALLOW_STALE) return loreErrorLine(error);
        return formatFactionInSystem(sys, facDoc || { factions: [] }, faction);
      } else {
        return `Name the system for ${faction}, and I’ll pull their standing there.`;
      }
    }

    // Stations
    if (intent === "station_status"){
      const sys = canonicalizeSystem(norm(input?.system));
      if (!okStr(sys)) return loreErrorLine("notfound");
      const { json, error } = await edsmSystemStations(sys);
      if (error && !ALLOW_STALE) return loreErrorLine(error);
      return formatStations(sys, json || { stations: [] });
    }

    // Bodies
    if (intent === "bodies_status"){
      const sys = canonicalizeSystem(norm(input?.system));
      if (!okStr(sys)) return loreErrorLine("notfound");
      const { json, error } = await edsmSystemBodies(sys);
      if (error && !ALLOW_STALE) return loreErrorLine(error);
      return formatBodies(sys, json || { bodies: [] });
    }

    // Archive search (conceptual what/why/how)
    if (intent === "bgs_archive_search"){
      const q = String(input?.q||"").trim();

      // If the question looks "live", prefer a snapshot first, then add archive context.
      const looksLive = /\b(influence|current|today|now|pending|recovering|who controls)\b/i.test(q);
      const mSys = q.match(/\b(?:in|system|for)\s+([A-Za-z0-9\- ]{3,})\b/i);
      let preface = "";
      if (looksLive && mSys){
        const system = canonicalizeSystem(mSys[1]);
        const [{ json: sysDoc, error: e1 }, { json: facDoc, error: e2 }] = await Promise.all([edsmSystem(system), edsmSystemFactions(system)]);
        if (!e1 && !e2) preface = formatSystemSnapshot(sysDoc, facDoc) + "\n\n";
        else preface = loreErrorLine("network") + `\n(Attempted live read for **${system}**)` + "\n\n";
      }

      const { chunks, idf } = await loadArchive();
      const terms = _tok(q);
      if (!terms.length) return "Name a topic, system, faction, or state to search the squadron archive.";

      const scored = (chunks||[]).map(c=>{
        let boost = 0; const L=q.toLowerCase();
        for(const s of c.systems||[]) if (L.includes(String(s).toLowerCase())) boost += 1.0;
        for(const f of c.factions||[]) if (L.includes(String(f).toLowerCase())) boost += 1.0;
        for(const d of c.dates||[]) if (L.includes(String(d).toLowerCase())) boost += 0.3;
        return { c, s: _score(terms, c.text, idf||{}) + boost };
      }).sort((a,b)=>b.s-a.s);

      const top = scored.slice(0,5).filter(x=>x.s>0.25);
      if (!top.length) return preface + "The archive is quiet on that. Try a different keyword or name a system/faction/state.";

      const lines = top.map(x=>{
        const sn = x.c.text.length>520 ? x.c.text.slice(0,520)+"…" : x.c.text;
        const tags = [];
        if (x.c.systems?.length) tags.push(`systems: ${x.c.systems.join(", ")}`);
        if (x.c.factions?.length) tags.push(`factions: ${x.c.factions.join(", ")}`);
        if (x.c.dates?.length) tags.push(`dates: ${x.c.dates.join(", ")}`);
        return `• p.${x.c.page}${tags.length?` (${tags.join(" | ")})`:""}\n${highlight(sn, terms)}`;
      }).join("\n\n");

      return preface + `**Archive excerpts**\n${lines}\n\n_Last update: squadron archive (static). Source: “Complete BGS Guide 2025 v3.0” (CC BY-NC-SA)._`;
    }

    // Fallback help
    return "Say the word. System intel, faction standing, stations, bodies, a commander’s record, or the BGS archive for what/why/how.";
  }catch(_e){
    return loreErrorLine("unknown");
  }
}
