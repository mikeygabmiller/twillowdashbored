// One place for every knob. `env` is the Worker env in production and
// process.env in the preview CLI, so the same build code runs in both.

export const DEFAULTS = {
  APP_NAME: 'Matins',
  SEND_HOUR: '5',
  SEND_TZ: 'America/Los_Angeles',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: '',
  FROM_EMAIL: 'Matins <matins@example.com>',
  REPLY_TO: '',
  SITE_URL: 'https://mikeygabmiller.github.io/matins',
  CALENDAR_LOCALE: 'en-US',
  READINGS_API_BASE: 'https://cpbjr.github.io/catholic-readings-api',
  DR_API_BASE: 'https://bible-api.com',
  SITE_REPO: 'mikeygabmiller/matins',
  SITE_BRANCH: 'main',
  SEND_PAUSED: '1',
  ALERT_EMAIL: '',
  ADMIN_DIAGNOSTICS: '0',
};

// Signup is an unauthenticated route that causes mail to be sent, which makes
// it a way to point this Worker at somebody else's inbox. The ceilings are
// deliberately generous for a real person and useless for a script. KV is
// eventually consistent, so these are approximate under a burst from many
// colos at once — approximate is the difference between a nuisance and a
// burned sending domain.
export const SIGNUP_LIMITS = {
  perIpPerHour: 5,
  // How long a pending address waits before another confirmation is sent to
  // it. Stops one address being mailed repeatedly by resubmitting the form.
  resendCooldownSeconds: 15 * 60,
};

// How many recent issues a prayer / Q&A must sit out before it can come back.
export const ROTATION_COOLDOWN = { prayer: 10, qa: 14, form: 4 };

// How many drafts a generated block gets before a judge picks between them.
// One draft is a coin flip on tone; two and a comparison is most of the way to
// consistent. Cheap enough at one issue a day — see lib/judge.js.
export const DRAFTS = { reflection: 2, saintStory: 2, headline: 3 };

// Model defaults per provider. Deliberately small + cheap; this is short-form
// devotional prose and a rubric check, not reasoning work.
// Model names go stale faster than anything else in this file. These are only
// defaults — set LLM_MODEL to override, and hit GET /admin/models to see what
// the configured key can actually reach today rather than guessing.
export const MODEL_DEFAULTS = {
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-3.6-flash',
};

export const TEMPERATURE = { generate: 0.3, safety: 0 };

// The dashboard's value box takes a raw string, so a value pasted with the
// quotes still around it arrives as part of the value: LLM_MODEL becomes
// `"3.5"` rather than `3.5`, and a Reply-To header goes out malformed. Nothing
// legitimate here is wrapped in matching quotes, so stripping them is safe and
// saves a genuinely baffling afternoon.
function unquote(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    ? t.slice(1, -1).trim()
    : t;
}

// A binding name with a space on the end of it — "ADMIN_TOKEN " — is invisible
// in the dashboard table and matches nothing, so the secret is set, looks set,
// and does not exist as far as the code is concerned. Nobody has ever wanted a
// space there. Names are trimmed on the way in so this cannot cost an evening
// twice, and the names that needed it are reported by /admin/status rather
// than fixed silently.
function normaliseNames(rawEnv) {
  const env = {};
  const needTrimming = [];
  // Exact names first, so a correct binding always beats a malformed twin.
  for (const key of Object.keys(rawEnv)) {
    if (key === key.trim()) env[key] = unquote(rawEnv[key]);
  }
  for (const key of Object.keys(rawEnv)) {
    const clean = key.trim();
    if (clean === key) continue;
    needTrimming.push(key);
    if (env[clean] === undefined) env[clean] = unquote(rawEnv[key]);
  }
  return { env, needTrimming };
}

export function config(rawEnv = {}) {
  const { env, needTrimming } = normaliseNames(rawEnv);
  const get = (k) => (env[k] === undefined || env[k] === '' ? DEFAULTS[k] : env[k]);
  const provider = String(get('LLM_PROVIDER')).toLowerCase();
  return {
    appName: get('APP_NAME'),
    sendHour: Number(get('SEND_HOUR')),
    sendTz: get('SEND_TZ'),
    llmProvider: provider,
    llmModel: env.LLM_MODEL || MODEL_DEFAULTS[provider] || '',
    llmApiKey: env.LLM_API_KEY || '',
    // Blank means "don't send a thinking field at all" — see lib/llm.js.
    geminiThinkingBudget: env.GEMINI_THINKING_BUDGET == null ? '' : String(env.GEMINI_THINKING_BUDGET),
    resendKey: env.RESEND_API_KEY || '',
    fromEmail: get('FROM_EMAIL'),
    replyTo: get('REPLY_TO'),
    siteUrl: String(get('SITE_URL')).replace(/\/+$/, ''),
    calendarLocale: get('CALENDAR_LOCALE'),
    readingsApiBase: String(get('READINGS_API_BASE')).replace(/\/+$/, ''),
    drApiBase: String(get('DR_API_BASE') || '').replace(/\/+$/, ''),
    siteRepo: get('SITE_REPO'),
    siteBranch: get('SITE_BRANCH'),
    githubToken: env.GITHUB_TOKEN || '',
    tokenSecret: env.TOKEN_SECRET || '',
    adminToken: env.ADMIN_TOKEN || '',
    sendPaused: String(get('SEND_PAUSED')) === '1',
    alertEmail: get('ALERT_EMAIL'),
    // Unauthenticated binding/token diagnostics. Off unless deliberately on.
    adminDiagnostics: String(get('ADMIN_DIAGNOSTICS')) === '1',
    // Binding names that arrived with stray whitespace and had to be
    // trimmed to be usable. Empty is the healthy case.
    bindingNameWarnings: needTrimming,
    // Worker origin, used for confirm/unsubscribe links in email.
    workerUrl: String(env.WORKER_URL || get('SITE_URL')).replace(/\/+$/, ''),
  };
}

// Founder line — warm, personal, on every surface.
export const FOOTER_LINE =
  'Made by a young Catholic in Snohomish County, Washington.';
