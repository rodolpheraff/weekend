// Recupere les destinations au depart de Bordeaux (BOD) pour les prochains weekends
// via SerpApi (moteur Google Travel Explore = donnees Google Flights) et ecrit data/weekends.json.
// 1 requete = toutes les destinations pour un couple de dates (vue weekend)
// ou pour un mois entier, meilleur weekend de chaque destination (vue mois).
// Lance par la GitHub Action (secret SERPAPI_KEY). Usage local : SERPAPI_KEY=xxx node scripts/fetch.mjs

import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.SERPAPI_KEY;
const ORIGIN = "BOD";
const WEEKENDS = 12;          // weekends couverts en dates precises (~3 mois)
const SKIP = 1;               // weekends proches ignores (le weekend en cours / a venir)
const ALWAYS = 1;             // les N premiers weekends couverts sont rafraichis a chaque passage
const WEEKEND_BUDGET = 44;    // requetes "weekend" par passage ; les autres weekends tournent (plus anciens d'abord)
const MONTHS = 6;             // mois couverts en mode flexible (1 requete chacun), limite Google = 6 mois glissants
const RESERVE = 5;            // requetes gardees en reserve sur le quota du mois
const FILE = new URL("../data/weekends.json", import.meta.url);
// Passage hebdomadaire : (6 + 44) x ~4,3 = ~215 requetes / mois (quota gratuit 250)

// Combinaisons de 2 a 4 nuits, depart mer-sam, retour sam-mar : decalage en jours depuis le vendredi
const COMBOS = [
  ["mer-sam", -2, 1], ["mer-dim", -2, 2],
  ["jeu-sam", -1, 1], ["jeu-dim", -1, 2], ["jeu-lun", -1, 3],
  ["ven-dim", 0, 2], ["ven-lun", 0, 3], ["ven-mar", 0, 4],
  ["sam-lun", 1, 3], ["sam-mar", 1, 4],
].map(([id, out, ret]) => ({ id, out, ret }));

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

// Aujourd'hui a Paris
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());

// Vendredi du premier weekend couvert : on saute le weekend en cours / a venir (SKIP),
// le but est de s'organiser a l'avance
function firstFriday() {
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  const cur = dow === 6 ? addDays(today, -1) : dow === 0 ? addDays(today, -2) : addDays(today, 5 - dow);
  return addDays(cur, 7 * SKIP);
}

async function serp(params) {
  const url = "https://serpapi.com/" + params.path + "?" + new URLSearchParams({ ...params.q, api_key: KEY });
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || "HTTP " + res.status);
  return json;
}

function clean(d) {
  const price = Number(d.flight_price ?? d.price);
  if (!price) return null;
  const gps = d.gps_coordinates || {};
  return {
    city: d.name,
    country: d.country || "",
    code: d.destination_airport?.code || d.arrival_airport?.code || "",
    price,
    duration: d.flight_duration ?? null,
    stops: d.number_of_stops ?? null,
    airline: d.airline || "",
    hotel: d.hotel_price ?? null,
    img: d.thumbnail || "",
    lat: gps.latitude ?? null,
    lng: gps.longitude ?? null,
    out: d.start_date || null,
    ret: d.end_date || d.return_date || null,
  };
}

async function main() {
  let data = { origin: ORIGIN, updated: null, searchesLeft: null, weekends: {} };
  try { data = { ...data, ...JSON.parse(await readFile(FILE, "utf8")) }; } catch {}

  // On oublie les weekends et mois passes
  data.months ||= {};
  const ids = new Set(COMBOS.map((c) => c.id));
  const lastFri = addDays(firstFriday(), 7 * (WEEKENDS - 1));
  for (const fri of Object.keys(data.weekends)) {
    if (fri < firstFriday() || fri > lastFri) { delete data.weekends[fri]; continue; }
    // combinaisons d'un ancien reglage
    for (const id of Object.keys(data.weekends[fri])) if (!ids.has(id)) delete data.weekends[fri][id];
  }
  for (const ym of Object.keys(data.months)) {
    if (ym < today.slice(0, 7)) delete data.months[ym];
  }

  if (KEY) await fetchPrices(data);
  else console.log("::warning::Secret SERPAPI_KEY absent : pas de nouveaux prix, enrichissement seul.");

  await enrich(data);
  data.weekends = Object.fromEntries(Object.entries(data.weekends).sort(([a], [b]) => a.localeCompare(b)));
  data.months = Object.fromEntries(Object.entries(data.months).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(FILE, JSON.stringify(data, null, 1) + "\n");
}

// Garde le prix du releve precedent pour afficher la tendance
function withPrev(dests, old) {
  const prev = new Map((old?.dests || []).map((d) => [d.code || d.city, d.price]));
  for (const d of dests) {
    const p = prev.get(d.code || d.city);
    if (p != null) d.prev = p;
  }
  return dests;
}

async function fetchPrices(data) {

  // Quota restant (cet appel n'est pas decompte)
  let left = Infinity;
  try {
    const acc = await serp({ path: "account.json", q: {} });
    left = acc.total_searches_left ?? acc.plan_searches_left ?? Infinity;
    console.log("Recherches restantes ce mois :", left);
  } catch (e) {
    console.log("Quota inconnu :", e.message);
  }

  // Les mois d'abord (1 requete = 1 mois, toujours rafraichis), puis les weekends :
  // les ALWAYS plus proches, puis les combinaisons aux prix les plus anciens (jamais releves d'abord)
  const jobs = [];
  const [y0, m0] = today.split("-").map(Number);
  const start = Number(today.slice(8)) > 20 ? 1 : 0; // mois en cours presque fini : on passe
  for (let i = start; i < MONTHS; i++) { // Google : mois en cours + 5 suivants max
    const y = y0 + Math.floor((m0 - 1 + i) / 12), m = ((m0 - 1 + i) % 12) + 1;
    jobs.push({ ym: `${y}-${String(m).padStart(2, "0")}`, m });
  }
  const wk = [];
  let fri = firstFriday();
  for (let i = 0; i < WEEKENDS; i++, fri = addDays(fri, 7)) {
    for (const f of COMBOS) {
      const out = addDays(fri, f.out), ret = addDays(fri, f.ret);
      if (out >= today) wk.push({ fri, f, out, ret, near: i < ALWAYS, last: data.weekends[fri]?.[f.id]?.fetched || "" });
    }
  }
  wk.sort((a, b) => (b.near - a.near) || (a.near ? 0 : a.last.localeCompare(b.last)) || a.out.localeCompare(b.out));
  jobs.push(...wk.slice(0, WEEKEND_BUDGET));
  if (process.env.DRY) { // test : affiche le plan sans rien consommer
    console.log(jobs.map((j) => j.ym || `${j.fri} ${j.f.id} ${j.last ? "maj " + j.last.slice(0, 10) : "nouveau"}`).join(" | "));
    return;
  }

  let done = 0;
  for (const j of jobs) {
    if (left - done <= RESERVE) {
      console.log("::warning::Quota presque atteint, arret apres " + done + " requetes.");
      break;
    }
    const base = { engine: "google_travel_explore", departure_id: ORIGIN, type: "1", travel_mode: "1", currency: "EUR", hl: "fr", gl: "fr" };
    const what = j.ym ? j.ym : `${j.out} -> ${j.ret}`;
    try {
      const r = await serp({
        path: "search.json",
        q: j.ym
          ? { ...base, month: String(j.m), travel_duration: "1" }
          : { ...base, outbound_date: j.out, return_date: j.ret },
      });
      done++;
      let dests = (r.destinations || []).map(clean).filter(Boolean).sort((a, b) => a.price - b.price);
      const fetched = new Date().toISOString();
      if (j.ym) {
        if (r.destinations?.[0]) console.log("Exemple brut :", JSON.stringify(r.destinations[0]).slice(0, 600));
        const all = dests.length;
        dests = dests.filter((d) => d.out && d.ret);
        data.months[j.ym] = { fetched, dests: withPrev(dests, data.months[j.ym]) };
        console.log(`${j.ym} : ${dests.length} destinations (${all} brutes)`);
      } else {
        dests.forEach((d) => { delete d.out; delete d.ret; });
        const w = (data.weekends[j.fri] ||= {});
        w[j.f.id] = { out: j.out, ret: j.ret, fetched, dests: withPrev(dests, w[j.f.id]) };
        console.log(`${what} : ${dests.length} destinations`);
      }
    } catch (e) {
      console.log(`::warning::${what} : ${e.message}`);
      if (/run out|limit|invalid|api key/i.test(e.message)) break;
    }
  }

  if (done) data.updated = new Date().toISOString();
  if (Number.isFinite(left)) data.searchesLeft = left - done;
  console.log("Requetes utilisees :", done);
}

// ---------- enrichissement gratuit (sans SerpApi) ----------

// Niveau des prix par pays (Banque mondiale, ratio PPA / taux de change), France = 100,
// et distance aeroport -> centre-ville (coordonnees OurAirports)
async function enrich(data) {
  const all = [...Object.values(data.months), ...Object.values(data.weekends).flatMap((w) => Object.values(w))].flatMap((c) => c.dests);

  try {
    // niveau des prix = PPA de la consommation des menages / taux de change (monnaie locale par dollar)
    const wb = async (ind) => {
      const res = await fetch(`https://api.worldbank.org/v2/country/all/indicator/${ind}?format=json&per_page=400&mrnev=1`);
      const out = {};
      for (const r of (await res.json())[1] || []) if (r.value != null) out[r.country.id] = r.value;
      return out;
    };
    const [ppp, fx] = await Promise.all([wb("PA.NUS.PRVT.PP"), wb("PA.NUS.FCRF")]);
    const names = new Intl.DisplayNames(["fr"], { type: "region" });
    const byName = {};
    for (const id of Object.keys(ppp)) {
      if (!/^[A-Z]{2}$/.test(id) || !fx[id]) continue;
      try { byName[names.of(id)] = ppp[id] / fx[id]; } catch {}
    }
    const fr = byName.France;
    const cost = {};
    const missing = new Set();
    for (const d of all) {
      const v = byName[d.country];
      if (v != null && fr) cost[d.country] = Math.round((v / fr) * 100);
      else if (d.country) missing.add(d.country);
    }
    data.cost = cost;
    console.log("Cout de la vie :", Object.keys(cost).length, "pays", missing.size ? "| sans donnee : " + [...missing].join(", ") : "");
  } catch (e) {
    console.log("::warning::Banque mondiale : " + e.message);
  }

  try {
    const csv = await (await fetch("https://davidmegginson.github.io/ourairports-data/airports.csv")).text();
    const need = new Set(all.map((d) => d.code).filter(Boolean));
    const apt = {};
    for (const line of csv.split("\n")) {
      const c = line.match(/("([^"]*)"|[^,]*)(,|$)/g)?.map((x) => x.replace(/,$/, "").replace(/^"|"$/g, ""));
      if (c && need.has(c[13])) apt[c[13]] = [Number(c[4]), Number(c[5])];
    }
    const km = (a, b) => {
      const R = 6371, t = Math.PI / 180;
      const h = Math.sin(((b[0] - a[0]) * t) / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(((b[1] - a[1]) * t) / 2) ** 2;
      return Math.round(2 * R * Math.asin(Math.sqrt(h)));
    };
    for (const d of all) {
      if (apt[d.code] && d.lat != null) d.km = km(apt[d.code], [d.lat, d.lng]);
    }
    console.log("Aeroports localises :", Object.keys(apt).length, "/", need.size);
  } catch (e) {
    console.log("::warning::OurAirports : " + e.message);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
