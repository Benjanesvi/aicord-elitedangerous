// applet.js
// AICord Applet: Space Force Intel (INARA + EliteBGS)
// Secrets: {{INARA_API_KEY}} (set in AICord Applet -> Secrets)

const INARA_API = "https://inara.cz/inapi/v1/";
const ELITEBGS_API = "https://elitebgs.app/ebgs/v5"; // v5 docs

// Space Force custom rules (hardcoded truths you want the LLM to rely on)
const SPACEFORCE_OVERRIDES = {
  ltt14850: {
    "Black Sun Crew": {
      cannotRetreat: true,
      note: "Home system rule: Black Sun Crew cannot retreat in LTT 14850."
    }
  }
};

function okStr(x){ return typeof x==="string" && x.trim().length>0; }
function nowISO(){ return new Date().toISOString(); }

async function callInara(eventName, eventData) {
  const body = {
    header: {
      appName: "SpaceForce-IntelApplet",
      appVersion: "1.0.0",
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
  const name = d.commanderName || d.userName || "Unknown CMDR";

  const ranks = Array.isArray(d.commanderRanksPilot) && d.commanderRanksPilot.length
    ? d.commanderRanksPilot
        .map(r => `${r.rankName}: ${r.rankValue}${r.rankProgress!=null?` (${Math.round(r.rankProgress*100)}%)`:""}`)
        .join(", ")
    : "N/A";

  const squad = d.commanderSquadron?.SquadronName
    ? `${d.commanderSquadron.SquadronName} (${d.commanderSquadron.SquadronMembersCount})`
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

// --- EliteBGS helpers ---
async function bgsFactionStatus(factionName){
  const url = `${ELITEBGS_API}/factions?name=${encodeURIComponent(factionName)}&timeMax=now`;
  const res = await fetch(url);
  if (!res.ok) return { error: `EliteBGS HTTP ${res.status}` };
  const json = await res.json();

  const f = json?.docs?.[0];
  if (!f) return { text: "Faction not found on EliteBGS." };

  // Build quick digest: states and influence per system
  const lines = [];
  lines.push(`**${f.name}** — Allegiance: ${f.allegiance || "Unknown"} | Gov: ${f.government || "Unknown"}`);
  if (Array.isArray(f.faction_presence)) {
    for (const p of f.faction_presence) {
      const sys = p.system_name;
      const inf = (p.influence!=null) ? `${(p.influence*100).toFixed(1)}%` : "N/A";
      const states = [
        ...(p.active_states||[]).map(s=>s.state),
        ...(p.pending_states||[]).map(s=>`pending:${s.state}`),
        ...(p.recovering_states||[]).map(s=>`recovering:${s.state}`)
      ];
      // Apply Space Force overrides where relevant
      const override = (sys && sys.toLowerCase()==="ltt 14850")
        ? SPACEFORCE_OVERRIDES.ltt14850?.[f.name] : null;

      lines.push(`• ${sys}: influence ${inf}${states.length?` | states: ${states.join(", ")}`:""}${override?.cannotRetreat?` | NOTE: ${override.note}`:""}`);
    }
  }
  return { text: lines.join("\n") };
}

export async function run(input){
  try{
    const intent = (input?.intent||"").toLowerCase();

    // 1) Commander profile (INARA)
    if (intent === "commander_profile") {
      const name = input?.name;
      if (!okStr(name)) return "Please provide a CMDR name.";
      const { error, event } = await callInara("getCommanderProfile", { searchName: name });
      if (error) return `Could not reach INARA: ${error}`;
      return formatCmdr(event);
    }

    // 2) Faction status (EliteBGS) - e.g., "Black Sun Crew"
    if (intent === "faction_status") {
      const faction = input?.faction;
      if (!okStr(faction)) return "Please provide a faction name.";
      const out = await bgsFactionStatus(faction);
      return out.error ? `Could not reach EliteBGS: ${out.error}` : out.text;
    }

    // 3) Squadron quicklink (by any CMDR known to be in that squad)
    if (intent === "squadron_quicklink") {
      const name = input?.name;
      if (!okStr(name)) return "Please provide a CMDR name to infer the squadron.";
      const { error, event } = await callInara("getCommanderProfile", { searchName: name });
      if (error) return `Could not reach INARA: ${error}`;
      if (event.eventStatus !== 200) return "No squadron info found for that CMDR.";
      const d = event.eventData || {};
      const sq = d.commanderSquadron;
      if (sq?.inaraURL) return `**${sq.SquadronName}** — ${sq.inaraURL}`;
      return "No squadron link available.";
    }

    return "Unknown request. Try one of: commander_profile, faction_status, squadron_quicklink.";
  } catch(e){
    console.log("Applet error:", e?.message);
    return "Unexpected error inside the applet.";
  }
}
