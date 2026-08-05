// Matins — Worker entry. Cron builds and sends the day's issue; the fetch
// handler carries signup, double opt-in, unsubscribe, and a small read API.
//
import { config } from './config.js';
import { buildIssue } from './lib/issue.js';
import { makeStore, saveIssue, ISSUE_INDEX_KEY } from './lib/store.js';
import { publishIssue } from './lib/publish.js';
import { sendIssue } from './lib/send.js';
import { subscribe, confirm, unsubscribe, activeSubscribers, subscriberCounts } from './lib/subscribers.js';
import { renderNotice, renderSignupPage } from './render/web.js';
import { renderEmail } from './render/email.js';
import { json, html } from './lib/http.js';
import { isValidDate } from './lib/calendar.js';
import { BUILD } from './build.js';

export default {
  async fetch(request, env, ctx) {
    const cfg = config({ ...env, WORKER_URL: new URL(request.url).origin });
    const store = makeStore(env.DEVOTIONAL);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

      if (path === '/api/version') return json({ build: BUILD, app: cfg.appName }, { headers: cors() });

      if (path === '/subscribe' && request.method === 'POST') {
        const email = await readEmail(request);
        const res = await subscribe({ store, cfg, rawEmail: email });
        if (wantsJson(request)) return json({ ok: res.ok, message: res.message }, { status: res.status, headers: cors() });
        return html(
          renderNotice({ cfg, title: res.ok ? 'One more click' : 'That did not work', message: res.message }),
          { status: res.status }
        );
      }

      if (path === '/confirm') {
        const res = await confirm({ store, cfg, token: url.searchParams.get('t') });
        return html(renderNotice({ cfg, title: res.ok ? 'Welcome' : 'Link not valid', message: res.message }), { status: res.status });
      }

      // GET for the visible link, POST for List-Unsubscribe one-click.
      if (path === '/unsubscribe') {
        const token = url.searchParams.get('t');
        const res = await unsubscribe({ store, cfg, token });
        if (request.method === 'POST') return new Response(res.message, { status: res.ok ? 200 : 400 });
        return html(renderNotice({ cfg, title: res.ok ? 'Unsubscribed' : 'Link not valid', message: res.message }), { status: res.status });
      }

      // Read API for the archive / anyone building on top of it.
      const issueMatch = path.match(/^\/api\/issue\/(\d{4}-\d{2}-\d{2})$/);
      if (issueMatch) {
        const issue = await store.getJson(`issue:${issueMatch[1]}`);
        return issue ? json(issue, { headers: cors() }) : json({ error: 'no issue for that date' }, { status: 404, headers: cors() });
      }
      if (path === '/api/archive') return json(await store.getJson(ISSUE_INDEX_KEY, []), { headers: cors() });

      // --- admin (ADMIN_TOKEN) --------------------------------------------
      if (path.startsWith('/admin/')) {
        if (!cfg.adminToken || bearer(request) !== cfg.adminToken) return json({ error: 'unauthorized' }, { status: 401 });

        // Dry run in production: builds and renders, sends and marks nothing.
        if (path === '/admin/preview') {
          const date = url.searchParams.get('date') || todayIn(cfg.sendTz);
          if (!isValidDate(date)) return json({ error: 'bad date' }, { status: 400 });
          const issue = await buildIssue({ date, cfg, store: readOnlyStore(store), dryRun: true, seedBadBlock: url.searchParams.get('seedBad') === '1' });
          if (url.searchParams.get('format') === 'html') return html(renderEmail(issue, { cfg }).html);
          return json(issue);
        }

        if (path === '/admin/run' && request.method === 'POST') {
          const date = url.searchParams.get('date') || todayIn(cfg.sendTz);
          const force = url.searchParams.get('force') === '1';
          return json(await runDaily({ cfg, store, date, force, send: url.searchParams.get('send') !== '0' }));
        }

        if (path === '/admin/status') {
          const date = todayIn(cfg.sendTz);
          return json({
            build: BUILD,
            date,
            sendPaused: cfg.sendPaused,
            sentToday: await store.getJson(`sent:${date}`),
            subscribers: await subscriberCounts(store),
            provider: cfg.llmProvider,
          });
        }
      }

      // The signup page, for the Worker origin. (GitHub Pages serves its own
      // copy of the same markup — see scripts/build-site.mjs.)
      if (path === '/') return html(renderSignupPage({ cfg, subscribeEndpoint: `${cfg.workerUrl}/subscribe` }));

      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error('fetch error', err?.stack || err);
      return json({ error: 'unexpected error' }, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    const cfg = config(env);
    const store = makeStore(env.DEVOTIONAL);
    const date = todayIn(cfg.sendTz);
    // Two crons cover the DST shift; only the one that lands on the configured
    // local hour does anything, and `sent:<date>` stops a double send anyway.
    if (hourIn(cfg.sendTz) !== cfg.sendHour) {
      console.log(`skip: local hour ${hourIn(cfg.sendTz)} is not SEND_HOUR ${cfg.sendHour}`);
      return;
    }
    ctx.waitUntil(
      runDaily({ cfg, store, date, force: false, send: true }).then((r) => console.log('daily run', JSON.stringify(r)))
    );
  },
};

// One build, both surfaces.
async function runDaily({ cfg, store, date, force, send }) {
  const already = await store.getJson(`sent:${date}`);
  if (already && !force) return { skipped: 'already sent', date, sent: already };

  const issue = await buildIssue({ date, cfg, store });
  const index = await saveIssue(store, issue);

  const published = await publishIssue({ issue, index, cfg });
  if (!published.ok) console.error('publish failed', published.errors.join('; '));

  let delivery = { skipped: 'sending paused' };
  if (send && !cfg.sendPaused) {
    const recipients = await activeSubscribers(store);
    delivery = await sendIssue({ issue, cfg, store, recipients });
    if (delivery.errors.length) console.error('send errors', delivery.errors.join('; '));
  }

  return {
    date,
    status: issue.status,
    headline: issue.headline,
    dropped: issue.safetyReport.dropped,
    degraded: issue.safetyReport.degraded,
    published: published.published,
    publishErrors: published.errors,
    delivery,
  };
}

function readOnlyStore(store) {
  return { ...store, putJson: async () => {}, del: async () => {} };
}

async function readEmail(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) return (await request.json().catch(() => ({}))).email;
  const form = await request.formData().catch(() => null);
  return form?.get('email');
}

function wantsJson(request) {
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json') || (request.headers.get('content-type') || '').includes('application/json');
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  };
}

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function hourIn(tz) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()));
}
