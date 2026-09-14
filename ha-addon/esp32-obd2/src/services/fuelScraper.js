const https = require('https');
const db = require('../db');

// 1. Direct WOG API fetcher
function fetchWogDirect() {
  return new Promise((resolve) => {
    https.get('https://api.wog.ua/fuel_stations', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const filters = json.data?.fuel_filters || [];
          const f95 = filters.find(f => (f.name === '95' || f.name === 'А-95') && !String(f.brand).includes('Mustang'))
                   || filters.find(f => f.name === '95');
          if (f95 && f95.price) {
            const price = f95.price / 100.0;
            console.log(`[WOG Direct API] Found A-95 price: ${price} грн`);
            return resolve(price);
          }
        } catch (e) {}
        resolve(null);
      });
    }).on('error', () => resolve(null));
  });
}

// 2. Direct UPG web page parser
function fetchUpgDirect() {
  return new Promise((resolve) => {
    https.get('https://upg.ua/cini-na-palne/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html'
      },
      timeout: 8000
    }, (res) => {
      let html = '';
      res.on('data', c => { html += c; });
      res.on('end', () => {
        try {
          const match = /var\s+obj\s*=\s*({[\s\S]*?});/.exec(html);
          if (match) {
            const json = JSON.parse(match[1]);
            const items = json.data || [];
            const a95List = items.filter(it => it.Title === 'A-95' || it.FuelTypeId === 2);
            if (a95List.length > 0) {
              const sum = a95List.reduce((acc, curr) => acc + parseFloat(curr.AveragePrice || 0), 0);
              const avg = Math.round((sum / a95List.length) * 100) / 100;
              console.log(`[UPG Direct] Found A-95 price: ${avg} грн`);
              return resolve(avg);
            }
          }
        } catch (e) {}
        resolve(null);
      });
    }).on('error', () => resolve(null));
  });
}

// 3. Minfin aggregator (for OKKO, KLO, UKRNAFTA and fallback)
function fetchMinfinPrices() {
  return new Promise((resolve) => {
    const url = 'https://index.minfin.com.ua/ua/markets/fuel/tm/';
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html'
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const targetStations = {
            'окко': 'OKKO',
            'okko': 'OKKO',
            'wog': 'WOG',
            'upg': 'UPG',
            'klo': 'KLO',
            'ukrnafta': 'UKRNAFTA',
            'укрнафта': 'UKRNAFTA'
          };
          const parsed = {};
          const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
          let match;
          while ((match = rowRegex.exec(data)) !== null) {
            const rowHtml = match[1];
            const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
            const cells = [];
            let tdMatch;
            while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
              cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
            }
            if (cells.length >= 4) {
              const stationNameRaw = cells[0].toLowerCase();
              for (const [key, normalized] of Object.entries(targetStations)) {
                if (stationNameRaw === key || stationNameRaw.includes(key)) {
                  const priceStr = cells[3].replace(',', '.').trim();
                  const price = parseFloat(priceStr);
                  if (!isNaN(price) && price > 30 && price < 150) {
                    parsed[normalized] = price;
                  }
                }
              }
            }
          }
          resolve(parsed);
        } catch (e) {
          resolve({});
        }
      });
    }).on('error', () => resolve({}));
  });
}

// Master updater combining all sources
async function fetchGasStationPrices() {
  try {
    console.log("🔄 Fetching fuel prices from all sources...");
    const [wogPrice, upgPrice, minfinData] = await Promise.all([
      fetchWogDirect(),
      fetchUpgDirect(),
      fetchMinfinPrices()
    ]);

    const finalPrices = { ...minfinData };
    if (wogPrice) finalPrices['WOG'] = wogPrice;
    if (upgPrice) finalPrices['UPG'] = upgPrice;

    const entries = Object.entries(finalPrices);
    if (entries.length > 0) {
      entries.forEach(([st, pr]) => {
        db.run(`INSERT INTO fuel_prices (station, price, fuel_type, updated_at) 
                VALUES (?, ?, 'A-95', CURRENT_TIMESTAMP)
                ON CONFLICT(station) DO UPDATE SET price = excluded.price, updated_at = CURRENT_TIMESTAMP`, 
                [st, pr]);
      });
      console.log(`✅ Updated fuel prices for ${entries.length} stations:`, finalPrices);
    }
    return finalPrices;
  } catch (err) {
    console.error("Failed to update fuel prices:", err.message);
    return null;
  }
}

// Start background updates (immediately + every 4 hours)
function startBackgroundFuelScraper() {
  fetchGasStationPrices();
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  setInterval(fetchGasStationPrices, FOUR_HOURS_MS);
}

module.exports = {
  fetchGasStationPrices,
  startBackgroundFuelScraper
};
