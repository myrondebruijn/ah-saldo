// Pure logic for Kassa: no DOM and no storage, so logic.test.mjs can run it in Node.

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
// `total` is the whole amount due; whatever the cards could not cover was paid another way (pin).
// Returns the cents taken per card, or 'low' when the earlier cards alone would have covered that total.
export function settle(balances, total) {
  const earlier = balances.slice(0, -1).reduce((sum, cents) => sum + cents, 0);
  if (total <= earlier) return 'low'; // also refuses a total of zero
  return balances.length ? [...balances.slice(0, -1), Math.min(balances.at(-1), total - earlier)] : [];
}

// Who a purchase of `total` cents was for: `parts` are [name, cents] pairs for the others, and `main` gets what is left.
// Returns [{ who, cents }] adding up to the total, largest first, or 'over' when the parts exceed it.
export function shareOut(total, main, parts) {
  const cents = new Map([[main, 0]]);
  for (const [who, amount] of parts) cents.set(who, (cents.get(who) ?? 0) + amount);
  const rest = total - parts.reduce((sum, [, amount]) => sum + amount, 0);
  if (rest < 0) return 'over';
  cents.set(main, cents.get(main) + rest);
  return [...cents].filter(([, amount]) => amount > 0).map(([who, amount]) => ({ who, cents: amount }))
    .sort((p, q) => q.cents - p.cents);
}

// ---------- periods and statistics ----------

// First day (local midnight) of the week (Monday), month or year that `date` falls in.
export function periodStart(unit, date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (unit === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  if (unit === 'month') start.setDate(1);
  if (unit === 'year') start.setMonth(0, 1);
  return start;
}

// The start of the period `by` periods after (or, negative, before) the one starting at `start`.
export function shiftPeriod(unit, start, by) {
  const shifted = new Date(start);
  if (unit === 'week') shifted.setDate(shifted.getDate() + 7 * by);
  if (unit === 'month') shifted.setMonth(shifted.getMonth() + by);
  if (unit === 'year') shifted.setFullYear(shifted.getFullYear() + by);
  return shifted;
}

// ISO week number: weeks start on Monday and week 1 holds the year's first Thursday
export function isoWeek(date) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7)); // the Thursday of this week
  return Math.ceil(((day - Date.UTC(day.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
}

// The purchases dated from `start` up to (not including) `end`, newest first, with their totals:
// overall, the part paid with gift cards, and [name, cents] lists per person and per shop, largest first.
export function summarize(purchases, start, end) {
  const inside = purchases.filter((purchase) => new Date(purchase.at) >= start && new Date(purchase.at) < end)
    .sort((p, q) => q.at.localeCompare(p.at));
  const tally = (pairs) => {
    const sums = new Map();
    for (const [key, cents] of pairs) sums.set(key, (sums.get(key) ?? 0) + cents);
    return [...sums].sort((p, q) => q[1] - p[1]);
  };
  return {
    purchases: inside,
    total: inside.reduce((sum, purchase) => sum + purchase.total, 0),
    cards: inside.reduce((sum, purchase) => sum + purchase.cards, 0),
    byWho: tally(inside.flatMap((purchase) => purchase.shares.map((share) => [share.who, share.cents]))),
    byStore: tally(inside.map((purchase) => [purchase.store, purchase.total])),
  };
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
const isTime = (text) => typeof text === 'string' && !Number.isNaN(Date.parse(text));
const isEntry = (entry) => isId(entry?.id) && isTime(entry.at) && KINDS.includes(entry.kind) && Number.isInteger(entry.delta)
  && (entry.purchase === undefined || isId(entry.purchase));
// a shop or person name: free text, so it is escaped wherever it is shown
export const isName = (text) => typeof text === 'string' && /^[^\u0000-\u001f]{1,30}$/.test(text) && text === text.trim();
const isPurchase = (purchase) => isId(purchase?.id) && isTime(purchase.at) && isName(purchase.store)
  && Number.isInteger(purchase.total) && purchase.total > 0
  && Number.isInteger(purchase.cards) && purchase.cards >= 0 && purchase.cards <= purchase.total
  && Array.isArray(purchase.shares) && purchase.shares.length > 0
  && purchase.shares.every((share) => isName(share?.who) && Number.isInteger(share.cents) && share.cents > 0)
  && purchase.shares.reduce((sum, share) => sum + share.cents, 0) === purchase.total;

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
      entries: card.entries.map(({ id, at, kind, delta, purchase }) => ({ id, at, kind, delta, ...(purchase && { purchase }) })),
    };
  });
  const listed = data.purchases ?? []; // data from before purchases existed has none
  if (!Array.isArray(listed) || !listed.every(isPurchase)) throw new Error('invalid purchase');
  const purchases = listed.map(({ id, at, store, total, cards: fromCards, shares }) => ({
    id, at, store, total, cards: fromCards, shares: shares.map(({ who, cents }) => ({ who, cents })),
  }));
  return { cards, purchases, needsBackup: data.needsBackup === true };
}
