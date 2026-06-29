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

/** Hostname of the configured frontend host — used to match the OAuth callback tab. */
export const RP_HOSTNAME: string = (() => {
  try {
    return new URL(RP_HOST).hostname;
  } catch {
    return 'localhost';
  }
})();
