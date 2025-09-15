// applet.js
// Space Force Intel Applet (INARA + EliteBGS)
// - Resilient JSON handling (BGS + INARA)
// - Natural-language routing via `q`
// - Faction filter by system supported
// - Canonicalizations + LTT 14850 retreat rule
// - Always returns a short string (never undefined)

const INARA_API = "https://inara.cz/inapi/v1/";

// Try multiple EliteBGS v5 bases (some deployments vary)
const BGS_BASES = [
  "https://elitebgs.app/api/ebgs/v5",
  "https://elitebgs.app/ebgs/v5"
];

const UA_HEADERS = { "User-Agent": "SpaceForce-IntelApplet/1.4.0" };

// ---------------------------- Canonicalization & Overrides ----------------------------
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
  const m = key.match(/\bltt[-\s]?(\d{4,5})\b/i);
  if (m) return `LTT ${m[1]}`;
  return raw;
}

// ---------------------------- EliteBGS: resilient fetch & helpers ----------------------------
async function bgsFetch(pathAndQuery){
  let lastErr = "All BGS bases failed.";
  for (const base of BGS_BASES){
    try{
      const res = await fetch(`${base}${pathAndQuery}`, { headers: UA_HEADERS });
      if (!res.ok){
        lastErr = `HTTP ${res.status} @ ${base}${pathAndQuery}`;
        continue;
      }
      let text;
      try {
        text = await res.text();
        const json = JSON.parse(text);
        return { json, base };
      } catch (e) {
        lastErr = `Parse error @ ${base}${pathAndQuery}: ${e?.message || "unknown"}; body: ${String(text).slice(0,200)}…`;
        continue;
      }
    } catch (e){
      lastErr = `Network error @ ${base}${pathAndQuery}: ${e?.message || "unknown"}`;
    }
  }
  return { error: lastErr };
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
  const d = json && typeof json === "object" ? json.docs : null;
  return Array.isArray(d) ? d : [];
}

async function bgsFactionStatus(factionName, systemFilter){
  const fName = canonicalizeName(factionName);
  const q = `/factions?name=${encodeURIComponent(fName)}&timeMax=now`;
  const { json, error, base } = await bgsFetch(q);
  if (error) return { error: `Could not reach EliteBGS: ${error}` };
  const f = safeDocs(json)[0];
  if (!f) return { text: `Faction not found: ${fName}` };

  const presence = f.faction_presence || f.presences || [];

  if (okStr(systemFilter)){
    const sysName = canonicalizeSystem(systemFilter);
    const p = presence.find(x => (x.system_name || x.systemName || "").toLowerCase() === sysName.toLowerCase());
    if (!p) return { text: `No presence for ${fName} in ${sysName}.` };

    const infRaw = (p.influence != null) ? p.influence : (p.faction_details?.influence);
    const states = collectStates(p);
    const override = (sysName.toLowerCase() === "ltt 14850")
      ? SPACEFORCE_OVERRIDES.ltt14850?.[fName] : null;

    const msg =
      `**${fName}** in **${sysName}**\n` +
      `Influence: ${pct(infRaw)}${states.length ? ` | States: ${states.join(", ")}` : ""}` +
      `${override?.cannotRetreat ? ` | NOTE: ${override.note}` : ""}`;

    return { text: msg, _source: { baseUsed: base, endpoint: "factions" } };
  }

  const lines = [];
  lines.push(`**${fName}** — Allegiance: ${f.allegiance || "Unknown"} | Gov: ${f.government || "Unknown"}`);
  for (const p of presence){
    const sys = p.system_name || p.systemName;
    const infRaw = (p.influence != null) ? p.influence : (p.faction_details?.influence);
    const states = collectStates(p);
    const override = (sys && sys.toLowerCase() === "ltt 14850")
      ? SPACEFORCE_OVERRIDES.ltt14850?.[fName] : null;

    lines.push(`• ${sys}: ${pct(infRaw)}${states.length ? ` | ${states.join(", ")}` : ""}${override?.cannotRetreat ? ` | NOTE: ${override.note}` : ""}`);
  }
  return { text: lines.join("\n"), _source: { baseUsed: base, endpoint: "factions" } };
}

async function bgsSystemStatus(systemName){
  const sName = canonicalizeSystem(systemName);
  const q = `/systems?name=${encodeURIComponent(sName)}&timeMax=now`;
  const { json, error, base } = await bgsFetch(q);
  if (error) return { error: `Could not reach EliteBGS: ${error}` };
  const doc = safeDocs(json)[0];
  if (!doc) return { error: `System not found: ${sName}` };

  const factions = doc.factions || doc.faction_presence || doc.presences || [];
  const out = [];
  for (const p of factions){
    const name = canonicalizeName(p.name || p.faction_name || p.factionName || "Unknown");
    const influenceRaw = (p.influence != null) ? p.influence : (p.faction_details?.influence);
    const states = collectStates(p);

    const notes = [];
    if ((doc.name || sName).toLowerCase() === "ltt 14850" && name === "Black Sun Crew"){
      const o = SPACEFORCE_OVERRIDES.ltt14850["Black Sun Crew"];
      if (o?.cannotRetreat) notes.push(o.note);
    }

    out.push(`${name}: ${pct(influenceRaw)}${states.length ? ` | ${states.join(", ")}` : ""}${notes.length ? ` | ${notes.join("; ")}` : ""}`);
  }

  return { text: `**${doc.name || sName}**\n` + out.map(x => `• ${x}`).join("\n"), _source: { baseUsed: base, endpoint: "systems" } };
}

// ---------------------------- INARA: resilient fetch & helpers ----------------------------
async function callInara(eventName, eventData){
  const body = {
    header: {
      appName: "SpaceForce-IntelApplet",
      appVersion: "1.4.0",
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

    // Some failures can return HTML; parse defensively
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch (e) {
      return { error: `INARA parse error: ${e?.message || "unknown"}; body: ${text.slice(0,200)}…` };
    }

    const ev = json?.events?.[0];
    if (!ev) return { error: "Malformed INARA response." };
    return { event: ev };
  } catch (e){
    return { error: `INARA network error: ${e?.message || "unknown"}` };
  }
}

function formatCmdr(ev){
  if (ev.eventStatus === 204) return "No results found on INARA for that CMDR.";
  if (ev.eventStatus !== 200){
    const code = ev.eventStatus ?? "?";
    const text = ev.eventStatusText ?? "Unexpected INARA response.";
    return `INARA error ${code}: ${text}`;
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

  const lines = [
    `**${name}**`,
    `Ranks: ${ranks}`,
    `Squadron: ${squad}`,
    squadURL ? `Squadron page: ${squadURL}` : "",
    profileURL ? `INARA profile: ${profileURL}` : ""
  ].filter(Boolean);

  return lines.join("\n");
}

// ---------------------------- NL router ----------------------------
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
  const wantsCmdrProfile = /inara|profile|rank|ranks|pilot|cm?dr|commander|who is/i.test(q);
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

// ---------------------------- main ----------------------------
export async function run(input){
  try{
    // Health check
    if (input?.intent === "bgs_ping"){
      const { json, error, base } = await bgsFetch("/ticks");
      if (error) return `BGS ping failed: ${error}`;
      const cnt = Array.isArray(json?.docs) ? json.docs.length : "?";
      return `BGS OK via ${base} (last tick docs: ${cnt})`;
    }

    // Route
    let intent = (input?.intent || "").toLowerCase();
    if (!intent || intent === "unknown"){
      const routed = parseQuery(input?.q || "");
      intent = routed.intent;
      input = { ...input, ...routed };
    }

    if (intent === "commander_profile"){
      const name = norm(input?.name);
      if (!okStr(name)) return "Please provide a CMDR name.";
      const { error, event } = await callInara("getCommanderProfile", { searchName: name });
      if (error) return String(error);
      return formatCmdr(event);
    }

    if (intent === "squadron_quicklink"){
      const name = norm(input?.name);
      if (!okStr(name)) return "Please provide a CMDR name.";
      const { error, event } = await callInara("getCommanderProfile", { searchName: name });
      if (error) return String(error);
      if (event.eventStatus !== 200) return "No squadron info found for that CMDR.";
      const sq = event.eventData?.commanderSquadron;
      if (sq?.inaraURL) return `**${canonicalizeName(sq.SquadronName)}** — ${sq.inaraURL}`;
      return "No squadron link available.";
    }

    if (intent === "faction_status"){
      const faction = norm(input?.faction);
      if (!okStr(faction)) return "Please provide a faction name.";
      const systemFilter = canonicalizeSystem(norm(input?.system));
      const out = await bgsFactionStatus(faction, systemFilter);
      return out.error ? String(out.error) : String(out.text || "");
    }

    if (intent === "system_status"){
      const system = norm(input?.system);
      if (!okStr(system)) return "Please provide a system name.";
      const out = await bgsSystemStatus(system);
      return out.error ? String(out.error) : String(out.text || "");
    }

    return "Unknown request. Try: commander_profile, faction_status (optionally with system), system_status — or include a natural sentence in `q`.";
  }catch(e){
    return `Unexpected error inside the applet: ${e?.message || "unknown"}`;
  }
}
