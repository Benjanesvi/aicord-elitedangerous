// applet.js
// Space Force Intel Applet (INARA + EliteBGS) — resilient routing + system filter on faction_status
// Canonical names: Black Sun Crew, Space Force, Oblivion Fleet, Jerome Archer
// INARA key injected as {{INARA_API_KEY}} via AICord Secrets.

const INARA_API = "https://inara.cz/inapi/v1/";

// Try multiple EliteBGS v5 bases (some deployments vary)
const BGS_BASES = [
  "https://elitebgs.app/api/ebgs/v5",
  "https://elitebgs.app/ebgs/v5"
];

const UA_HEADERS = { "User-Agent": "SpaceForce-IntelApplet/1.3.0" };

// ---------------------------- Canonicalization & Overrides ----------------------------
const CANONICAL_NAMES = {
  "black sun crew": "Black Sun Crew",
  "space force": "Space Force",
  "oblivion fleet": "Oblivion Fleet",
  "jerome archer": "Jerome Archer"
};

// System aliases (add your frequent systems here)
const SYSTEM_ALIASES = {
  "14850": "LTT 14850",
  "ltt14850": "LTT 14850",
  "ltt 14850": "LTT 14850",
  "ltt-14850": "LTT 14850",
  "guragwe": "Guragwe",
  "alrai sector fw-v b2-2": "Alrai Sector FW-V b2-2"
};

// Space Force truths
const SPACEFORCE_OVERRIDES = {
  ltt14850: {
    "Black Sun Crew": {
      cannotRetreat: true,
      note: "Home system rule: Black Sun Crew cannot retreat in LTT 14850."
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
  // Generic LTT #### / LTT-#### normalizer
  const m = key.match(/\bltt[-\s]?(\d{4,5})\b/i);
  if (m) return `LTT ${m[1]}`;
  return raw;
}

// ---------------------------- EliteBGS helpers ----------------------------
async function bgsFetch(pathAndQuery){
  let lastErr;
  for (const base of BGS_BASES){
    try{
      const res = await fetch(`${base}${pathAndQuery}`, { headers: UA_HEADERS });
      if (res.ok) return { res, base };
      lastErr = `HTTP ${res.status} @ ${base}${pathAndQuery}`;
    }catch(e){
      lastErr = `Network error @ ${base}${pathAndQuery}: ${e?.message || "unknown"}`;
    }
  }
  return { error: lastErr || "All BGS bases failed." };
}

function pct(n){
  if (typeof n !== "number") return "N/A";
  const v = (n >= 0 && n <= 1) ? n * 100 : n;
  return `${v.toFixed(1)}%`;
}
function collectStates(p){
  const act = (p.active_states||p.activeStates||[]).map(s => s.state || s);
  const pen = (p.pending_states||p.pendingStates||[]).map(s => `pending:${s.state || s}`);
  const rec = (p.recovering_states||p.recoveringStates||[]).map(s => `recovering:${s.state || s}`);
  return [...act, ...pen, ...rec];
}

function safeDocs(json){
  // EliteBGS v5 returns { docs: [...] }; guard for weird shapes
  const d = json && typeof json === "object" ? json.docs : null;
  return Array.isArray(d) ? d : [];
}

async function bgsFactionStatus(factionName, systemFilter){
  const fName = canonicalizeName(factionName);
  const { res, error, base } = await bgsFetch(`/factions?name=${encodeURIComponent(fName)}&timeMax=now`);
  if (error) return { error: `Could not reach EliteBGS: ${error}` };
  let json;
  try { json = await res.json(); } catch { return { error: "EliteBGS JSON parse error (factions)." }; }
  const f = safeDocs(json)[0];
  if (!f) return { text: `Faction not found: ${fName}` };

  const presence = f.faction_presence || f.presences || [];

  // If a specific system was requested (like your bot’s suggestion), filter to that system.
  if (okStr(systemFilter)){
    const sysName = canonicalizeSystem(systemFilter);
    const p = presence.find(x => (x.system_name || x.systemName || "").toLowerCase() === sysName.toLowerCase());
    if (!p) return { text: `No presence for ${fName} in ${sysName}.` };

    const infRaw = (p.influence != null) ? p.influence : (p.faction_details?.influence);
    const inf = pct(infRaw);
    const states = collectStates(p);
    const override = (sysName.toLowerCase() === "ltt 14850")
      ? SPACEFORCE_OVERRIDES.ltt14850?.[fName] : null;

    const out = {
      faction: fName,
      system: sysName,
      influence: inf,
      states,
      note: override?.cannotRetreat ? override.note : undefined,
      _source: { baseUsed: base, endpoint: "factions" }
    };
    return { json: out };
  }

  // Otherwise, full spread
  const lines = [];
  lines.push(`**${fName}** — Allegiance: ${f.allegiance || "Unknown"} | Gov: ${f.government || "Unknown"}`);
  for (const p of presence){
    const sys = p.system_name || p.systemName;
    const infRaw = (p.influence != null) ? p.influence : (p.faction_details?.influence);
    const inf = pct(infRaw);
    const states = collectStates(p);
    const override = (sys && sys.toLowerCase() === "ltt 14850")
      ? SPACEFORCE_OVERRIDES.ltt14850?.[fName] : null;

    lines.push(`• ${sys}: influence ${inf}${states.length ? ` | states: ${states.join(", ")}` : ""}${override?.cannotRetreat ? ` | NOTE: ${override.note}` : ""}`);
  }
  return { text: lines.join("\n"), baseUsed: base };
}

async function bgsSystemStatus(systemName){
  const sName = canonicalizeSystem(systemName);
  const { res, error, base } = await bgsFetch(`/systems?name=${encodeURIComponent(sName)}&timeMax=now`);
  if (error) return { error: `Could not reach EliteBGS: ${error}` };
  let json;
  try { json = await res.json(); } catch { return { error: "EliteBGS JSON parse error (systems)." }; }
  const doc = safeDocs(json)[0];
  if (!doc) return { error: `System not found: ${sName}` };

  const factions = doc.factions || doc.faction_presence || doc.presences || [];
  const out = {
    system: doc.name || sName,
    security: doc.security || null,
    population: doc.population || null,
    economy: doc.primary_economy || doc.economy || null,
    factions: []
  };

  for (const p of factions){
    const name = canonicalizeName(p.name || p.faction_name || p.factionName || "Unknown");
    const influenceRaw = (p.influence != null) ? p.influence : (p.faction_details?.influence);
    const states = collectStates(p);

    const notes = [];
    if ((out.system || sName).toLowerCase() === "ltt 14850" && name === "Black Sun Crew"){
      const o = SPACEFORCE_OVERRIDES.ltt14850["Black Sun Crew"];
      if (o?.cannotRetreat) notes.push(o.note);
    }

    out.factions.push({
      name,
      influence: (typeof influenceRaw === "number" && influenceRaw <= 1 && influenceRaw >= 0)
        ? influenceRaw : (typeof influenceRaw === "number" ? influenceRaw/100 : null),
      influencePct: pct(influenceRaw),
      states,
      notes
    });
  }

  // convenience highlight for the LLM
  const bsc = out.factions.find(f => f.name === "Black Sun Crew");
  out.highlight = bsc ? { blackSunCrew: bsc } : null;
  out._source = { baseUsed: base, endpoint: "systems" };

  return { json: out };
}

// ---------------------------- INARA helpers ----------------------------
async function callInara(eventName, eventData){
  const body = {
    header: {
      appName: "SpaceForce-IntelApplet",
      appVersion: "1.3.0",
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
  let json;
  try { json = await res.json(); } catch { return { error: "INARA JSON parse error." }; }
  const ev = json?.events?.[0];
  if (!ev) return { error: "Malformed INARA response." };
  return { event: ev };
}

function formatCmdr(ev){
  if (ev.eventStatus === 204) return "No results found on INARA for that CMDR.";
  if (ev.eventStatus !== 200){
    return `INARA error ${ev.eventStatus ?? "?"}: ${ev.eventStatusText ?? "Unexpected response."}`;
  }
  const d = ev.eventData || {};
  const name = canonicalizeName(d.commanderName || d.userName || "Unknown CMDR");
  const ranks = Array.isArray(d.commanderRanksPilot) && d.commanderRanksPilot.length
    ? d.commanderRanksPilot.map(r => `${r.rankName}: ${r.rankValue}${r.rankProgress!=null?` (${Math.round(r.rankProgress*100)}%)`:""}`).join(", ")
    : "N/A";
  const squad = d.commanderSquadron?.SquadronName
    ? canonicalizeName(d.commanderSquadron.SquadronName) + ` (${d.commanderSquadron.SquadronMembersCount})`
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

// ---------------------------- Intentless Natural-Language Router ----------------------------
function parseQuery(qRaw){
  const q = (qRaw || "").toLowerCase();

  const mentionsSystem = (() => {
    for (const key of Object.keys(SYSTEM_ALIASES)){
      if (q.includes(key)) return SYSTEM_ALIASES[key];
    }
    const m = q.match(/\bltt[-\s]?([0-9]{4,5})\b/);
    if (m) return `LTT ${m[1]}`;
    return null;
  })();

  const mentionsFaction = (() => {
    if (q.includes("black sun crew")) return "Black Sun Crew";
    if (q.includes("oblivion fleet")) return "Oblivion Fleet";
    if (q.includes("space force")) return "Space Force";
    return null;
  })();

  const mentionsCmdr = (() => {
    let m = q.match(/\bcmdr\s+([a-z0-9 _\-]+)\b/i) || q.match(/\bcommander\s+([a-z0-9 _\-]+)\b/i);
    if (m) return m[1].trim();
    m = q.match(/\bcheck\s+([a-z0-9 _\-]+)\s+on\s+inara\b/i);
    if (m) return m[1].trim();
    if (q.includes("jerome archer")) return "Jerome Archer";
    return null;
  })();

  const wantsInfluence = /influence|who (controls?|owns?)|power|percent|share/i.test(q);
  const wantsStates = /\bstate(s)?\b|boom|war|civil|election|expansion|retreat|pending|recovering/i.test(q);
  const wantsSystemSnapshot = /system snapshot|system status|what'?s happening|overview|status of/i.test(q);
  const wantsSquadronLink = /squadron (link|page)|what squadron|which squadron|squad link/i.test(q);
  const wantsCmdrProfile = /inara|profile|rank|ranks|pilot|cm?dr|commander/i.test(q);
  const wantsPing = /\bping\b|\bhealth\b|\bstatus check\b|\btick\b/i.test(q);

  if (wantsPing) return { intent: "bgs_ping" };
  if (mentionsCmdr && wantsSquadronLink) return { intent: "squadron_quicklink", name: mentionsCmdr };
  if (mentionsCmdr && wantsCmdrProfile) return { intent: "commander_profile", name: mentionsCmdr };
  if ((wantsSystemSnapshot || wantsInfluence || wantsStates) && mentionsSystem)
    return { intent: "system_status", system: mentionsSystem };
  if ((wantsInfluence || wantsStates) && mentionsFaction)
    return { intent: "faction_status", faction: mentionsFaction };

  if (mentionsSystem) return { intent: "system_status", system: mentionsSystem };
  if (mentionsFaction) return { intent: "faction_status", faction: mentionsFaction };
  if (mentionsCmdr) return { intent: "commander_profile", name: mentionsCmdr };

  return { intent: "unknown" };
}

// ---------------------------- Main ----------------------------
export async function run(input){
  try{
    // Health check
    if (input?.intent === "bgs_ping"){
      const { res, error, base } = await bgsFetch("/ticks");
      if (error) return `BGS ping failed: ${error}`;
      let data; try { data = await res.json(); } catch { /* ignore */ }
      return `BGS OK via ${base} (last tick docs: ${Array.isArray(data?.docs) ? data.docs.length : "?"})`;
    }

    // Route by explicit intent or natural-language `q`
    let intent = (input?.intent || "").toLowerCase();
    if (!intent || intent === "unknown"){
      const routed = parseQuery(input?.q || "");
      intent = routed.intent;
      input = { ...input, ...routed };
    }

    if (intent === "commander_profile"){
      const name = canonicalizeName(norm(input?.name));
      if (!okStr(name)) return "Please provide a CMDR name.";
      const { error, event } = await callInara("getCommanderProfile", { searchName: name });
      if (error) return `Could not reach INARA: ${error}`;
      return formatCmdr(event);
    }

    if (intent === "squadron_quicklink"){
      const name = canonicalizeName(norm(input?.name));
      if (!okStr(name)) return "Please provide a CMDR name.";
      const { error, event } = await callInara("getCommanderProfile", { searchName: name });
      if (error) return `Could not reach INARA: ${error}`;
      if (event.eventStatus !== 200) return "No squadron info found for that CMDR.";
      const sq = event.eventData?.commanderSquadron;
      if (sq?.inaraURL) return `**${canonicalizeName(sq.SquadronName)}** — ${sq.inaraURL}`;
      return "No squadron link available.";
    }

    if (intent === "faction_status"){
      const faction = canonicalizeName(norm(input?.faction));
      const systemFilter = canonicalizeSystem(norm(input?.system)); // NEW: accept optional system filter
      if (!okStr(faction)) return "Please provide a faction name.";
      const out = await bgsFactionStatus(faction, systemFilter);
      if (out.error) return out.error;
      // If a system filter was used we returned JSON; otherwise text.
      return out.json ? JSON.stringify(out.json) : out.text;
    }

    if (intent === "system_status"){
      const system = canonicalizeSystem(norm(input?.system));
      if (!okStr(system)) return "Please provide a system name.";
      const out = await bgsSystemStatus(system);
      if (out.error) return out.error;
      return JSON.stringify(out.json);
    }

    return "Unknown request. Try: commander_profile, faction_status (optionally with system), system_status — or include a natural sentence in `q`.";
  }catch(e){
    console.log("Applet error:", e?.message);
    return "Unexpected error inside the applet.";
  }
}
