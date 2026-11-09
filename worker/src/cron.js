// Scheduled tasks — cron expression → tasks, plus the manual /cron/run hook.
//
// Cron schedule (UTC):
//   */10 * * * *     feed aggregation
//   */15 4-23 * * *  IDFM disruption watch
//   0 5 * * *        morning brief push (7h Paris summer)
//   0 16 * * *       last-train-of-tonight check (18h Paris summer)

import { json, requireAuth } from './http.js';
import { aggregateFeed } from './feed.js';
import { checkDisruptions, checkLastTrainsTonight } from './idfm.js';
import { sendMorningBriefPush } from './push.js';

// Task name → function. Names are the /cron/run?task= values.
const TASKS = {
  'feed':        aggregateFeed,
  'disruptions': checkDisruptions,
  'last-trains': checkLastTrainsTonight,
  'brief':       sendMorningBriefPush,
};

const SCHEDULE = {
  '*/10 * * * *':    ['feed'],
  '*/15 4-23 * * *': ['disruptions'],
  '0 5 * * *':       ['brief'],
  '0 16 * * *':      ['last-trains'],
};

// Runs every task concurrently; a failing task is logged and never stops
// the others. Never rejects.
export async function runTasks(names, env) {
  const results = await Promise.allSettled(names.map(name => Promise.resolve().then(() => TASKS[name](env))));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`cron task ${names[i]} failed`, r.reason);
  });
}

export function tasksForCron(cron) {
  return SCHEDULE[cron] || [];
}

export async function handleCronRun(request, env, url) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const task = url.searchParams.get('task') || '';
  if (!Object.hasOwn(TASKS, task)) return json({ error: 'unknown task' }, 400);
  await TASKS[task](env);
  return json({ ok: true, task });
}
