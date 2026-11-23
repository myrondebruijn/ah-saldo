// Share prices for Kassa's "Beleggen": what Yahoo Finance shows the public, asked without a key or an account.
// It is no official feed: it may change or stop, and the app then keeps the last prices it had.
// shortcut: Yahoo's public pages are the only source, switch to a feed with a key if they start refusing the server.

const SYMBOL = /^[\w.=^-]{1,20}$/;
export const isSymbols = (list) => list.length > 0 && list.length <= 30 && list.every((symbol) => SYMBOL.test(symbol));

async function yahoo(path) {
  // a request that names no browser is answered with 429
  const response = await fetch(`https://query1.finance.yahoo.com${path}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw Object.assign(new Error(`prices ${response.status}`), { status: 502 });
  return response.json();
}

// The shares and funds that match a name, a ticker or an ISIN: [{ id, name, where: its exchange }]
export async function find(text) {
  const { quotes = [] } = await yahoo(`/v1/finance/search?q=${encodeURIComponent(text)}&quotesCount=8&newsCount=0`);
  return quotes.filter((each) => ['EQUITY', 'ETF', 'MUTUALFUND'].includes(each.quoteType) && SYMBOL.test(each.symbol))
    .map((each) => ({ id: each.symbol, name: String(each.longname || each.shortname || each.symbol).slice(0, 60), where: String(each.exchDisp ?? '').slice(0, 30) }));
}

// The last price of each symbol in euros: { symbol: 12.34 }, null for one that has no price.
export async function prices(symbols) {
  const last = async (symbol) => (await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`)).chart.result[0].meta;
  const rates = new Map([['EUR', 1]]); // what one of a currency is in euros, each asked once
  const rate = (currency) => rates.get(currency)
    ?? rates.set(currency, last(`${currency}EUR=X`).then((meta) => meta.regularMarketPrice)).get(currency);
  return Object.fromEntries(await Promise.all(symbols.map(async (symbol) => {
    try {
      const { regularMarketPrice: price, currency } = await last(symbol);
      const pence = currency === 'GBp'; // London prices most shares in pence
      const euros = price * (pence ? 0.01 : 1) * await rate(pence ? 'GBP' : currency);
      return [symbol, Number.isFinite(euros) && euros > 0 ? euros : null];
    } catch {
      return [symbol, null];
    }
  })));
}
