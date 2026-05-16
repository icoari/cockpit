// Lucide-style SVG icons (stroke-based, minimalist)
const svg = (paths, attrs = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${attrs}>${paths}</svg>`;

export const ICONS = {
  // weather conditions (WMO codes → lucide-style)
  sun:           svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
  cloud:         svg('<path d="M17.5 19a4.5 4.5 0 1 0-1.41-8.78A6 6 0 1 0 6.5 19h11z"/>'),
  cloudSun:      svg('<path d="M12 2v2M5.22 5.22l1.42 1.42M2 12h2M19 5l-1.42 1.42"/><circle cx="13" cy="11" r="3"/><path d="M16.5 18a3.5 3.5 0 1 0-1-6.85A4.5 4.5 0 1 0 7.5 18h9z"/>'),
  cloudRain:     svg('<path d="M17 17a5 5 0 1 0-1.65-9.71A6 6 0 1 0 6 17"/><line x1="9" y1="20" x2="9" y2="22"/><line x1="13" y1="20" x2="13" y2="22"/><line x1="17" y1="20" x2="17" y2="22"/>'),
  cloudSnow:     svg('<path d="M17 17a5 5 0 1 0-1.65-9.71A6 6 0 1 0 6 17"/><circle cx="9" cy="21" r=".5"/><circle cx="13" cy="21" r=".5"/><circle cx="17" cy="21" r=".5"/>'),
  cloudFog:      svg('<path d="M17 14a5 5 0 1 0-1.65-9.71A6 6 0 1 0 6 14"/><line x1="3" y1="18" x2="21" y2="18"/><line x1="5" y1="22" x2="19" y2="22"/>'),
  thunder:       svg('<path d="M17 17a5 5 0 1 0-1.65-9.71A6 6 0 1 0 6 17"/><polyline points="11 13 9 17 13 17 11 21"/>'),
  moon:          svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),

  // UI
  settings:      svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  refresh:       svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  trash:         svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>'),
  close:         svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  plus:          svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  external:      svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
  search:        svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  train:         svg('<circle cx="6" cy="6" r="1.8"/><path d="M6 7.8v6.2a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3"/><circle cx="18" cy="20" r="1.8"/>'),
  zap:           svg('<polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  note:          svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>'),
  check:         svg('<polyline points="20 6 9 17 4 12"/>'),
  flame:         svg('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
  link:          svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  newspaper:     svg('<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2V9a1 1 0 0 1 1-1h3"/><line x1="9" y1="7" x2="19" y2="7"/><line x1="9" y1="11" x2="19" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>'),
  chevronDown:   svg('<polyline points="6 9 12 15 18 9"/>'),
  fuel:          svg('<line x1="3" y1="22" x2="15" y2="22"/><line x1="4" y1="9" x2="14" y2="9"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5"/>'),
  mapPin:        svg('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'),
  home:          svg('<path d="M12 21s-7-4.5-7-11a4.5 4.5 0 0 1 7-3 4.5 4.5 0 0 1 7 3c0 6.5-7 11-7 11z"/>'),
  briefcase:     svg('<path d="M12 3l2 5.5 5.5 1L15 13l1.5 6L12 16l-4.5 3L9 13 4.5 9.5 10 8.5z"/>'),
};

export const weatherCodeIcon = (code, isDay = true) => {
  if (code === 0 || code === 1) return isDay ? ICONS.sun : ICONS.moon;
  if (code === 2) return ICONS.cloudSun;
  if (code === 3) return ICONS.cloud;
  if (code === 45 || code === 48) return ICONS.cloudFog;
  if (code >= 51 && code <= 67) return ICONS.cloudRain;
  if (code >= 71 && code <= 77) return ICONS.cloudSnow;
  if (code >= 80 && code <= 82) return ICONS.cloudRain;
  if (code >= 85 && code <= 86) return ICONS.cloudSnow;
  if (code >= 95) return ICONS.thunder;
  return ICONS.cloud;
};

export const weatherCodeLabel = (code) => {
  if (code === 0) return 'Ciel clair';
  if (code === 1) return 'Plutôt clair';
  if (code === 2) return 'Partiellement nuageux';
  if (code === 3) return 'Couvert';
  if (code === 45 || code === 48) return 'Brouillard';
  if (code >= 51 && code <= 57) return 'Bruine';
  if (code >= 61 && code <= 67) return 'Pluie';
  if (code >= 71 && code <= 77) return 'Neige';
  if (code >= 80 && code <= 82) return 'Averses';
  if (code >= 85 && code <= 86) return 'Neige';
  if (code >= 95) return 'Orage';
  return '';
};
