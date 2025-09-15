// applet.js
// AICord Applet: Space Force Intel (INARA + EliteBGS)
// Canonical names: Black Sun Crew, Space Force, Oblivion Fleet, Jerome Archer
// Secrets: {{INARA_API_KEY}}

const INARA_API = "https://inara.cz/inapi/v1/";
const ELITEBGS_API = "https://elitebgs.app/ebgs/v5";

const CANONICAL_NAMES = {
  "black sun crew": "Black Sun Crew",
  "space force": "Space Force",
  "oblivion fleet": "Oblivion Fleet",
  "jerome archer": "Jerome Archer"
};

// Space Force custom truths
const SPACEFORCE_OVERRIDES = {
  ltt14850: {
    "Black Sun Crew": {
      cannotRetreat: true,
      note: "Home system rule: Black Sun Crew cannot retreat in LTT 14850."
    }
  }
};

function normalizeName(raw) {
  if (!raw) return raw;
  const key = String(raw).toLowerCase().trim();
  return CANONICAL_NAMES[key] || raw;
}
function okStr(x){ return typeof x==="string" && x.trim().length>0; }
function nowISO(){ return new Date().toISOString(); }

// ----- INARA -----
async function callInara(eventName, eventData) {
  const body = {
    header: {
      appName: "SpaceForce-IntelApplet",
      appVersion: "1.1.0",
      isBeingDeveloped: false,
      APIkey: "{{INARA_API_KEY}}"
    },
    events: [{ eventName, eventTimestamp: nowISO(), eventData }]
  };

  const res = await fetch(INARA_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) return { error: `INARA HTTP ${res.status}` };
  const json = await res.json();
  const ev = json?.events?.[0];
  if (!ev) return { error: "Malformed INARA response." };
  return { event: ev };
}

function formatCmdr(ev) {
  if (ev.eventStatus === 204) return "No results found on INARA for that CMDR.";
  if (ev.eventStatus !== 200) {
    return `INARA error ${ev.eventStatus ?? "?"}: ${ev.eventStatusText ?? "Unexpected response."}`;
  }
  const d = ev.eventData || {};
  const name = normalizeName(d.commanderName || d.userName || "Unknown CMDR");

  const ranks = Array.isArray(d.commanderRanksPilot) && d.commanderRanksPilot.length
    ? d.commanderRanksPilot
        .map(r => `${r.rankName}: ${r.rankValue}${r.rankProgress!=null?` (${Math.round(r.rankProgress*100)}%)`:""}`)
        .join(", ")
    : "N/A";

  const squad = d.commanderSquadron?.SquadronName
    ? normalizeName(d.commanderSquadron.SquadronName) + ` (${d.commanderSquadron.SquadronMembersCount})`
    : "N/A";

  const squadURL = d.commanderSquadron?.inaraURL || "";
  const profileURL = d.inaraURL || "";

  return [
    `**${name}**`,
    `Ranks: ${ranks}`,
    `Squadron: ${squad}`,
    squadURL ? `Squadron page: ${squadURL}` : "",
    profileURL ? `INARA profile: ${profileURL}` : ""
  ].filter(Boolean).join("\n");
}

// ----- EliteBGS helpers -----
function pct(n){
  if (typeof n !== "number") return "N/A";
  const v = (n <= 1 && n >= 0) ? n*100 : n; // handle 0-1 or 0-100 inputs
  return `${v.toFixed(1)}%`;
}

function collectStates(p) {
  const act = (p.active_states||p.activeStates||[]).map(s=>s.state || s);
  const pen = (p.pending_states||p.pendingStates||[]).map(s=>`pending:${s.state || s}`);
  const rec = (p.recovering_states||p.recoveringStates||[]).map(s=>`recovering:${s.state || s}`);
  return [...act, ...pen, ...rec];
}

async function bgsFactionStatus(factionName){
  const fName = normalizeName(factionName);
  const url = `${ELITEBGS_API}/factions?name=${encodeURIComponent(fName)}&timeMax=now`;
  const res = await fetch(url);
  if (!res.ok) return { error: `EliteBGS HTTP ${res.status}` };
  const json = await res.json();
  const f = json?.docs?.[0];
  if (!f) return { text: `Faction not found: ${fName}` };

  const lines = [];
  lines.push(`**${fName}** — Allegiance: ${f.allegiance || "Unknown"} | Gov: ${f.government || "Unknown"}`);
  const presence = f.faction_presence || f.presences || [];
  for (const p of presence) {
    const sys = p.system_name || p.systemName;
    const inf = (p.influence!=null) ? pct(p.influence) : "N/A";
    const states = collectStates(p);
    const override = (sys && sys.toLowerCase()==="ltt 14850")
      ? SPACEFORCE_OVERRIDES.ltt14850?.[fName] : null;

    lines.push(`• ${sys}: influence ${inf}${states.length?` | states: ${states.join(", ")}`:""}${override?.cannotRetreat?` | NOTE: ${override.note}`:""}`);
  }
  return { text: lines.join("\n") };
}

async function bgsSystemStatus(systemName){
  const sName = String(systemName).trim();
  const url = `${ELITEBGS_API}/systems?name=${encodeURIComponent(sName)}&timeMax=now`;
  const res = await fetch(url);
  if (!res.ok) return { error: `EliteBGS HTTP ${res.status}` };
  const json = await res.json();
  const doc = json?.docs?.[0];
  if (!doc) return { error: `System not found: ${sName}` };

  // Faction list can appear under different keys across dumps; handle both.
  const factions = doc.factions || doc.faction_presence || doc.presences || [];
  const out = {
    system: doc.name || sName,
    security: doc.security || null,
    population: doc.population || null,
    economy: doc.primary_economy || doc.economy || null,
    factions: []
  };

  for (const p of factions) {
    const name = normalizeName(p.name || p.faction_name || p.factionName || "Unknown");
    const influenceRaw = (p.influence != null) ? p.influence : (p.faction_details?.influence);
    const influencePct = pct(influenceRaw);
    const states = collectStates(p);

    const notes = [];
    if ((doc.name||sName).toLowerCase() === "ltt 14850" && name === "Black Sun Crew") {
      const o = SPACEFORCE_OVERRIDES.ltt14850["Black Sun Crew"];
      if (o?.cannotRetreat) notes.push(o.note);
    }

    out.factions.push({
      name,
      influence: (typeof influenceRaw === "number" && influenceRaw <= 1 && influenceRaw >= 0) ? influenceRaw : (typeof influenceRaw === "number" ? influenceRaw/100 : null),
      influencePct,
      states,
      notes
    });
  }

  // Optional: provide a BSC-focused highlight (if present)
  const bsc = out.factions.find(f => f.name === "Black Sun Crew");
  out.highlight = bsc ? { blackSunCrew: bsc } : null;

  // Return JSON so the LLM can format however it wants.
  return { json: out };
}

// ----- main entrypoint -----
export async function run(input){
  try{
    const intent = (input?.intent||"").toLowerCase();

    if (intent === "commander_profile") {
      const name = normalizeName(input?.name);
      if (!okStr(name)) return "Please provide a CMDR name.";
      const { error, event } = await callInara("getCommanderProfile", { searchName: name });
      if (error) return `Could not reach INARA: ${error}`;
      return formatCmdr(event);
    }

    if (intent === "faction_status") {
      const faction = normalizeName(input?.faction);
      if (!okStr(faction)) return "Please provide a faction name.";
      const out = await bgsFactionStatus(faction);
      return out.error ? `Could not reach EliteBGS: ${out.error}` : out.text;
    }

    if (intent === "squadron_quicklink") {
      const name = normalizeName(input?.name);
      if (!okStr(name)) return "Please provide a CMDR name.";
      const { error, event } = await callInara("getCommanderProfile", { searchName: name });
      if (error) return `Could not reach INARA: ${error}`;
      if (event.eventStatus !== 200) return "No squadron info found for that CMDR.";
      const sq = event.eventData?.commanderSquadron;
      if (sq?.inaraURL) return `**${normalizeName(sq.SquadronName)}** — ${sq.inaraURL}`;
      return "No squadron link available.";
    }

    if (intent === "system_status") {
      const system = input?.system;
      if (!okStr(system)) return "Please provide a system name.";
      const out = await bgsSystemStatus(system);
      if (out.error) return `Could not reach EliteBGS: ${out.error}`;
      // Return structured JSON as a string so the LLM can format richly.
      return JSON.stringify(out.json);
    }

    return "Unknown request. Try one of: commander_profile, faction_status, squadron_quicklink, system_status.";
  } catch(e){
    console.log("Applet error:", e?.message);
    return "Unexpected error inside the applet.";
  }
}
