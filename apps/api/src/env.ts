// Centralized env access. Throws on missing required vars at first read.

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env: ${name}`);
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  get NODE_ENV() {
    return optional('NODE_ENV', 'development');
  },
  get PORT() {
    return Number.parseInt(optional('PORT', '8787'), 10);
  },
  get DATABASE_URL() {
    return required('DATABASE_URL');
  },
  get JWT_SECRET() {
    return required('JWT_SECRET');
  },
  get COOKIE_DOMAIN() {
    return optional('COOKIE_DOMAIN', '');
  },
  get APP_URL() {
    return optional('APP_URL', 'http://localhost:3000');
  },
  /**
   * Comma-separated list of additional origins allowed to call the API with
   * credentials. APP_URL is always allowed implicitly. Chrome extension
   * origins (`chrome-extension://<id>`) belong here.
   */
  get ALLOWED_ORIGINS() {
    return optional('ALLOWED_ORIGINS', '');
  },
  get RESEND_API_KEY() {
    return optional('RESEND_API_KEY');
  },
  get RESEND_FROM() {
    return optional('RESEND_FROM', 'Feed Sorter <login@feedsorter.app>');
  },
  get GROQ_API_KEY() {
    return optional('GROQ_API_KEY');
  },
  get GEMINI_API_KEY() {
    return optional('GEMINI_API_KEY');
  },
  /**
   * Base URL of a whisperX REST sidecar (POST /transcribe). When set, the
   * transcribe handler routes audio here instead of Groq Whisper.
   * e.g. `http://localhost:8787` (local sidecar) or a private deploy.
   */
  get WHISPERX_URL() {
    return optional('WHISPERX_URL');
  },
  get OPENAI_API_KEY() {
    return optional('OPENAI_API_KEY');
  },
  get STRIPE_SECRET_KEY() {
    return optional('STRIPE_SECRET_KEY');
  },
  get STRIPE_WEBHOOK_SECRET() {
    return optional('STRIPE_WEBHOOK_SECRET');
  },
  get STRIPE_PRICE_PRO() {
    return optional('STRIPE_PRICE_PRO');
  },
  get STRIPE_PRICE_PRO_FOUNDING() {
    return optional('STRIPE_PRICE_PRO_FOUNDING');
  },
  get STRIPE_PRICE_STUDIO() {
    return optional('STRIPE_PRICE_STUDIO');
  },
  get IS_PROD() {
    return this.NODE_ENV === 'production';
  },
  /**
   * Dev-only override: when set to `pro` or `studio`, the `requireTier`
   * middleware treats every authenticated user as that tier. Hard-failsafe:
   * ignored when NODE_ENV === 'production'. Use only against local DBs.
   */
  get DEV_FORCE_TIER() {
    return optional('DEV_FORCE_TIER', '');
  },
};
