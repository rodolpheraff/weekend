# Partir ce weekend

PWA : tu choisis un weekend et tu vois toutes les destinations au départ de Bordeaux (BOD), toutes compagnies, avec les prix Google Flights.

- `index.html` : l'app (vanilla JS, mono-fichier), lit `data/weekends.json`.
- `scripts/fetch.mjs` : prix via SerpApi (moteur `google_travel_explore`), 1 requete = toutes les destinations pour un couple de dates.
  - Vue mois : 1 requete par mois (6 mois glissants max), Google choisit le meilleur weekend de chaque destination.
  - Vue weekend : 12 weekends x 10 combinaisons (depart mer-sam, retour sam-mar, 2 a 4 nuits). Le weekend en cours / a venir est ignore (on s organise a l avance). Releve tournant : le premier weekend couvert a chaque passage, puis les prix les plus anciens (44 requetes weekend par passage).
  - Enrichissement gratuit : cout de la vie (Banque mondiale), distance aeroport-centre (OurAirports), prix precedent (tendance).
  - `DRY=1 SERPAPI_KEY=x node scripts/fetch.mjs` affiche le plan de requetes sans rien consommer.
- `.github/workflows/update.yml` : chaque lundi a 3h UTC (~215 requetes par mois, quota gratuit SerpApi = 250), puis publication GitHub Pages. Un push de code republie sans consommer de requete.

## Mise en route

1. Compte gratuit sur [serpapi.com](https://serpapi.com/users/sign_up), copier la clé API.
2. Repo → Settings → Secrets and variables → Actions → New repository secret : `SERPAPI_KEY`.
3. Actions → « Vols et publication » → Run workflow.
