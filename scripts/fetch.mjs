// Recupere les destinations au depart de Bordeaux (BOD) pour les prochains weekends
// via SerpApi (moteur Google Travel Explore = donnees Google Flights) et ecrit data/weekends.json.
// 1 requete = toutes les destinations pour un couple de dates.
// Lance par la GitHub Action (secret SERPAPI_KEY). Usage local : SERPAPI_KEY=xxx node scripts/fetch.mjs

import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.SERPAPI_KEY;
const ORIGIN = "BOD";
const WEEKENDS = 8;       // nombre de weekends couverts
const RESERVE = 5;        // requetes gardees en reserve sur le quota du mois
const FILE = new URL("../data/weekends.json", import.meta.url);

// Formats de weekend : decalage en jours depuis le vendredi
const FORMATS = [
  { id: "ven-dim", out: 0, ret: 2 },
  { id: "sam-dim", out: 1, ret: 2 },
  { id: "ven-lun", out: 0, ret: 3 },
];

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

// Aujourd'hui a Paris
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());

// Vendredi du weekend en cours (sam/dim) ou a venir (lun-ven)
function firstFriday() {
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  if (dow === 6) return addDays(today, -1);
  if (dow === 0) return addDays(today, -2);
  return addDays(today, 5 - dow);
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
  return {
    city: d.name,
    country: d.country || "",
    code: d.destination_airport?.code || d.arrival_airport?.code || "",
    price,
    duration: d.flight_duration ?? null,
    stops: d.number_of_stops ?? null,
    airline: d.airline || "",
    img: d.thumbnail || "",
  };
}

async function main() {
  let data = { origin: ORIGIN, updated: null, searchesLeft: null, weekends: {} };
  try { data = { ...data, ...JSON.parse(await readFile(FILE, "utf8")) }; } catch {}

  // On oublie les weekends passes
  for (const fri of Object.keys(data.weekends)) {
    if (addDays(fri, 3) < today) delete data.weekends[fri];
  }

  if (!KEY) {
    console.log("::warning::Secret SERPAPI_KEY absent : aucune donnee recuperee.");
    return;
  }

  // Quota restant (cet appel n'est pas decompte)
  let left = Infinity;
  try {
    const acc = await serp({ path: "account.json", q: {} });
    left = acc.total_searches_left ?? acc.plan_searches_left ?? Infinity;
    console.log("Recherches restantes ce mois :", left);
  } catch (e) {
    console.log("Quota inconnu :", e.message);
  }

  // Du weekend le plus proche au plus lointain : si le quota manque, on garde les plus utiles
  const jobs = [];
  let fri = firstFriday();
  for (let i = 0; i < WEEKENDS; i++, fri = addDays(fri, 7)) {
    for (const f of FORMATS) {
      const out = addDays(fri, f.out), ret = addDays(fri, f.ret);
      if (out >= today) jobs.push({ fri, f, out, ret });
    }
  }

  let done = 0;
  for (const j of jobs) {
    if (left - done <= RESERVE) {
      console.log("::warning::Quota presque atteint, arret apres " + done + " requetes.");
      break;
    }
    try {
      const r = await serp({
        path: "search.json",
        q: {
          engine: "google_travel_explore",
          departure_id: ORIGIN,
          outbound_date: j.out,
          return_date: j.ret,
          type: "1",
          travel_mode: "1",
          currency: "EUR",
          hl: "fr",
          gl: "fr",
        },
      });
      done++;
      const dests = (r.destinations || []).map(clean).filter(Boolean).sort((a, b) => a.price - b.price);
      (data.weekends[j.fri] ||= {})[j.f.id] = { out: j.out, ret: j.ret, fetched: new Date().toISOString(), dests };
      console.log(`${j.out} -> ${j.ret} : ${dests.length} destinations`);
    } catch (e) {
      console.log(`::warning::${j.out} -> ${j.ret} : ${e.message}`);
      if (/run out|limit|invalid|api key/i.test(e.message)) break;
    }
  }

  // Tri des weekends par date
  data.weekends = Object.fromEntries(Object.entries(data.weekends).sort(([a], [b]) => a.localeCompare(b)));
  if (done) data.updated = new Date().toISOString();
  if (Number.isFinite(left)) data.searchesLeft = left - done;
  await writeFile(FILE, JSON.stringify(data, null, 1) + "\n");
  console.log("Requetes utilisees :", done);
}

main().catch((e) => { console.error(e); process.exit(1); });
