/**
 * Scheduled-send dispatcher.
 * Runs on a cron every 5 minutes and sends any scheduled messages that are due.
 * (5-minute granularity keeps cron invocations light on Netlify's free tier.)
 */
import { dispatchDueScheduled } from '../lib/core.mjs';

export const config = { schedule: '*/5 * * * *' };

export default async () => {
  const sent = await dispatchDueScheduled();
  return new Response(`dispatched ${sent} scheduled message(s)`);
};
