// SpaceForceEDAI — v6.0 (manifest-compatible: input {text}, output {text})
// No caching. Lightweight. Free-language routing for Inara, EDSM, EliteBGS, BGS Guide.

const INARA_URL = "https://inara.cz/inapi/v1/";
const EDSM_BASE = "https://www.edsm.net/api-v1";
const EBGS_BASE = "https://elitebgs.app/ebgs";

const env = (k, d) => (process.env[k] ? String(process.env[k]).trim() : d);

// ---------- HTTP (tight timeout, no retries) ----------
async function http(url, options = {}, timeoutMs = 7000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: c.signal });
    if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}` };
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    return { data };
  } catch (e) {
    return { error: e.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

// ---------- Inara (read-only) ----------
async function inaraCommanderProfile(name) {
  const payload = {
    header: {
      appName: env("INARA_APP_NAME", "SpaceForceEDAI"),
      appVersion: env("INARA_APP_VERSION", "6.0"),
      isBeingDeveloped: false,
      APIkey: env("INARA_API_KEY", ""),
      commanderName: env("INARA_COMMANDER_NAME") || undefined
    },
    events: [
      {
        eventName: "getCommanderProfile",
        eventTimestamp: new Date().toISOString(),
        eventData: { searchName: name }
      }
    ]
  };
  const r = await http(INARA_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (r.error) return { error: r.error };
  const ev = r.data?.events?.[0];
  if (!ev || ev.eventStatus >= 400) return { error: ev?.eventStatusText || "Inara error" };
  return { data: ev.eventData };
}

// ---------- EliteBGS (v5) ----------
const ebgsSystem = (name) => http(`${EBGS_BASE}/v5/systems?name=${encodeURIComponent(name)}`);
const ebgsFaction = (name) => http(`${EBGS_BASE}/v5/factions?name=${encodeURIComponent(name)}`);
const ebgsStationsBySystem = (name) => http(`${EBGS_BASE}/v5/stations?system=${encodeURIComponent(name)}`);

// ---------- EDSM ----------
const edsmSystem = (name) =>
  http(`${EDSM_BASE}/system?systemName=${encodeURIComponent(name)}&showId=1&showCoordinates=1&showInformation=1`);
const edsmBodies = (name) => http(`${EDSM_BASE}/bodies?systemName=${encodeURIComponent(name)}`);

// ---------- BGS Guide (GitHub index/prefix, or local) ----------
async function readLocal(path) {
  try {
    const fs = await import("node:fs/promises");
    return await fs.readFile(path, "utf8");
  } catch { return null; }
}
function extract(text, key) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter(l => l.toLowerCase().includes(key));
  return lines.length ? lines.slice(0, 5).join("\n") : null;
}
async function guideLookup(keyword) {
  const k = keyword.toLowerCase();

  const localPath = env("BGS_GUIDE_PATH");
  if (localPath) {
    const txt = await readLocal(localPath);
    const hit = extract(txt, k);
    if (hit) return hit;
  }

  const indexUrl = env("BGS_GUIDE_INDEX_URL");
  const max = parseInt(env("BGS_GUIDE_MAX_PARTS") || "16", 10);
  if (indexUrl) {
    const r = await http(indexUrl);
    if (!r.error && Array.isArray(r.data)) {
      for (const u of r.data.slice(0, max)) {
        const part = await http(u, {}, 6000);
        if (part?.data && typeof part.data === "string") {
          const hit = extract(part.data, k);
          if (hit) return hit;
        }
      }
    }
  } else {
    const prefix = env("BGS_GUIDE_PREFIX_URL");
    if (prefix) {
      for (let i = 1; i <= max; i++) {
        const part = await http(`${prefix}${i}.txt`, {}, 6000);
        if (part?.data && typeof part.data === "string") {
          const hit = extract(part.data, k);
          if (hit) return hit;
        }
      }
    }
  }
  return null;
}

// ---------- Intent routing ----------
function routeIntent(s) {
  const text = s.toLowerCase().trim();

  let m = text.match(/^(?:system\s+snapshot|snapshot|system)\s+for\s+(.+)$/i) || text.match(/^(?:system\s+snapshot|snapshot)\s+(.+)$/i);
  if (m) return { kind: "system_snapshot", arg: (m[1] || m[2]).trim() };

  m = text.match(/^(?:faction|bgs)\s+(.+)$/i);
  if (m) return { kind: "faction_status", arg: m[1].trim() };

  m = text.match(/^(?:cmdr|commander)\s+(.+)$/i);
  if (m) return { kind: "cmdr_lookup", arg: m[1].trim() };

  m = text.match(/^stations?\s+(?:in|at)\s+(.+)$/i);
  if (m) return { kind: "station_lookup", arg: m[1].trim() };

  m = text.match(/^bodies?\s+(?:in|of)\s+(.+)$/i);
  if (m) return { kind: "bodies_lookup", arg: m[1].trim() };

  m = text.match(/^guide[: ]+\s*(.+)$/i);
  if (m) return { kind: "guide", arg: m[1].trim() };

  m = text.match(/^(.+)\s+snapshot$/i);
  if (m) return { kind: "system_snapshot", arg: m[1].trim() };

  if (/\w/.test(text)) return { kind: "system_snapshot", arg: s.trim() };
  return { kind: "help" };
}

// ---------- Formatting ----------
const field = (k, v) => `**${k}:** ${v}`;
const cut = (s, n = 1800) => (!s || s.length <= n ? s : s.slice(0, n - 3) + "...");
const num = (v) => (typeof v === "number" && isFinite(v) ? v.toFixed(1) : "n/a");
const pct = (v) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "n/a");
const statesStr = (arr) => (Array.isArray(arr) && arr.length ? arr.map(a => a.state).join(", ") : "—");

// ---------- REQUIRED EXPORT ----------
export async function run(input) {
  const q = String(input?.text || "").trim();
  if (!q) {
    return {
      text: "Try: `system snapshot for LTT 14850`, `faction Black Sun Crew`, `cmdr <name>`, `stations in Guragwe`, `bodies in Maia`, or `guide expansion`."
    };
  }

  const { kind, arg } = routeIntent(q);

  try {
    if (kind === "system_snapshot") {
      const name = arg;
      const [sRes, bRes, ebRes] = await Promise.all([edsmSystem(name), edsmBodies(name), ebgsSystem(name)]);
      if (sRes.error && bRes.error && ebRes.error) return { text: `Could not fetch system "${name}".` };

      const s = sRes.data || {};
      const coords = s?.coords ? `(${num(s.coords.x)}, ${num(s.coords.y)}, ${num(s.coords.z)})` : "n/a";
      const gov = s?.information?.allegiance ? `${s.information.allegiance} / ${s.information.government}` : "n/a";
      const bodiesCount = Array.isArray(bRes?.data?.bodies) ? bRes.data.bodies.length : "n/a";
      const eb = Array.isArray(ebRes?.data?.docs) ? ebRes.data.docs[0] : null;
      const control = eb?.controllingFaction || "n/a";
      const states = eb?.factions?.map?.(f => `${f.name}: ${statesStr(f.activeStates)}`).slice(0, 5).join(" • ") || "n/a";

      return {
        text: [
          `**System Snapshot:** ${name}`,
          field("Coords", coords),
          field("Gov/Allegiance", gov),
          field("Bodies", bodiesCount),
          field("Controlling Faction (EBGS)", control),
          field("States (top)", states),
          "_Live pulls; stale info OK. No caching._"
        ].join("\n")
      };
    }

    if (kind === "faction_status") {
      const name = arg;
      const r = await ebgsFaction(name);
      if (r.error) return { text: `EliteBGS error: ${r.error}` };
      const doc = Array.isArray(r.data?.docs) ? r.data.docs[0] : null;
      if (!doc) return { text: `No faction found named "${name}".` };
      const pres = (doc.faction_presence || doc.factionPresence || []).slice(0, 8);
      const lines = pres.map(p => `• ${p.systemName} — influence ${pct(p.influence)} ${statesStr(p.activeStates)}`);
      return {
        text: [
          `**Faction Status (EBGS):** ${doc.name}`,
          field("Allegiance", doc.allegiance || "n/a"),
          field("Government", doc.government || "n/a"),
          field("Home System", doc.homeSystem || "n/a"),
          field("Presence (top 8)", lines.length ? "\n" + lines.join("\n") : "n/a"),
          "_Stale info allowed; no caching._"
        ].join("\n")
      };
    }

    if (kind === "cmdr_lookup") {
      const name = arg || env("INARA_COMMANDER_NAME");
      if (!name) return { text: "Give me a CMDR name, e.g. `cmdr Artie`." };
      const r = await inaraCommanderProfile(name);
      if (r.error) return { text: `Inara error: ${r.error}` };
      const d = r.data || {};
      const ranks =
        (d.commanderRanksPilot || [])
          .map(r => `${r.rankName}: ${r.rankValue}${typeof r.rankProgress === "number" ? ` (${Math.round(r.rankProgress * 100)}%)` : ""}`)
          .join(", ") || "n/a";
      return {
        text: [
          `**CMDR Profile (Inara):** ${d.commanderName || d.userName || name}`,
          field("Ranks", ranks),
          field("Squadron", d.commanderSquadron?.SquadronName || "n/a"),
          field("Power", d.preferredPowerName || "n/a"),
          field("Inara", d.inaraURL || "n/a"),
          "_API key stays secret via env. No caching._"
        ].join("\n")
      };
    }

    if (kind === "station_lookup") {
      const system = arg;
      const r = await ebgsStationsBySystem(system);
      if (r.error) return { text: `EliteBGS error: ${r.error}` };
      const docs = Array.isArray(r.data?.docs) ? r.data.docs : [];
      if (!docs.length) return { text: `No stations found in ${system} (EBGS).` };
      const top = docs.slice(0, 10).map(s => `• ${s.name} — ${s.type || "Station"} — ${s.controllingFaction || "n/a"}`);
      return { text: `**Stations in ${system} (EBGS):**\n${top.join("\n")}` };
    }

    if (kind === "bodies_lookup") {
      const system = arg;
      const r = await edsmBodies(system);
      if (r.error) return { text: `EDSM error: ${r.error}` };
      const bodies = Array.isArray(r.data?.bodies) ? r.data.bodies.slice(0, 12) : [];
      if (!bodies.length) return { text: `No bodies found for ${system} (EDSM).` };
      const lines = bodies.map(b => `• ${b.name} — ${b.type || "Body"}${b.isLandable ? " — landable" : ""}`);
      return { text: `**Bodies in ${system} (EDSM):**\n${lines.join("\n")}` };
    }

    if (kind === "guide") {
      const hit = await guideLookup(arg);
      return { text: hit ? `**BGS Guide (excerpt for "${arg}")**\n${cut(hit)}` : `No guide hits for "${arg}".` };
    }

    return {
      text: "Try: `system snapshot <name>`, `faction <name>`, `cmdr <name>`, `stations in <system>`, `bodies in <system>`, or `guide <keyword>`."
    };
  } catch (e) {
    return { text: `Unhandled error: ${e.message || e}` };
  }
}
