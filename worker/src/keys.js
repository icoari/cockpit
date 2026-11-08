// KV keys — everything lives under one prefix in the single KV namespace.

const KV_PREFIX = 'bobsync:';

export const KEY_SALT = KV_PREFIX + 'salt';
export const KEY_AUTH = KV_PREFIX + 'authHash';
export const KEY_DATA = KV_PREFIX + 'data';
export const KEY_FEED = KV_PREFIX + 'feed';
export const KEY_SOURCES = KV_PREFIX + 'sources';
export const KEY_PUSH = KV_PREFIX + 'push';
export const KEY_MONITORING = KV_PREFIX + 'monitoring';
export const KEY_ALERTED_DISRUPTIONS = KV_PREFIX + 'alertedDisruptions';
export const KEY_HEALTH_PING = KV_PREFIX + 'healthPing';
export const KEY_LAST_TRAIN_ALERTED = KV_PREFIX + 'lastTrainAlerted';
export const KEY_TREATMENT = KV_PREFIX + 'treatment';      // medication schedule
export const KEY_MED_STATE = KV_PREFIX + 'medState';        // today's taken/alerted doses
export const KEY_GOOGLE = KV_PREFIX + 'google';             // Google Calendar refresh token

// Every key a wipe must remove.
export const ALL_KEYS = [
  KEY_SALT, KEY_AUTH, KEY_DATA, KEY_FEED, KEY_SOURCES, KEY_PUSH,
  KEY_MONITORING,            // holds the plaintext IDFM key
  KEY_HEALTH_PING, KEY_ALERTED_DISRUPTIONS, KEY_LAST_TRAIN_ALERTED,
  KEY_TREATMENT, KEY_MED_STATE, KEY_GOOGLE,
];
