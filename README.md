# Cockpit

Dashboard quotidien personnel — PWA mobile-first.

## Sections

**Pro**
- Trains aller (Conflans → Paris) — Transilien J + RER A
- Trains retour (Paris → Conflans)
- Veille IA (Hacker News + blogs IA via RSS)
- Liens rapides (ADO, Slack, etc.)

**Perso**
- Capture rapide (notes datées + tags)
- Tâches du jour
- Habitudes (suivi hebdomadaire)

**Header** — Date, météo Conflans, accès aux réglages.

## Stack

- HTML / CSS / JS vanilla (modules ES)
- PWA + service worker + splash screens iOS
- localStorage uniquement
- APIs publiques (Open-Meteo, IDFM Prim, HN Algolia, rss2json)

## Setup APIs

### IDFM (trains)
Inscription gratuite : https://prim.iledefrance-mobilites.fr/
→ "Mes jetons d'authentification" → créer un jeton → coller dans Réglages > Clé API IDFM.

### Open-Meteo (météo), HN, rss2json
Aucun setup. Tout est public sans clé.

## Lancer en local

```powershell
python -m http.server 8000
# http://localhost:8000
```

## Déploiement

GitHub Pages depuis `main` / root.
