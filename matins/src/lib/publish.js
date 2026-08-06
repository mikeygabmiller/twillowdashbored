// Publishing the web surface. On build, the issue is committed to the GitHub
// Pages repo as a permalink page, and the archive index and /today redirect
// are rewritten. Uses the contents API (one PUT per file) — no git, no build
// step, nothing for the Worker to keep in memory.
//
// Publishing failures never stop a send: the email is the promise, the site is
// the archive.

import { renderIssuePage, renderArchivePage, renderTodayRedirect, renderSignupPage } from '../render/web.js';
import { standaloneMarkSvg } from '../render/brand.js';
import { theme } from '../render/theme.js';

const API = 'https://api.github.com';

async function putFile({ cfg, path, content, message, onlyIfMissing = false, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  const url = `${API}/repos/${cfg.siteRepo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = {
    authorization: `Bearer ${cfg.githubToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': `${cfg.appName}-worker`,
    'content-type': 'application/json',
  };

  // Existing file? We need its blob sha to update it.
  let sha;
  const head = await f(`${url}?ref=${encodeURIComponent(cfg.siteBranch)}`, { headers });
  if (head.status === 200) {
    // Bootstrap files are written once and then left alone, so hand-edits to
    // the landing page survive every subsequent publish.
    if (onlyIfMissing) return { ok: true, path, skipped: 'already exists' };
    sha = (await head.json()).sha;
  } else if (head.status !== 404) {
    return { ok: false, path, error: `read ${head.status}: ${(await head.text()).slice(0, 160)}` };
  }

  const res = await f(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message, content: base64(content), branch: cfg.siteBranch, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) return { ok: false, path, error: `write ${res.status}: ${(await res.text()).slice(0, 160)}` };
  return { ok: true, path };
}

// Yesterday's page was written before today's existed, so its "next" link is
// missing. Re-rendering the one issue immediately before this one closes the
// chain, and costs a single extra PUT. `loadIssue` is optional: without it the
// site is still correct, just missing that one link.
async function previousPage({ issue, index, cfg, loadIssue }) {
  if (!loadIssue) return null;
  const i = index.findIndex((e) => e.date === issue.date);
  const prev = i >= 0 ? index[i + 1] : null;
  if (!prev) return null;
  const prevIssue = await loadIssue(prev.date).catch(() => null);
  if (!prevIssue) return null;
  return { path: `${prev.date}/index.html`, content: renderIssuePage(prevIssue, { cfg, index }) };
}

export async function publishIssue({ issue, index, cfg, fetchImpl, loadIssue }) {
  if (!cfg.githubToken) return { ok: false, published: [], errors: ['GITHUB_TOKEN is not set'] };
  const prev = await previousPage({ issue, index, cfg, loadIssue });
  const files = [
    { path: `${issue.date}/index.html`, content: renderIssuePage(issue, { cfg, index }) },
    ...(prev ? [prev] : []),
    { path: 'archive/index.html', content: renderArchivePage(index, { cfg }) },
    { path: 'today/index.html', content: renderTodayRedirect(issue.date, { cfg }) },
    { path: `issues/${issue.date}.json`, content: JSON.stringify(issue, null, 2) },
    // Written once, into an empty repo, so the site needs no local build step
    // and no files copied by hand. Never overwritten after that.
    { path: 'index.html', content: renderSignupPage({ cfg, subscribeEndpoint: `${cfg.workerUrl}/subscribe` }), onlyIfMissing: true },
    { path: 'mark.svg', content: standaloneMarkSvg(theme('green').accent), onlyIfMissing: true },
    { path: '.nojekyll', content: '', onlyIfMissing: true },
  ];
  const results = [];
  for (const file of files) {
    results.push(await putFile({ cfg, ...file, message: `${cfg.appName}: ${issue.date} — ${issue.headline}`, fetchImpl }));
  }
  const errors = results.filter((r) => !r.ok).map((r) => `${r.path}: ${r.error}`);
  return {
    ok: errors.length === 0,
    published: results.filter((r) => r.ok && !r.skipped).map((r) => r.path),
    skipped: results.filter((r) => r.skipped).map((r) => r.path),
    errors,
  };
}

function base64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
