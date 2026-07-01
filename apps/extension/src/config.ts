/**
 * Centralized runtime configuration.
 *
 * Every host/URL the extension talks to is resolved here from build-time env
 * vars injected by Vite (see `define` in vite.config.ts). The per-instance
 * values live in `.env.qa` / `.env.production` and are selected via `--mode`:
 *
 *   npm run build:qa     -> QA   (reportsv1 host)
 *   npm run build:prod   -> Prod (bestq host)
 *
 * Do NOT hardcode instance URLs anywhere else — import from this module.
 *
 * Note: the `import.meta.env.VITE_*` references below are STATIC on purpose so
 * Vite's `define` replaces each with a string literal at build time. Avoid
 * computed access like `import.meta.env[key]`, which makes Vite inline the
 * whole env object (and leak unrelated vars) instead.
 */

/** ReportPortal frontend host, e.g. https://bestq.best-quality.in */
export const RP_HOST: string = import.meta.env.VITE_RP_HOST || 'http://localhost:3000';

/** ReportPortal Java API base, e.g. https://bestq.best-quality.in/api */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL || `${RP_HOST}/api`;

/** ReportPortal SSO token endpoint (password + refresh_token grants). */
export const SSO_TOKEN_URL: string =
  import.meta.env.VITE_SSO_TOKEN_URL || `${RP_HOST}/uat/sso/oauth/token`;

/** Basic auth header for the SSO token endpoint. */
export const SSO_AUTH_HEADER = 'Basic dWk6dWltYW4=';

/**
 * ReportPortal login page. For "Continue with Google" the background opens this
 * in a hidden (background) tab to prime the frontend session/CSRF, then
 * auto-advances that tab to Google's account chooser and only brings it to the
 * front once Google is reached — so the user never sees a ReportPortal page.
 * (Hitting the OAuth endpoint cold, without a real /ui/ load first, fails with
 * "Bad credentials".)
 *
 * ReportPortal's Google flow is session/cookie based: after the Google
 * round-trip it loads /ui/ and calls the API with `Authorization: Bearer <jwt>`.
 * The token never appears in a tab URL, so `background/index.ts` captures that
 * bearer JWT off the UI's own API requests via chrome.webRequest and signs the
 * extension in with it.
 */
export const RP_LOGIN_URL: string = import.meta.env.VITE_RP_LOGIN_URL || `${RP_HOST}/ui/#login`;

/**
 * Human-readable label for the build instance — e.g. "QA" or "Production".
 * Set per-instance in `.env.qa` / `.env.production` via `VITE_INSTANCE_LABEL`.
 * Empty in local dev builds (no badge shown).
 */
export const INSTANCE_LABEL: string = import.meta.env.VITE_INSTANCE_LABEL || '';

/** True when this build targets the production instance. */
export const IS_PRODUCTION: boolean = /prod/i.test(INSTANCE_LABEL);

/** Hostname of the configured frontend host — used to match the OAuth callback tab. */
export const RP_HOSTNAME: string = (() => {
  try {
    return new URL(RP_HOST).hostname;
  } catch {
    return 'localhost';
  }
})();
