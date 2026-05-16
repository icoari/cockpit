# Cockpit — Design Spec

**Date :** 2026-05-16
**Auteur :** Nicolas BARI
**Cible :** PWA mobile-first daily dashboard, hébergée sur GitHub Pages

## 1. Vision

Une page d'accueil personnelle qu'on ouvre le matin sur son téléphone. Deux sections distinctes : **Pro** (transports, veille IA, raccourcis travail) et **Perso** (capture rapide, tâches, habitudes). Header global avec date + météo + accès settings. Même langage visuel que le tracker santé : dark, glassmorphism subtil, Inter, vert d'eau accent, no emoji.

## 2. Architecture technique

- **Vanilla JS (ES modules)**, pas de framework, pas de build
- `localStorage` pour toutes les données perso et settings
- Appels directs aux APIs publiques depuis le navigateur (CORS-friendly)
- PWA : manifest + service worker, splash screens iOS
- Hébergement GitHub Pages (repo `icoari/cockpit`)
- Aucun backend

### Structure de fichiers

```
cockpit/
  index.html
  styles.css
  app.js                  (orchestrateur, header, switcher Pro/Perso, lifecycle)
  modules/
    state.js              (localStorage, settings)
    util.js               (date, debounce, dom helpers)
    icons.js              (SVG icons)
    weather.js            (Open-Meteo)
    trains.js             (IDFM Prim, aller + retour)
    aiwatch.js            (HN Algolia + RSS via rss2json)
    todos.js
    capture.js
    habits.js
    links.js
    settings.js           (panel de configuration)
  manifest.json
  service-worker.js
  icons/                  (icon + splash PNGs)
```

## 3. Layout

### Header sticky (toujours visible)
- Date du jour ("samedi 16 mai")
- Météo mini Conflans : icône + temp actuelle + max/min
- Bouton settings (icône engrenage)

### Switcher Pro / Perso (sticky, sous le header)
Deux segments. Animation slide à la transition. Mémorisation du dernier onglet en localStorage. Auto-prio :
- Avant 14h : ouvre sur **Pro**
- Après 14h : reste sur dernier choisi (par défaut Perso)

### Onglet Pro
1. **Trains — Aller** (Conflans → Paris) — tabs `Transilien J` / `RER A`
2. **Trains — Retour** (Paris → Conflans) — tabs `Transilien J` / `RER A`
3. **Veille IA** — fil agrégé HN/blogs IA
4. **Liens rapides** — grille paramétrable

### Onglet Perso
5. **Capture rapide** — input + recherche + tags
6. **Tâches du jour** — todo minimaliste
7. **Habitudes** — suivi de routines quotidiennes

## 4. Widgets — détail

### 4.1 Météo (header mini + card optionnelle)

**API** : Open-Meteo, `https://api.open-meteo.com/v1/forecast?latitude=49.005&longitude=2.099&current=temperature_2m,weather_code,wind_speed_10m&hourly=temperature_2m,precipitation_probability,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FParis&forecast_days=2`

**Mini (header)** :
- Icône (déterminée par weather_code)
- Temp actuelle (gros chiffre)
- Max / min du jour (petit)

**Card option future** :
- Prochaines heures (8 prochaines, courbe SVG + probabilité de pluie)
- Pas dans v1, juste mini header.

Refresh : au chargement et toutes les 30 min. Cache local 30 min.

### 4.2 Trains (Aller + Retour)

**API** : IDFM Prim `stop-monitoring`
- Endpoint : `https://prim.iledefrance-mobilites.fr/marketplace/stop-monitoring?MonitoringRef=<STIF:StopArea:SP:NNNN:>`
- Headers : `apikey: <user-key>` (storé localement)

**Tabs internes** :
- **Transilien J** : Conflans Fin d'Oise (stop area 43135) ↔ Saint-Lazare (71359)
- **RER A** : Conflans-Sainte-Honorine (43169) ↔ centre Paris (Châtelet/Auber/Étoile)

**Aller** : query depuis Conflans, filtre destination vers Paris.
**Retour** : query depuis Paris, filtre direction Conflans.

**Affichage** :
- 4 prochains départs avec heure programmée + minutes restantes + statut (à l'heure / +X min / supprimé / inconnu)
- Bandeau perturbations en haut si messages SIRI présents
- État "dernier train" mis en avant si pas d'autre départ avant 5h du matin

**Tab actif par défaut** :
- Matin (avant 14h) : Aller en haut
- Après-midi/soir : Retour en haut

**Refresh** : au chargement + toutes les 2 min + manuel (bouton refresh).

### 4.3 Veille IA

**Sources** :
- Hacker News Algolia : `https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=20` + filtre points >= 30 ou commentaires >= 10
- RSS via rss2json (`https://api.rss2json.com/v1/api.json?rss_url=<feed>`) :
  - Anthropic : `https://www.anthropic.com/news/rss.xml`
  - OpenAI : `https://openai.com/blog/rss.xml`
  - DeepMind : `https://deepmind.com/blog/feed/basic/`
  - Hugging Face : `https://huggingface.co/blog/feed.xml`
  - Google AI blog : `https://blog.google/technology/ai/rss/`
  - arXiv cs.AI : `http://arxiv.org/rss/cs.AI`
  - (sources customisables par l'utilisateur dans settings)

**Normalisation** : `{ title, url, source, date, summary, image }`

**Tri** : par date desc, dedup par URL canonique.

**Affichage** :
- Cards avec source pill, temps écoulé, titre en gros, extrait court (2 lignes max)
- Tap card : ouvre l'URL externe (target=_blank, sécurité noopener)
- "Mark as read" local : sources lues passent en grisé
- Filtre par source (chip togglable)

**Refresh** : au chargement + manuel (pull-down ou bouton).

### 4.4 Capture rapide

- Zone de texte fixe en bas de section (style sticky bottom de section, pas global)
- Sauvegarde Enter (sur ligne unique) ou bouton "Ajouter" (multi-ligne)
- Auto-détection de tags `#xxx` dans le texte
- Liste antichrono des captures
- Champ recherche full-text + filtre par tag (cliquables)
- Stockage : `state.captures = [{ id, text, tags, date }]`

### 4.5 Tâches du jour

- Input "Ajouter une tâche…" + Enter
- Liste : tap pour cocher/décocher (autosave)
- Swipe gauche pour delete (ou bouton corbeille mini)
- À minuit local, les non-faites passent en gris "hier" (avec date)
- Compteur "X / Y faites aujourd'hui"
- Stockage : `state.todos = [{ id, text, done, createdAt, completedAt }]`

### 4.6 Habitudes

- Liste de habitudes paramétrables (CRUD dans settings)
- Pour chaque habitude : ligne avec nom + 7 cercles (semaine glissante, lundi → dimanche)
- Tap sur un cercle pour cocher
- Habitudes par défaut suggérées (modifiables) : "2L d'eau", "Marcher 30 min", "Lire", "Pas d'écran avant 21h"
- Stockage : `state.habits = { definitions: [{id, name}], log: { habitId: { 'YYYY-MM-DD': true } } }`

### 4.7 Liens rapides

- Grille de pavés cliquables (3 colonnes)
- Chaque lien : icône (initiale ou favicon auto-fetch), label, URL
- CRUD dans settings
- Defaults suggérés au premier lancement : ADO, Slack, Outlook, Younited intranet
- Stockage : `state.links = [{ id, label, url, color? }]`

## 5. Settings

Modal plein écran depuis l'icône engrenage. Sections :

1. **Clé API IDFM** : input + lien vers inscription PRIM
2. **Stops trains** : édition des stop area IDs (avec valeurs par défaut hardcodées)
3. **Sources veille IA** : liste avec checkbox actif/inactif + bouton "Ajouter source RSS"
4. **Liens rapides** : CRUD
5. **Habitudes** : CRUD
6. **Export / Import JSON** : tout le state, download / upload
7. **Reset complet**

## 6. Direction visuelle (reprise du tracker santé)

- Couleurs identiques : `#0A0A0F` fond, `#7FD1B9` accent, `#E26D5C` danger
- Inter variable depuis Google Fonts
- Cards en glassmorphism : `rgba(255,255,255,0.03)`, blur 14px, bordure 1px à 8%
- Section titles en uppercase letterspaced
- Tabular numerals
- Splash screen iOS (6 tailles) + meta tags PWA standalone
- Pas d'emoji, icônes SVG Lucide-style

**Icône d'app** : motif différent du tracker santé (qui est un soleil) — un **astre à 4 branches** (étoile minimaliste / sparkle géométrique), même palette vert d'eau sur fond sombre dégradé.

## 7. Décisions explicites

**Dans v1** : météo header, trains aller+retour (J + RER A), veille IA, captures, todos, habitudes, liens rapides, settings, export/import, PWA iOS complet.

**Pas dans v1** :
- Auth / multi-appareils / sync cloud
- Calendrier Outlook/Google (OAuth)
- Chat LLM
- Notifications push
- Read-later (existe déjà séparément dans ai-backlog)

## 8. Critères de succès

1. L'écran d'accueil iPhone affiche une vraie icône Cockpit
2. À l'ouverture, le matin, on voit en moins de 3 sec : météo, prochains trains aller, captures récentes
3. Saisie d'une tâche / capture en < 5 sec
4. La veille IA charge en moins de 5 sec sur réseau correct
5. Tout est utilisable hors-ligne (sauf APIs live qui montrent des données en cache)
