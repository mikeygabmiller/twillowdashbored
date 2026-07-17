#!/usr/bin/env bash
# SessionStart hook: puts the deploy contract in front of every session so nobody
# repeats the "it looked deployed but wasn't" mistake. Output goes into context.
cat <<'NOTE'
================  DEPLOY CONTRACT — READ BEFORE CLAIMING ANYTHING IS "LIVE"  ================
LIVE URL:          https://texting.mikeysdetailingsnohomish.workers.dev
PRODUCTION BRANCH: claude/qqc-submission-auto-text-cspjc3
  -> This is the ONLY branch Cloudflare deploys to the live URL. To ship: open a PR
     INTO this branch and merge it. Pushing to any other branch builds a PREVIEW only.

BUMP THE BUILD FINGERPRINT on every ship (keep both identical):
  - src/index.js      -> const BUILD   = 'YYYY-MM-DD·label'
  - public/index.html -> var   APP_BUILD = 'YYYY-MM-DD·label'

VERIFY LIVE THE RIGHT WAY (the live URL is the only source of truth):
  - GET https://texting.mikeysdetailingsnohomish.workers.dev/api/version  -> {"build": "..."}
    must equal APP_BUILD, OR the dashboard ☰ footer must read "... ✓ live".
  - DO NOT trust as "live": "I pushed it", the Worker's modified_on, the version list,
    or code from the Cloudflare MCP (workers_get_worker_code). Those ALL change for
    PREVIEW builds off non-production branches and do NOT mean the live URL updated.

OTHER GOTCHAS:
  - The GitHub default branch may be stale — never target it for a deploy.
  - Live Worker is "texting"; "mikeys-detailing-sms" is old/unused — ignore it.
  - Installed as a PWA? After a prod deploy, fully close & reopen so the service
    worker drops the old cached shell.
  - Full details: see DEPLOY.md.
===========================================================================================
NOTE
