// Port of the server's highEntropyKey rule. Pure: no node:* imports. The contract
// suite fuzzes this and the server's implementation with the same inputs (tests/contract).

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Version-4 UUIDs printed in widely copied documentation (Wikipedia, Swagger, PostgreSQL…). */
const EXAMPLE_UUIDS = new Set([
  '550e8400-e29b-41d4-a716-446655440000',
  'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  'd290f1ee-6c54-4b01-90e6-d701748f0851',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
  '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  '16fd2706-8baf-433b-82eb-8c7fada847da',
]);
/**
 * Words that mark a key as chosen rather than generated. Only words of seven or more letters
 * (plus two six-letter keyboard/password words) are listed, so a random key contains one by
 * chance with probability about 3e-8 at 22 characters.
 */
const KEY_WORDS = [
  'qwerty',
  'passwd',
  'password',
  'letmein',
  'example',
  'default',
  'testing',
  'idempotent',
  'request',
  'research',
  'extract',
  'verifier',
  'template',
  'manifest',
  'central',
  'anonymous',
  'unclaimed',
  'attempt',
  'session',
  'counter',
  'sequence',
  'january',
  'february',
  'september',
  'october',
  'november',
  'december',
  'tuesday',
  'wednesday',
  'thursday',
  'saturday',
  'chatgpt',
  'claudecode',
  'anthropic',
  'assistant',
  'workflow',
  'checker',
  'analyst',
];
const KEY_DATE = /(?:19|20)\d\d[-_]?(?:0[1-9]|1[0-2])[-_]?(?:0[1-9]|[12]\d|3[01])/;
/** 12+ digits (millisecond timestamps, counters) or a 10-digit Unix time in seconds (2014-2039). */
const KEY_NUMBER = /[0-9]{12}|(?<![0-9])(?:1[4-9]|2[01])[0-9]{8}(?![0-9])/;

/** Longest run whose character codes change by the same step of -1, 0 or +1 (aaaa, 1234, dcba). */
function longestRun(text: string): number {
  let longest = Math.min(text.length, 1);
  let run = 1;
  let step = Number.NaN;
  for (let index = 1; index < text.length; index++) {
    const next = text.charCodeAt(index) - text.charCodeAt(index - 1);
    run = Math.abs(next) <= 1 ? (next === step ? run + 1 : 2) : 1;
    step = next;
    longest = Math.max(longest, run);
  }
  return longest;
}
/** True when some substring of `length` characters occurs twice (overlapping allowed). */
function repeats(text: string, length: number): boolean {
  for (let index = 0; index + length < text.length; index++)
    if (text.indexOf(text.slice(index, index + length), index + 1) !== -1) return true;
  return false;
}
const seen = new Uint32Array(128);
let seenMark = 0;
/** Number of distinct characters in an ASCII string (allocation-free; keys are ASCII). */
function distinctCount(text: string): number {
  seenMark = (seenMark + 1) >>> 0;
  if (seenMark === 0) {
    seen.fill(0);
    seenMark = 1;
  }
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index) & 127;
    if (seen[code] !== seenMark) {
      seen[code] = seenMark;
      count++;
    }
  }
  return count;
}
/** Hex digits (lower case) that look random: at least 128 bits, no runs, repeats or low variety. */
function randomHex(hex: string): boolean {
  return hex.length >= 32 && distinctCount(hex) >= 6 && longestRun(hex) < 9 && !repeats(hex, 10);
}
/** A lower-case UUID that is version 4, not a published example, with random-looking digits. */
function randomUuid(uuid: string): boolean {
  return (
    UUID_V4.test(uuid) &&
    !EXAMPLE_UUIDS.has(uuid) &&
    randomHex(
      uuid.slice(0, 8) +
        uuid.slice(9, 13) +
        uuid.slice(14, 18) +
        uuid.slice(19, 23) +
        uuid.slice(24),
    )
  );
}

/**
 * Anonymous idempotency keys must be unguessable: everyone behind one address shares a partition,
 * and a neighbour who predicts a key (and the arguments) could send the request first and receive
 * its claim token. Accepted: a random UUID v4 (alone or with an affix such as `req_`), at least 32
 * random hex digits, or random base64url of at least 22 characters (16 random bytes). Refused:
 * other UUID versions and published example UUIDs; hex below 32 digits in any letter case;
 * decimal keys below 39 digits; letters of one case without digits (words); dictionary words;
 * dates; Unix timestamps and numbers of 12+ digits; runs of 7+ repeated or sequential characters
 * (8+ letters when digits and separators are skipped); a repeated 8-character substring; fewer
 * than 10 distinct characters. Each rule is sized so that a genuine random UUID v4 or 22-character
 * base64url key is refused far less often than 1 in 1,000,000 (about 1e-7 in total; tests fuzz
 * both). A literal "three character classes" rule is not used: about 1% of random 22-character
 * base64url keys contain neither a digit nor "-"/"_".
 */
export function highEntropyKey(key: unknown): boolean {
  if (typeof key !== 'string' || key.length > 128 || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  const lower = key.toLowerCase();
  if (UUID_SHAPE.test(key)) return randomUuid(lower);
  // Random UUIDs and long random hex runs carry the key whatever surrounds them.
  for (const uuid of lower.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ??
    [])
    if (randomUuid(uuid)) return true;
  // Hex and decimal keys are judged by their digits alone, in any letter case.
  const plain = lower.replace(/[-_]/g, '');
  if (/^[0-9]+$/.test(plain))
    return (
      plain.length >= 39 &&
      distinctCount(plain) >= 6 &&
      longestRun(plain) < 12 &&
      !repeats(plain, 12)
    );
  if (/^[0-9a-f]+$/.test(plain)) return randomHex(plain);
  for (const hex of lower.match(/[0-9a-f]{32,}/g) ?? []) if (randomHex(hex)) return true;
  if (key.length < 22) return false;
  const lowerCase = /[a-z]/.test(key);
  const upperCase = /[A-Z]/.test(key);
  const digits = /[0-9]/.test(key);
  // Letters of a single case with no digits (separators aside) read as words, not random text.
  if (!digits && lowerCase !== upperCase) return false;
  const alphabet =
    (lowerCase ? 26 : 0) + (upperCase ? 26 : 0) + (digits ? 10 : 0) + (/[-_]/.test(key) ? 2 : 0);
  if (key.length * Math.log2(alphabet) < 112) return false;
  return !(
    distinctCount(key) < 10 ||
    longestRun(key) >= 7 ||
    longestRun(lower.replace(/[^a-z]/g, '')) >= 8 ||
    KEY_NUMBER.test(key) ||
    KEY_DATE.test(key) ||
    repeats(key, 8) ||
    KEY_WORDS.some((word) => plain.includes(word))
  );
}


/** A fresh idempotency key: a random UUID v4, which always satisfies highEntropyKey. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}
