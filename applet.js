// applet.js
// Minimal INARA fetcher for AICord Applets
// Expects: { cmdr: "Exact CMDR Name" }
// Uses secret: {{INARA_API_KEY}}  (set in AICord Dashboard)

export async function run({ cmdr }) {
  if (!cmdr || typeof cmdr !== "string") {
    return "Please provide a CMDR name, e.g., `!inara cmdr Artie`.";
  }

  const body = {
    header: {
      appName: "SpaceForce-InaraApplet",
      appVersion: "1.0.0",
      isBeingDeveloped: false,
      // For read-only events, INARA supports a generic *application* key,
      // or you can use a user's personal API key. We inject ours as a secret:
      APIkey: "{{INARA_API_KEY}}"
    },
    events: [
      {
        eventName: "getCommanderProfile",
        eventTimestamp: new Date().toISOString(),
        eventData: { searchName: cmdr }
      }
    ]
  };

  try {
    const res = await fetch("https://inara.cz/inapi/v1/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Be a good citizen; INARA dev guide asks for reasonable timeouts/retries.
    });

    const data = await res.json();

    // Basic error handling per INARA's eventStatus
    const ev = (data?.events && data.events[0]) || {};
    if (ev.eventStatus === 200 && ev.eventData) {
      const d = ev.eventData;
      const ranks =
        d.commanderRanksPilot
          ?.map(r => `${r.rankName}: ${r.rankValue}${r.rankProgress != null ? ` (${Math.round(r.rankProgress*100)}%)` : ""}`)
          .join(", ") || "N/A";

      const squad = d.commanderSquadron?.SquadronName
        ? `${d.commanderSquadron.SquadronName} (${d.commanderSquadron.SquadronMembersCount})`
        : "N/A";

      return [
        `**${d.userName}** ${d.commanderName ? `(CMDR ${d.commanderName})` : ""}`,
        `Ranks: ${ranks}`,
        `Squadron: ${squad}`,
        d.inaraURL ? `INARA: ${d.inaraURL}` : ""
      ].filter(Boolean).join("\n");
    }

    if (ev.eventStatus === 204) {
      return "No results found on INARA for that CMDR.";
    }

    const status = ev.eventStatus ?? data?.header?.eventStatus;
    const msg = ev.eventStatusText ?? "Unexpected response from INARA.";
    return `INARA error ${status ?? ""}: ${msg}`;
  } catch (err) {
    console.log("INARA fetch error:", err?.message);
    return "Could not reach INARA right now. Try again in a bit.";
  }
}
