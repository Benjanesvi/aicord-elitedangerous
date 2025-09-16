// applet.js
// Kael Veyran Intel — INARA + EDSM (v3.1)
// INARA: commander profiles. EDSM: systems, factions (with influence/states), stations, bodies, traffic/deaths.
// Docs: INARA (getCommanderProfile) https://inara.cz/elite/inara-api-docs/
//       EDSM Systems v1 & System v1 https://www.edsm.net/en/api-v1 , https://www.edsm.net/en/api-system-v1

const INARA_API = "https://inara.cz/inapi/v1/";
const EDSM_SYS_API = "https://www.edsm.net/api-v1";
const EDSM_SYSTEM_API = "https://www.edsm.net/api-system-v1";

const UA = { "User-Agent": "SpaceForce-IntelApplet/3.1 (+EDSM+INARA)" };

// Canonicalization
const CANONICAL_NAMES = {
  "black sun crew": "Black Sun Crew",
  "space force": "Space Force",
  "oblivion fleet": "Oblivion Fleet",
  "jerome archer": "Jerome Archer"
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
  ltt14850: {
    "Black Sun Crew": { note: "Black Sun Crew cannot retreat in LTT 14850 (home system)." }
  }
};

function norm(s){ return typeof s === "string" ? s.trim() : s; }
function okStr(s){ return typeof s === "string" && s.trim().length > 0; }
function nowISO(){ return new Date().toISOString(); }
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

// ---------------- INARA (CMDR)
async function callInara(eventName, eventData){
  const body = {
    header: {
      appName: "SpaceForce-IntelApplet",
      appVersion: "3.1.0",
      isBeingDeveloped: false,
      APIkey: "{{INARA_API_KEY}}"
    },
    events: [{ eventName, eventTimestamp: nowISO(), eventData }]
  };
  try{
    const res = await fetch(INARA_API, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return { error: `INARA HTTP ${res.status}` };
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch(e){ return { error: `INARA parse error: ${e.message}` }; }
    const ev = json?.events?.[0]; if (!ev) return { error: "Malformed INARA response." };
    return { event: ev };
  } catch(e){ return { error: `INARA network error: ${e?.message||"unknown"}` }; }
}

function formatCommander(ev){
  if (ev.eventStatus === 204) return "No results found on INARA for that CMDR.";
  if (ev.eventStatus !== 200) return `INARA error ${ev.eventStatus}: ${ev.eventStatusText || "Unexpected response."}`;
  const d = ev.eventData || {};
  const name = canonicalizeName(d.commanderName || d.userName || "Unknown CMDR");
  const ranks = Array.isArray(d.commanderRanksPilot)&&d.commanderRanksPilot.length
    ? d.commanderRanksPilot.map(r=>`${r.rankName}: ${r.rankValue}${r.rankProgress!=null?` (${Math.round(r.rankProgress*100)}%)`:""}`).join(", ")
    : "N/A";
  const squad = d.commanderSquadron?.SquadronName || "N/A";
  const squadURL = d.commanderSquadron?.inaraURL || "";
  const profileURL = d.inaraURL || "";
  return [
    `**${name}**`,
    `Ranks: ${ranks}`,
    `Squadron: ${canonicalizeName(squad)}`,
    squadURL ? `Squadron page: ${squadURL}` : "",
    profileURL ? `INARA profile: ${profileURL}` : ""
  ].filter(Boolean).join("\n");
}

// ---------------- EDSM (Systems/Stations/Factions/Bodies)
async function edsmJSON(url){
  try{
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return { error: `EDSM HTTP ${res.status}` };
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch(e){ return { error: `EDSM parse error: ${e.message}; body: ${text.slice(0,200)}…` }; }
    return { json };
  } catch(e){ return { error: `EDSM network error: ${e?.message||"unknown"}` }; }
}

async function edsmSystem(system){
  const s = encodeURIComponent(system);
  // include info & primary star; returns allegiance/government/faction etc. (Systems v1 /system) — docs show shape
  return edsmJSON(`${EDSM_SYS_API}/system?systemName=${s}&showInformation=1&showPrimaryStar=1&showCoordinates=1&showPermit=1`);
}

async function edsmSystemFactions(system){
  const s = encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYSTEM_API}/factions?systemName=${s}`);
}

async function edsmSystemStations(system){
  const s = encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYSTEM_API}/stations?systemName=${s}`);
}

async function edsmSystemBodies(system){
  const s = encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYSTEM_API}/bodies?systemName=${s}`);
}

async function edsmTraffic(system){
  const s = encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYSTEM_API}/traffic?systemName=${s}`);
}
async function edsmDeaths(system){
  const s = encodeURIComponent(system);
  return edsmJSON(`${EDSM_SYSTEM_API}/deaths?systemName=${s}`);
}

function formatSystemSnapshot(sysDoc, factionsDoc){
  if (!sysDoc || sysDoc.name == null) return "System not found on EDSM.";
  const info = sysDoc.information || {};
  const header = `**${sysDoc.name}** — Allegiance: ${info.allegiance||"?"}, Gov: ${info.government||"?"}, Pop: ${info.population??"?"}`;
  const lines = [header];

  const factions = factionsDoc?.factions || [];
  if (Array.isArray(factions) && factions.length){
    for (const f of factions){
      const name = canonicalizeName(f.name || "Unknown Faction");
      const inf = pctFromUnit(f.influence);
      const states = listStates([ ...(f.pendingStates||[]).map(x=>`pending:${x.state}`), ...(f.recoveringStates||[]).map(x=>`recovering:${x.state}`), f.state ? f.state : [] ].flat());
      const note = (sysDoc.name.toLowerCase()==="ltt 14850" && name==="Black Sun Crew") ? ` | ${SPACEFORCE_OVERRIDES.ltt14850["Black Sun Crew"].note}` : "";
      lines.push(`• ${name}: ${inf}${f.state?` | state: ${f.state}`:""}${(f.pendingStates&&f.pendingStates.length)?` | pending: ${f.pendingStates.map(x=>x.state).join(", ")}`:""}${(f.recoveringStates&&f.recoveringStates.length)?` | recovering: ${f.recoveringStates.map(x=>x.state).join(", ")}`:""}${note}`);
    }
  } else {
    lines.push("• No faction data.");
  }
  return lines.join("\n");
}

function formatFactionInSystem(systemName, factionsDoc, factionFilter){
  const list = factionsDoc?.factions || [];
  if (!list.length) return `No faction data for **${systemName}** on EDSM.`;
  const matches = list.filter(f => !factionFilter || (f.name||"").toLowerCase() === factionFilter.toLowerCase());
  if (!matches.length) return `No presence for **${factionFilter}** in **${systemName}**.`;
  return matches.map(f => {
    const name = canonicalizeName(f.name);
    const inf = pctFromUnit(f.influence);
    const parts = [`**${name}** in **${systemName}** — Influence: ${inf}`];
    if (f.state) parts.push(`state: ${f.state}`);
    if (Array.isArray(f.pendingStates) && f.pendingStates.length) parts.push(`pending: ${f.pendingStates.map(x=>x.state).join(", ")}`);
    if (Array.isArray(f.recoveringStates) && f.recoveringStates.length) parts.push(`recovering: ${f.recoveringStates.map(x=>x.state).join(", ")}`);
    if (systemName.toLowerCase()==="ltt 14850" && name==="Black Sun Crew") parts.push(SPACEFORCE_OVERRIDES.ltt14850["Black Sun Crew"].note);
    return parts.join(" | ");
  }).join("\n");
}

function formatStations(systemName, stationsDoc){
  const arr = stationsDoc?.stations || [];
  if (!arr.length) return `No stations recorded in **${systemName}** on EDSM.`;
  return `**${systemName} — Stations**\n` + arr.slice(0,25).map(s=>{
    const owner = canonicalizeName(s.controllingFaction?.name || s.controllingMinorFaction || s.faction || "Unknown");
    const flags = [
      s.haveMarket ? "market" : null,
      s.haveShipyard ? "shipyard" : null,
      s.haveOutfitting ? "outfitting" : null
    ].filter(Boolean).join(", ");
    return `• ${s.name} — ${s.type || "?"} | Owner: ${owner}${flags?` | ${flags}`:""}`;
  }).join("\n");
}

function formatBodies(systemName, bodiesDoc){
  const list = bodiesDoc?.bodies || [];
  if (!list.length) return `No bodies listed for **${systemName}** on EDSM.`;
  const top = list.slice(0,10).map(b=>{
    const kind = b.type || b.subType || "?";
    const grav = (b.gravity!=null) ? `${b.gravity.toFixed ? b.gravity.toFixed(2) : b.gravity}g` : (b.surfaceGravity!=null ? `${b.surfaceGravity.toFixed ? b.surfaceGravity.toFixed(2) : b.surfaceGravity}g` : "?");
    const mats = Array.isArray(b.materials) ? b.materials.slice(0,4).map(m=>`${m.name} ${Math.round(m.percentage)}%`).join(", ") : "—";
    return `• ${b.name}: ${kind}${grav?` | gravity: ${grav}`:""}${mats!=="—"?` | mats: ${mats}`:""}`;
  });
  return `**${systemName} — Bodies (sample)**\n` + top.join("\n");
}

// ---------------- Natural language router
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

  const wantsSystem = /system (status|snapshot)|what'?s happening in|status of|overview/i.test(q);
  const wantsInfluence = /influence|who (controls?|owns?)|percent|share|states/i.test(q);
  const wantsStations = /\b(station|stations|port|outpost|carrier)\b/i.test(q);
  const wantsBodies = /\b(bodies|planets?|moons?)\b/i.test(q);
  const wantsCmdr = /\b(cmdr|commander|who is)\b/i.test(q);

  if (wantsCmdr && cmdr) return { intent:"commander_profile", name: cmdr };
  if ((wantsSystem || wantsInfluence) && sys && faction) return { intent:"faction_status", system: sys, faction };
  if (wantsSystem && sys) return { intent:"system_status", system: sys };
  if (wantsStations && sys) return { intent:"station_status", system: sys };
  if (wantsBodies && sys) return { intent:"bodies_status", system: sys };

  // Fallbacks
  if (faction && sys) return { intent:"faction_status", system: sys, faction };
  if (sys) return { intent:"system_status", system: sys };
  if (faction) return { intent:"faction_status", system: "", faction };
  if (cmdr) return { intent:"commander_profile", name: cmdr };

  return { intent:"unknown" };
}

// ---------------- Main
export async function run(input){
  try{
    let intent = input?.intent;
    if (!intent || intent==="unknown"){
      const routed = parseQuery(input?.q||"");
      input = { ...input, ...routed };
      intent = input.intent;
    }

    // Commander via INARA
    if (intent === "commander_profile"){
      const name = norm(input?.name);
      if (!okStr(name)) return "Provide a commander name.";
      const { error, event } = await callInara("getCommanderProfile", { searchName: name });
      if (error) return error;
      return formatCommander(event);
    }

    // System snapshot (EDSM system + factions)
    if (intent === "system_status"){
      const sys = canonicalizeSystem(norm(input?.system));
      if (!okStr(sys)) return "Provide a star system.";
      const [{ json: sysDoc, error: e1 }, { json: facDoc, error: e2 }] = await Promise.all([edsmSystem(sys), edsmSystemFactions(sys)]);
      if (e1) return e1; if (e2) return e2;
      return formatSystemSnapshot(sysDoc, facDoc);
    }

    // Faction (in a system, if provided)
    if (intent === "faction_status"){
      const sys = canonicalizeSystem(norm(input?.system||""));
      const faction = canonicalizeName(norm(input?.faction));
      if (!okStr(faction)) return "Provide a faction name.";
      if (okStr(sys)){
        const { json: facDoc, error } = await edsmSystemFactions(sys);
        if (error) return error;
        return formatFactionInSystem(sys, facDoc, faction);
      } else {
        return `For live influence, specify a system (e.g., "What’s ${faction} influence in LTT 14850?").`;
      }
    }

    // Stations in a system
    if (intent === "station_status"){
      const sys = canonicalizeSystem(norm(input?.system));
      if (!okStr(sys)) return "Provide a star system for stations.";
      const { json, error } = await edsmSystemStations(sys);
      if (error) return error;
      return formatStations(sys, json);
    }

    // Bodies in a system
    if (intent === "bodies_status"){
      const sys = canonicalizeSystem(norm(input?.system));
      if (!okStr(sys)) return "Provide a star system for bodies.";
      const { json, error } = await edsmSystemBodies(sys);
      if (error) return error;
      return formatBodies(sys, json);
    }

    return "Unknown request. Ask about a system, faction (with system), stations in a system, bodies in a system, or a commander.";
  }catch(e){
    return `Unexpected error: ${e?.message || "unknown"}`;
  }
}
