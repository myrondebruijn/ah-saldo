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
