// Pure logic for AH Saldo: no DOM and no storage, so logic.test.mjs can run it in Node.

const DAY = 86_400_000;
const KINDS = ['start', 'pay', 'correct'];

export const cleanDigits = (text) => String(text).replace(/\D/g, '');
export const validNumber = (number) => typeof number === 'string' && /^\d{19}$/.test(number);
export const validCode = (code) => typeof code === 'string' && /^\d{6}$/.test(code);
export const groupNumber = (number) => number.replace(/(\d{4})(?=\d)/g, '$1 ');

// "12", "12,5", "12.50" or "€ 12,50" -> cents; anything else -> null
export function parseEuro(text) {
  const match = /^(\d{1,4})(?:[.,](\d{1,2}))?$/.exec(String(text).replace(/[€\s]/g, ''));
  return match && Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

const euro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
export const formatEuro = (cents) => euro.format(cents / 100);

// a card's balance is the sum of its entries; the first entry is the starting balance
export const balance = (card) => card.entries.reduce((sum, entry) => sum + entry.delta, 0);

// local date as YYYY-MM-DD
export const isoDate = (date = new Date()) =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-');

export const isDate = (text) => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text));

export const daysLeft = (expiry, today) => Math.round((Date.parse(expiry) - Date.parse(today)) / DAY);

// a card is still valid on its expiry date itself
export function expiryState(expiry, today) {
  if (!expiry) return 'none';
  const days = daysLeft(expiry, today);
  return days < 0 ? 'expired' : days <= 30 ? 'soon' : 'ok';
}

// soonest expiry first, cards without a date last, then lowest balance first
export const sortCards = (cards) => [...cards].sort((a, b) =>
  (a.expiry || '9999').localeCompare(b.expiry || '9999') || balance(a) - balance(b));

// What one payment took from each card, given the balances (in cents) of the cards used, in the order the till got them.
// The till empties every card before it asks for the next, so only the last one can have money left.
// `total` is the amount due when the cards covered all of it; null means a rest was paid another way, so all are empty.
// Returns the cents taken per card, or 'low' / 'high' when that total cannot be right for these cards.
export function settle(balances, total) {
  if (total === null) return balances;
  const earlier = balances.slice(0, -1).reduce((sum, cents) => sum + cents, 0);
  if (total <= earlier) return 'low'; // the last card would not have been needed
  if (total > earlier + balances.at(-1)) return 'high'; // the cards could not have covered it
  return [...balances.slice(0, -1), total - earlier];
}

// Code 128: the widths of the three bars and three spaces of each symbol value 0-105, then the stop symbol (106)
export const CODE128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

// The barcode of a string of digits as bar and space widths, alternating and starting with a bar.
// Digit pairs go in code set C; an odd last digit follows in set B, as on the cards wissel.nl delivers.
export function code128(digits) {
  const values = [105]; // start in set C
  for (let i = 0; i + 1 < digits.length; i += 2) values.push(Number(digits.slice(i, i + 2)));
  if (digits.length % 2) values.push(100, Number(digits.at(-1)) + 16); // switch to set B, where '0' is value 16
  const check = values.reduce((sum, value, index) => sum + value * (index || 1), 0) % 103;
  return [...values, check, 106].map((value) => CODE128[value]).join('');
}

// iPhone Safari may clear a site's data after a week unused; a Home Screen app keeps its own
export const needsInstall = (userAgent, standalone) => /iPhone|iPad|iPod/.test(userAgent) && !standalone;

const isId = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
const isEntry = (entry) => isId(entry?.id) && typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at))
  && KINDS.includes(entry.kind) && Number.isInteger(entry.delta);

// Reads saved data or a backup file. Throws on anything that is not exactly our shape,
// because the result is rendered as HTML and holds the card codes.
export function parseState(json) {
  const data = JSON.parse(json);
  if (!Array.isArray(data?.cards)) throw new Error('no cards');
  const cards = data.cards.map((card) => {
    const ok = isId(card?.id) && validNumber(card.number) && validCode(card.code)
      && (card.expiry === '' || isDate(card.expiry))
      && Array.isArray(card.entries) && card.entries.every(isEntry);
    if (!ok) throw new Error('invalid card');
    return {
      id: card.id, number: card.number, code: card.code, expiry: card.expiry,
      entries: card.entries.map(({ id, at, kind, delta }) => ({ id, at, kind, delta })),
    };
  });
  return { cards, needsBackup: data.needsBackup === true };
}
