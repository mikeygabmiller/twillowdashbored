// Matins — Worker entry. Cron builds and sends the day's issue; the fetch
// handler carries signup, double opt-in, unsubscribe, and a small read API.
//
import { config } from './config.js';
import { buildIssue } from './lib/issue.js';
import { makeStore, saveIssue, ISSUE_INDEX_KEY } from './lib/store.js';
import { publishIssue } from './lib/publish.js';
import { sendIssue, sendOne } from './lib/send.js';
import { subscribe, confirm, unsubscribe, activeSubscribers, subscriberCounts } from './lib/subscribers.js';
import { renderNotice, renderSignupPage, renderIssuePage, renderArchivePage } from './render/web.js';
import { renderEmail } from './render/email.js';
import { json, html } from './lib/http.js';
import { safeEqualString, makeToken, normalizeEmail } from './lib/tokens.js';
import { listModels } from './lib/llm.js';
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

      // The Worker serves the archive too, from KV. GitHub Pages is the public
      // home and the shareable permalink, but this means an issue is readable
      // the moment it is built — before Pages is wired up, or if a publish
      // fails. Links stay on this origin so browsing here is self-consistent.
      const localCfg = { ...cfg, siteUrl: cfg.workerUrl };
      const pageMatch = path.match(/^\/(\d{4}-\d{2}-\d{2})$/);
      if (pageMatch) {
        const issue = await store.getJson(`issue:${pageMatch[1]}`);
        if (!issue) {
          return html(
            renderNotice({ cfg: localCfg, title: 'Nothing for that day', message: 'No issue has been built for that date yet.' }),
            { status: 404 }
          );
        }
        return html(renderIssuePage(issue, { cfg: localCfg, index: await store.getJson(ISSUE_INDEX_KEY, []) }));
      }
      if (path === '/archive') {
        return html(renderArchivePage(await store.getJson(ISSUE_INDEX_KEY, []), { cfg: localCfg }));
      }
      if (path === '/today') {
        const [latest] = await store.getJson(ISSUE_INDEX_KEY, []);
        return latest
          ? Response.redirect(`${cfg.workerUrl}/${latest.date}`, 302)
          : html(renderNotice({ cfg: localCfg, title: 'Not yet', message: 'The first issue has not been built.' }), { status: 404 });
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
        // "Unauthorized" conflates two very different problems: a wrong token,
        // and no token configured at all. Saying which costs nothing — that the
        // secret is unset is not a secret — and saves a blind hunt.
        if (!cfg.adminToken) {
          // Reached only while the Worker is unconfigured, and it reports names
          // and booleans — never a value. Which OTHER secrets arrive is the
          // whole diagnosis: none means they went to a different Worker or to
          // the build-time settings; some means this one name is wrong.
          return json({ error: 'admin is not configured', ...bindingReport(env), build: BUILD }, { status: 503, headers: cors() });
        }
        if (!adminAuthorized(request, url, cfg)) {
          return json({ error: 'unauthorized', ...mismatchReport(request, url, cfg, env) }, { status: 401, headers: cors() });
        }

        // Dry run in production: builds and renders, sends and marks nothing.
        if (path === '/admin/preview') {
          const date = url.searchParams.get('date') || todayIn(cfg.sendTz);
          if (!isValidDate(date)) return json({ error: 'bad date' }, { status: 400, headers: cors() });
          const issue = await buildIssue({ date, cfg, store: readOnlyStore(store), dryRun: true, seedBadBlock: url.searchParams.get('seedBad') === '1' });
          if (url.searchParams.get('format') === 'html') return html(renderEmail(issue, { cfg }).html);
          return json(issue, { headers: cors() });
        }

        // One issue, to one address, on demand. Deliberately touches nothing:
        // no KV write, no publish, no `sent:<date>` lock, and the rotation is
        // read through a store that throws writes away — so firing this at
        // noon cannot change which prayer the real 5am send uses, and cannot
        // make the cron think it has already run. Send it as often as you like.
        //
        // POST only. It sends mail, so it must not be reachable by a URL in a
        // browser history, a chat message, or a request log.
        if (path === '/admin/send-me' && request.method === 'POST') {
          const date = url.searchParams.get('date') || todayIn(cfg.sendTz);
          if (!isValidDate(date)) return json({ error: 'bad date' }, { status: 400, headers: cors() });
          const to = normalizeEmail(url.searchParams.get('to'));
          if (!to) return json({ error: 'a valid ?to= address is required' }, { status: 400, headers: cors() });

          const issue = await buildIssue({ date, cfg, store: readOnlyStore(store), dryRun: true });
          // A real token, so the unsubscribe link in the test copy is the same
          // live link a subscriber would get rather than a dead one.
          const token = await makeToken({ secret: cfg.tokenSecret, purpose: 'unsub', email: to });
          const unsubscribeUrl = `${cfg.workerUrl}/unsubscribe?t=${encodeURIComponent(token)}`;
          const rendered = renderEmail(issue, { cfg, unsubscribeUrl, permalink: `${cfg.siteUrl}/${issue.date}/` });
          const sent = await sendOne({
            cfg,
            to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            headers: {
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          });
          return json(
            {
              ...sent,
              to,
              date,
              subject: rendered.subject,
              headline: issue.headline,
              status: issue.status,
              // The whole point of firing this by hand is judging the writing.
              writing: {
                form: issue.safetyReport.reflectionForm,
                blocks: issue.safetyReport.blocks,
                dropped: issue.safetyReport.dropped,
                degraded: issue.safetyReport.degraded,
              },
              note: 'Nothing was recorded. No KV write, no publish, and the daily send is still free to run.',
            },
            { status: sent.ok ? 200 : 502, headers: cors() }
          );
        }

        if (path === '/admin/run' && request.method === 'POST') {
          const date = url.searchParams.get('date') || todayIn(cfg.sendTz);
          const force = url.searchParams.get('force') === '1';
          return json(await runDaily({ cfg, store, date, force, send: url.searchParams.get('send') !== '0' }), { headers: cors() });
        }

        // Which models this key can actually reach. Names change; look, don't guess.
        if (path === '/admin/models') return json(await listModels({ cfg }), { headers: cors() });

        if (path === '/admin/status') {
          const date = todayIn(cfg.sendTz);
          return json({
            build: BUILD,
            date,
            sendPaused: cfg.sendPaused,
            sentToday: await store.getJson(`sent:${date}`),
            subscribers: await subscriberCounts(store),
            provider: cfg.llmProvider,
            model: cfg.llmModel,
            fromEmail: cfg.fromEmail,
            // Which secrets are present — never their values.
            secretsSet: {
              LLM_API_KEY: !!cfg.llmApiKey,
              RESEND_API_KEY: !!cfg.resendKey,
              TOKEN_SECRET: !!cfg.tokenSecret,
              GITHUB_TOKEN: !!cfg.githubToken,
            },
            // Non-empty means a binding name had stray whitespace and was
            // trimmed to make it work. Fix the name; do not rely on this.
            bindingNameWarnings: cfg.bindingNameWarnings,
            lastEmailError: await store.getJson('diag:lastEmailError'),
          }, { headers: cors() });
        }
      }

      // The signup page, for the Worker origin. (GitHub Pages serves its own
      // copy of the same markup — see scripts/build-site.mjs.)
      if (path === '/') return html(renderSignupPage({ cfg, subscribeEndpoint: `${cfg.workerUrl}/subscribe` }));

      // CORS even on the miss: without it a browser reports a 404 as an
      // opaque network failure, which sends you looking for an outage instead
      // of a route that does not exist on the build you have deployed.
      return json({ error: 'not found', path, build: BUILD }, { status: 404, headers: cors() });
    } catch (err) {
      console.error('fetch error', err?.stack || err);
      return json({ error: 'unexpected error' }, { status: 500, headers: cors() });
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

  const published = await publishIssue({ issue, index, cfg, loadIssue: (d) => store.getJson(`issue:${d}`) });
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

// Why a secret "that is definitely set" is not here.
//
// Booleans per expected name could not tell the three real causes apart: a
// mistyped name, a value that never reached the running version, and looking
// at a different Worker. The names of the bindings this Worker actually
// received tell all three apart at a glance, and a name is not a secret — no
// value is read, and none of these fields can contain one.
const EXPECTED_SECRETS = ['ADMIN_TOKEN', 'RESEND_API_KEY', 'LLM_API_KEY', 'TOKEN_SECRET', 'GITHUB_TOKEN'];

// Case, spaces, hyphens and stray underscores all look identical in a
// dashboard table and are the usual culprits.
const squash = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

function bindingReport(env) {
  const present = Object.keys(env || {}).sort();
  const presentSquashed = new Map(present.map((k) => [squash(k), k]));
  const missing = EXPECTED_SECRETS.filter((k) => !present.includes(k));

  // A name that is nearly right is the single most likely explanation, and the
  // one a boolean can never surface.
  const lookalikes = {};
  for (const want of missing) {
    const near = presentSquashed.get(squash(want));
    if (near && near !== want) lookalikes[want] = `this Worker has "${near}" instead — the name must match exactly`;
  }

  return {
    worker: env?.APP_NAME || 'unknown',
    bindingsThisWorkerReceived: present,
    missing,
    lookalikes: Object.keys(lookalikes).length ? lookalikes : undefined,
    hint: diagnose({ present, missing, lookalikes }),
  };
}

function diagnose({ present, missing, lookalikes }) {
  if (!missing.length) return 'Every expected secret is here. If admin still fails, ADMIN_TOKEN is set to an empty string.';
  if (Object.keys(lookalikes).length) return 'A name is wrong, not a value. See "lookalikes" — rename the binding to match exactly, then deploy.';
  if (missing.length === EXPECTED_SECRETS.length) {
    return 'No expected secret reached this Worker. Either this is the wrong Worker (check you are in "matins", not "texting"), or the values went to Settings → Build, whose variables only exist while the build runs, rather than the Worker\'s own Settings → Variables and Secrets.';
  }
  return `Some secrets arrive and ${missing.join(' and ')} do not, so the names are reaching the right Worker but these values are not on the version that is actually serving. In the dashboard, editing Variables and Secrets stages a NEW version — it is not live until you deploy it, and any redeploy in between (a push that triggers Workers Builds) publishes a version built from the last deployed bindings, silently leaving the staged ones behind. Fix: Deployments → deploy the newest version, or set them with "wrangler secret put ${missing[0]}", which applies to the live Worker immediately. Then re-check this URL. Bindings actually received: ${present.join(', ') || 'none'}.`;
}

// Why a token "that is definitely right" does not match.
//
// Nothing here reveals the stored token. It reports comparative facts only —
// whether the two are the same length, where the supplied one came from, and
// whether more than one binding could be supplying it. One bit about length is
// worth an evening, and it is the bit that separates "you are comparing
// against a different value entirely" from "one character is wrong".
function mismatchReport(request, url, cfg, env) {
  const header = bearer(request);
  const query = request.method === 'GET' ? url.searchParams.get('token') : null;
  const supplied = header ?? query ?? '';

  // Two bindings whose names differ only by whitespace both look like
  // ADMIN_TOKEN in the dashboard. The exactly-named one wins, and it is not
  // necessarily the row that was just edited.
  const adminTokenBindings = Object.keys(env || {}).filter((k) => k.trim() === 'ADMIN_TOKEN');

  const report = {
    suppliedVia: header ? 'Authorization header' : query ? 'token query parameter' : 'nothing was supplied',
    lengthsMatch: supplied.length === cfg.adminToken.length,
    adminTokenBindings,
    // Short tokens travel in URLs and this route can email every subscriber.
    weakStoredToken: cfg.adminToken.length < 16 || undefined,
  };

  if (!supplied) {
    report.hint =
      'No token arrived. A POST must carry it as an Authorization: Bearer header — the query parameter is accepted on GET only, deliberately, because that is the form that ends up in logs.';
  } else if (adminTokenBindings.length > 1) {
    report.hint = `There is more than one ADMIN_TOKEN binding on this Worker (${adminTokenBindings
      .map((k) => JSON.stringify(k))
      .join(' and ')}). The exactly-named one wins, and it is probably holding an older value than the row you just edited. Delete every one of them, then add a single ADMIN_TOKEN.`;
  } else if (!report.lengthsMatch) {
    report.hint =
      'The token you sent and the one stored are different lengths, so this is not a typo — the Worker is comparing against a different value than the one you think you set. Most likely the stored value was never replaced, or it was edited on a version that is not the one serving. Delete ADMIN_TOKEN, add it again, deploy, and try once more.';
  } else {
    report.hint =
      'Same length, different content. That is a character-level difference: a capital I against a lowercase l, a zero against an O, or an invisible character carried in on a paste. Retype both by hand rather than pasting.';
  }

  if (report.weakStoredToken) {
    report.warning =
      'The stored token is under 16 characters. This route can rebuild the site and email every confirmed subscriber, and the token travels in URLs on GET. Use a long random string of letters and digits.';
  }
  return report;
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

// The Authorization header is the real mechanism. Read-only GET routes also
// accept ?token=, so a preview can be opened from a phone browser — which
// cannot set headers. That puts the token in URLs and request logs, so the one
// route that actually builds and sends (POST /admin/run) never accepts it.
function adminAuthorized(request, url, cfg) {
  if (!cfg.adminToken) return false;
  const header = bearer(request);
  if (header && safeEqualString(header, cfg.adminToken)) return true;
  if (request.method !== 'GET') return false;
  const query = url.searchParams.get('token');
  return !!query && safeEqualString(query, cfg.adminToken);
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
