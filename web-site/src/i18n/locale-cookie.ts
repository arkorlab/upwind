import { LOCALE_COOKIE } from './locales.ts';

/**
 * How a chosen language is written down, in the one shape both writers use.
 *
 * Two things record a choice: the switcher's Server Action (`app/actions/locale.ts`), and the proxy
 * when a visitor asks for English by name (`/en`). A cookie written two ways would be two cookies as
 * far as a browser is concerned — a different `path` or `secure` flag is a different cookie — and the
 * proxy reads back what either of them wrote.
 *
 * `httpOnly`, because nothing in the browser reads this: the proxy does.
 */

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_YEAR = 365;
const ONE_YEAR_SECONDS = SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY * DAYS_PER_YEAR;

export const localeCookieOptions = {
  name: LOCALE_COOKIE,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: ONE_YEAR_SECONDS,
} as const;
