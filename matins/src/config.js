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
};

// How many recent issues a prayer / Q&A must sit out before it can come back.
export const ROTATION_COOLDOWN = { prayer: 10, qa: 14 };

// Model defaults per provider. Deliberately small + cheap; this is short-form
// devotional prose and a rubric check, not reasoning work.
export const MODEL_DEFAULTS = {
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-2.5-flash',
};

export const TEMPERATURE = { generate: 0.3, safety: 0 };

export function config(env = {}) {
  const get = (k) => (env[k] === undefined || env[k] === '' ? DEFAULTS[k] : env[k]);
  const provider = String(get('LLM_PROVIDER')).toLowerCase();
  return {
    appName: get('APP_NAME'),
    sendHour: Number(get('SEND_HOUR')),
    sendTz: get('SEND_TZ'),
    llmProvider: provider,
    llmModel: env.LLM_MODEL || MODEL_DEFAULTS[provider] || '',
    llmApiKey: env.LLM_API_KEY || '',
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
    // Worker origin, used for confirm/unsubscribe links in email.
    workerUrl: String(env.WORKER_URL || get('SITE_URL')).replace(/\/+$/, ''),
  };
}

// Founder line — warm, personal, on every surface.
export const FOOTER_LINE =
  'Made by a young Catholic in Snohomish County, Washington.';
