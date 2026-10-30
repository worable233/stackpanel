/**
 * One password policy for every place a password enters the platform.
 *
 * Why this lives in the SDK: passwords are written by three different owners —
 * the kernel (`POST /auth/password`, admin reset, open platform, the setup
 * wizard), the login plugin (`/register`, self-service reset) and the browser
 * (the register/reset forms). Before this module each site carried its own
 * `z.string().min(8)`, which is how "8 characters, no upper bound, no
 * blocklist" became the de-facto policy. A single shared function makes the
 * browser hint, the plugin check and the kernel check the *same* rule, so a
 * form can never advertise something the server does not enforce.
 *
 * The rules follow NIST SP 800-63B §5.1.1.2 (length over composition, screen
 * against a blocklist, never truncate silently, accept Unicode):
 *
 * - **10–128 characters**, counted as Unicode code points. 10 is the floor we
 *   choose for a password-only account; the ceiling bounds the scrypt input so
 *   an oversized body cannot be turned into CPU work, and 128 is high enough
 *   that a passphrase or a generated secret never trips it.
 * - **Blocklist**: the classic top-100 list plus keyboard/number runs and
 *   character repetition. Composition rules ("must contain a symbol") are
 *   deliberately absent: they push people towards `Password1!`.
 * - **Identity screen**: the password may not be the account's email or contain
 *   its local part (when that part is long enough to be meaningful).
 *
 * The check returns a *stable code*, never a sentence: the same code travels as
 * the API problem `code` and is localised by the interface (`error.<code>`),
 * so every locale explains the failure in its own words (ADR-0012, ADR-0016).
 */

/** Minimum length, in Unicode code points. */
export const PASSWORD_MIN_LENGTH = 10;

/** Maximum length, in Unicode code points. */
export const PASSWORD_MAX_LENGTH = 128;

/** Stable reasons a password is refused. Each has an `error.<code>` message. */
export type PasswordIssueCode =
  'password.too_short' | 'password.too_long' | 'password.too_common' | 'password.matches_identity';

/** Result of {@link validatePassword}. */
export type PasswordCheck = { ok: true } | { ok: false; code: PasswordIssueCode };

/**
 * Locked-out choices: the passwords that appear at the top of every breach
 * corpus. Short, lower-cased and digit-stripped forms are compared, so
 * `Passw0rd!` and `p@ssword` are caught alongside `password`.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'passwords',
  'pass',
  'passwd',
  'password1',
  'password12',
  'password123',
  'password1234',
  'password12345',
  'password123456',
  'password1234567',
  'p@ssw0rd',
  'passw0rd',
  'pa55word',
  'admin',
  'admin123',
  'administrator',
  'root',
  'toor',
  'qwerty',
  'qwertyuiop',
  'qwertyui',
  'qwerty123',
  'qwerty1234',
  'asdfghjkl',
  'asdfghjk',
  'zxcvbnm',
  'zxcvbnmlk',
  'azerty',
  'iloveyou',
  'letmein',
  'letmein123',
  'welcome',
  'welcome1',
  'welcometothejungle',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'superman',
  'batman',
  'trustno1',
  'shadow',
  'master',
  'michael',
  'jennifer',
  'computer',
  'internet',
  'samsung',
  'google',
  'facebook',
  'starwars',
  'whatever',
  'freedom',
  'abc123',
  'abcd1234',
  'abcdef123',
  'abcdefg123',
  'a123456789',
  '123456789a',
  '1234567890',
  '123456789',
  '12345678',
  '12345678910',
  '123123123',
  '111111111',
  '000000000',
  '888888888',
  '666666666',
  '987654321',
  'qazwsxedc',
  '1q2w3e4r',
  '1q2w3e4r5t',
  '1qaz2wsx',
  'zaq12wsx',
  'qwe123asd',
  'asd123qwe',
  'changeme',
  'default',
  'secret',
  'secret123',
  'test1234',
  'testtest',
  'guest',
  'user',
  'user1234',
  'login',
  'master123',
  'lovelove',
  'lovely',
  'mypassword',
  'newpassword',
  'temppassword',
  'iloveyou1',
  'nicole',
  'daniel',
  'jordan23',
  'harley',
  'ranger',
  'buster',
  'soccer',
  'hockey',
  'killer',
  'george',
  'charlie',
  'andrew',
  'michelle',
  'jessica',
  'pepper',
  'ginger',
  'diamond',
  'orange',
  'purple',
  'banana',
  'chocolate',
  'cheese',
  'cookie',
  'startrek',
  'minecraft',
  'pokemon',
  'naruto',
  'sasuke',
  'goku1234',
  'woaini1314',
  '5201314',
  'woaini520',
  'a123456',
  'a1234567',
  'aa123456',
  'aa123456789',
  'abc123456',
  'qwertyuiop123',
  'qweasdzxc',
  'qweasd123',
  'qweqweqwe',
  'asdasdasd',
  'zxc123456',
  'password!',
  'password@123',
  'password#123',
  'password1!',
  'abc123abc',
  'aaa111aaa',
  '111111aa',
  'aaa11111',
  'administrator1',
  'letmein!',
  'welcome123',
  'welcome@123',
  'admin@123',
  'admin1234',
  'root1234',
  'stackpanel',
]);

/** Straight runs an attacker tries first, in both directions. */
const SEQUENCES = [
  '0123456789',
  '1234567890',
  '9876543210',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnm',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  '1q2w3e4r5t6y7u8i9o0p',
  '1qaz2wsx3edc4rfv',
  'qazwsxedcrfvtgb',
  'zaq12wsxcde34rfv',
];

/** NFKC-normalised, lower-cased form used for blocklist comparison. */
function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

/**
 * Leet substitutions, applied before punctuation is stripped.
 *
 * Without this, `P@ssw0rd!` reduces to `psswrd`, which is not on any list — the
 * exact bypass decoration is meant to defeat. With it, the password collapses
 * onto `password` and is caught.
 */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'l',
  '+': 't',
};

/** Letters and digits only: neutralises casing, leetspeak and punctuation. */
function condense(value: string, options: { leet?: boolean } = {}): string {
  let out = '';
  for (const char of normalize(value)) {
    if (options.leet && char in LEET) out += LEET[char];
    else if (/[a-z0-9]/u.test(char)) out += char;
  }
  return out;
}

/**
 * The comparison forms of one password: as typed, and with leetspeak folded.
 *
 * Two forms — never one — because the substitutions are only safe when applied
 * *in addition*. `password123` reduced with the map becomes `passwordl23`
 * (`1` → `l`), which would slip past the list, while `P@ssw0rd` needs the map
 * to become `password` at all.
 */
function condensedForms(value: string): string[] {
  const plain = condense(value);
  const leet = condense(value, { leet: true });
  return plain === leet ? [plain] : [plain, leet];
}

/**
 * Whether the condensed password *is* a blocklisted one, or that password plus
 * at most a two-character decoration (`password!!`, `welcome12`). Longer
 * suffixes are left alone: `passwordmanager` is a real, different password.
 */
function isBlocklisted(condensed: string): boolean {
  if (COMMON_PASSWORDS.has(condensed)) return true;
  for (const candidate of COMMON_PASSWORDS) {
    if (condensed.startsWith(candidate) && condensed.length - candidate.length <= 2) {
      return true;
    }
  }
  return false;
}

function isRepeatedBlock(value: string): boolean {
  // `aaaaaaaaaa`, `ababababab`, `abcabcabcabc`: one short unit repeated.
  const match = /^([\s\S]{1,4})\1+$/u.exec(value);
  return match !== null;
}

function isStraightRun(condensed: string): boolean {
  if (condensed.length < 6) return false;
  return SEQUENCES.some(
    (sequence) =>
      sequence.startsWith(condensed) ||
      sequence.endsWith(condensed) ||
      sequence.includes(condensed),
  );
}

/** Email local part, when long enough to be a meaningful substring test. */
function identityTokens(email: string | null | undefined): string[] {
  if (!email) return [];
  const normalized = normalize(email).trim();
  const tokens = new Set<string>([normalized]);
  const local = normalized.split('@')[0] ?? '';
  if (local.length >= 3) tokens.add(local);
  return [...tokens].filter((token) => token.length > 0);
}

/**
 * Validate a candidate password.
 *
 * @param password the plaintext the user typed (never trimmed: leading and
 *   trailing spaces are legitimate characters and must not be silently dropped)
 * @param options.email the account's email, for the identity screen
 */
export function validatePassword(
  password: string,
  options: { email?: string | null } = {},
): PasswordCheck {
  const length = [...password].length;
  // Whitespace-only input is a length problem, not a strength one.
  if (length < PASSWORD_MIN_LENGTH || password.trim().length === 0) {
    return { ok: false, code: 'password.too_short' };
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return { ok: false, code: 'password.too_long' };
  }

  const normalized = normalize(password);
  const forms = condensedForms(password);

  for (const token of identityTokens(options.email)) {
    if (normalized === token) return { ok: false, code: 'password.matches_identity' };
    // A 4+ character local part inside the password is the `alice2024`
    // pattern; shorter parts match too much to be a signal.
    if (token.length >= 4 && !token.includes('@') && normalized.includes(token)) {
      return { ok: false, code: 'password.matches_identity' };
    }
  }

  if (forms.some(isBlocklisted)) return { ok: false, code: 'password.too_common' };
  if (isRepeatedBlock(normalized)) return { ok: false, code: 'password.too_common' };
  if (forms.some(isStraightRun)) return { ok: false, code: 'password.too_common' };

  return { ok: true };
}

/** One-line operator/UI hint, kept in the SDK so it cannot drift from the rules. */
export function describePasswordPolicy(): {
  minLength: number;
  maxLength: number;
  codes: PasswordIssueCode[];
} {
  return {
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    codes: [
      'password.too_short',
      'password.too_long',
      'password.too_common',
      'password.matches_identity',
    ],
  };
}
