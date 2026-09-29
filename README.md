# Partir ce weekend

PWA : tu choisis un weekend et tu vois toutes les destinations au départ de Bordeaux (BOD), toutes compagnies, avec les prix Google Flights.

- `index.html` : l'app (vanilla JS, mono-fichier), lit `data/weekends.json`.
- `scripts/fetch.mjs` : récupère les prix via SerpApi (moteur `google_travel_explore`). 1 requête = toutes les destinations pour un couple de dates. 8 weekends x 3 formats (ven-dim, sam-dim, ven-lun) = 24 requêtes par passage.
- `.github/workflows/update.yml` : lundi et jeudi à 3h UTC (environ 210 requêtes par mois, quota gratuit SerpApi = 250), puis publication GitHub Pages. Un push de code republie sans consommer de requête.

## Mise en route

1. Compte gratuit sur [serpapi.com](https://serpapi.com/users/sign_up), copier la clé API.
2. Repo → Settings → Secrets and variables → Actions → New repository secret : `SERPAPI_KEY`.
3. Actions → « Vols et publication » → Run workflow.
