// applet.js
// Space Force Intel Applet — INARA only
// Canonicalized names, LTT 14850 retreat rule, error-safe parsing

const INARA_API = "https://inara.cz/inapi/v1/";

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
    "Black Sun Crew": {
      cannotRetreat: true,
      note: "Black Sun Crew cannot retreat in LTT 14850 (home system)."
    }
  }
};

function norm(s){ return typeof s === "string" ? s.trim() : s; }
function okStr(s){ return typeof s === "string" && s.trim().length > 0; }
function nowISO(){ return new Date().toISOString(); }

function canonicalizeName(raw){
  if (!raw) return raw;
  const key = raw.toLowerCase().trim();
  return CANONICAL_NAMES[key] || raw;
}
function canonicalizeSystem(raw){
  if (!raw) return raw;
  const key = raw.toLowerCase().trim();
  if (SYSTEM_ALIASES[key]) return SYSTEM_ALIASES[key];
  const m = key.match(/\bltt[-\s]?(\d{4,5})\b/i);
  if (m) return `LTT ${m[1]}`;
  return raw;
}

// ---------------- INARA call wrapper ----------------
async function callInara(eventName, eventData){
  const body = {
    header: {
      appName: "SpaceForce-IntelApplet",
      appVersion: "2.0.0",
      isBeingDeveloped: false,
      APIkey: "{{INARA_API_KEY}}"
    },
    events: [{ eventName, eventTimestamp: nowISO(), eventData }]
  };

  try{
    const res = await fetch(INARA_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) return { error: `INARA HTTP ${res.status}` };
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch (e){ return { error: `INARA parse error: ${e.message}` }; }
    const ev = json?.events?.[0];
    if (!ev) return { error: "Malformed INARA response." };
    return { event: ev };
  }catch(e){
    return { error: `INARA network error: ${e.message}` };
  }
}

// ---------------- Formatters ----------------
function formatFaction(ev, systemFilter){
  if (ev.eventStatus !== 200) return `INARA error ${ev.eventStatus}: ${ev.eventStatusText}`;
  const data = ev.eventData;
  if (!data?.factions || !Array.isArray(data.factions)) return "No faction data found.";

  let lines = [];
  for (const f of data.factions){
    const fname = canonicalizeName(f.factionName);
    if (systemFilter && (!f.factionSystems || !f.factionSystems.some(s => s.systemName.toLowerCase() === systemFilter.toLowerCase()))) {
      continue;
    }
    if (f.factionSystems){
      for (const sys of f.factionSystems){
        if (systemFilter && sys.systemName.toLowerCase() !== systemFilter.toLowerCase()) continue;
        const inf = (sys.influence*100).toFixed(1)+"%";
        const states = (sys.factionStates||[]).map(s => s.state).join(", ") || "None";
        const note = (sys.systemName.toLowerCase() === "ltt 14850" && fname==="Black Sun Crew")
          ? SPACEFORCE_OVERRIDES.ltt14850["Black Sun Crew"].note : "";
        lines.push(`**${fname}** in **${sys.systemName}** — Influence: ${inf} | States: ${states}${note?` | ${note}`:""}`);
      }
    }
  }
  return lines.length ? lines.join("\n") : "No matching faction presence.";
}

function formatSystem(ev){
  if (ev.eventStatus !== 200) return `INARA error ${ev.eventStatus}: ${ev.eventStatusText}`;
  const d = ev.eventData;
  if (!d?.systemName) return "System not found.";
  const out = [`**${d.systemName}** — Pop: ${d.population || "?"}, Security: ${d.security || "?"}`];
  if (Array.isArray(d.systemFactions)){
    for (const f of d.systemFactions){
      const fname = canonicalizeName(f.factionName);
      const inf = (f.influence*100).toFixed(1)+"%";
      const states = (f.factionStates||[]).map(s => s.state).join(", ") || "None";
      const note = (d.systemName.toLowerCase()==="ltt 14850" && fname==="Black Sun Crew")
        ? SPACEFORCE_OVERRIDES.ltt14850["Black Sun Crew"].note : "";
      out.push(`• ${fname}: ${inf} | ${states}${note?` | ${note}`:""}`);
    }
  }
  return out.join("\n");
}

function formatCmdr(ev){
  if (ev.eventStatus === 204) return "No results found on INARA for that CMDR.";
  if (ev.eventStatus !== 200) return `INARA error ${ev.eventStatus}: ${ev.eventStatusText}`;
  const d = ev.eventData || {};
  const name = canonicalizeName(d.commanderName || "Unknown CMDR");
  const ranks = (d.commanderRanksPilot||[]).map(r => `${r.rankName}: ${r.rankValue}`).join(", ") || "N/A";
  const squad = d.commanderSquadron?.SquadronName ? d.commanderSquadron.SquadronName : "N/A";
  const squadURL = d.commanderSquadron?.inaraURL || "";
  const profileURL = d.inaraURL || "";
  return [
    `**${name}**`,
    `Ranks: ${ranks}`,
    `Squadron: ${squad}`,
    squadURL?`Squadron page: ${squadURL}`:"",
    profileURL?`INARA profile: ${profileURL}`:""
  ].filter(Boolean).join("\n");
}

// ---------------- Router ----------------
function parseQuery(qRaw){
  const q = (qRaw||"").toLowerCase();
  const sys = Object.keys(SYSTEM_ALIASES).find(k => q.includes(k));
  if (q.includes("who is") || q.includes("commander") || q.includes("cmdr")) {
    const m = q.match(/cmdr\s+([a-z0-9 _\-]+)/i) || q.match(/commander\s+([a-z0-9 _\-]+)/i) || q.match(/who is\s+([a-z0-9 _\-]+)/i);
    return { intent:"commander_profile", name:m?m[1]:"" };
  }
  if (q.includes("influence") || q.includes("faction")) {
    return { intent:"faction_status", faction:"Black Sun Crew", system: sys?SYSTEM_ALIASES[sys]:"" };
  }
  if (q.includes("system") || q.includes("snapshot")) {
    return { intent:"system_status", system: sys?SYSTEM_ALIASES[sys]:"" };
  }
  return { intent:"unknown" };
}

// ---------------- Main ----------------
export async function run(input){
  try{
    let intent = input?.intent;
    if (!intent || intent==="unknown"){
      const routed = parseQuery(input?.q||"");
      intent = routed.intent;
      input = {...input, ...routed};
    }

    if (intent==="commander_profile"){
      const {error,event} = await callInara("getCommanderProfile",{searchName:input.name});
      if (error) return error;
      return formatCmdr(event);
    }
    if (intent==="faction_status"){
      const faction = canonicalizeName(norm(input.faction||""));
      const sys = canonicalizeSystem(norm(input.system||""));
      const {error,event} = await callInara("getFactions",{searchName:faction});
      if (error) return error;
      return formatFaction(event,sys);
    }
    if (intent==="system_status"){
      const sys = canonicalizeSystem(norm(input.system||""));
      const {error,event} = await callInara("getSystem",{searchName:sys});
      if (error) return error;
      return formatSystem(event);
    }
    return "Unknown request. Ask about a system, faction, or commander.";
  }catch(e){
    return `Unexpected error: ${e.message}`;
  }
}
