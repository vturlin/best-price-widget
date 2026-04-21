/**
 * Rate loading and aggregation.
 *
 * The widget calls loadRatesFromApi(config, stay) which:
 *   1. Fetches one or two months of rates from our proxy (the admin's
 *      /api/rates endpoint). Two months are needed for stays that cross
 *      the month boundary.
 *   2. For each day of the stay, finds the cheapest price per channel
 *      (across all rooms and rate conditions).
 *   3. Sums the daily prices into a total per channel.
 *   4. Identifies the best OTA and computes savings vs direct.
 *
 * The returned shape:
 *   {
 *     status: 'ok' | 'fallback',
 *     currency: 'EUR',
 *     nights: 2,
 *     channels: {
 *       17: { id: 17, total: 744, avgPerNight: 372 },
 *       10: { id: 10, total: 890, avgPerNight: 445 },
 *       ...
 *     },
 *     bestOtaChannelId: 10,           // which OTA channel was cheapest
 *     savingsAmount: 146,
 *     savingsPercent: 16,
 *   }
 *
 * In 'fallback' mode, channels is empty and the widget shows a generic
 * "Best price guaranteed" message.
 */

// ─── Proxy endpoint ──────────────────────────────────────────────────
// The widget calls this URL to fetch rates. It's the admin's Cloud Run
// service, configured at build time. For the POC, hardcoded.
const RATES_PROXY_URL = 'https://hotel-widget-admin-152048178748.europe-west1.run.app';

// Channel ID 17 is the direct rate (Brand), the hotel's own website.
// OTAs are everything else (9 = Expedia, 10 = Booking, etc.).
const DIRECT_CHANNEL_ID = 17;

/**
 * Fetch rates for one (hotelApiId, year, month) from the proxy.
 * Returns the raw JSON. Throws on any error (caller handles fallback).
 */
async function fetchMonth(apiHotelId, year, month) {
  const url = `${RATES_PROXY_URL}/api/rates/${apiHotelId}?year=${year}&month=${month}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Rates API returned ${res.status}`);
  }
  return res.json();
}

/**
 * Given a stay { checkIn: Date, checkOut: Date }, return the list of
 * (year, month) pairs we need to fetch to cover all nights.
 * Typically 1 pair, sometimes 2 for stays spanning a month boundary.
 */
function monthsToFetch(stay) {
  const months = new Set();
  const d = new Date(stay.checkIn);
  // Iterate night-by-night until (but not including) checkOut
  while (d < stay.checkOut) {
    months.add(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return Array.from(months).map((key) => {
    const [year, month] = key.split('-').map(Number);
    return { year, month };
  });
}

/**
 * Generate the list of date strings (YYYY-MM-DD) for all nights in the stay.
 * Checkout day is NOT a night (standard hotel booking convention).
 */
function nightsInStay(stay) {
  const nights = [];
  const d = new Date(stay.checkIn);
  while (d < stay.checkOut) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    nights.push(`${y}-${m}-${day}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return nights;
}

/**
 * Extract the hotel's competitor ID from the API response.
 * Prefer the one configured in the widget config; fall back to
 * auto-detection via the "myHotel: true" flag.
 */
function resolveCompetitorId(apiData, configuredId) {
  if (configuredId && apiData.competitors?.[configuredId]) {
    return configuredId;
  }
  // Auto-detect via myHotel flag
  for (const [id, comp] of Object.entries(apiData.competitors || {})) {
    if (comp.myHotel === true) return parseInt(id, 10);
  }
  return null;
}

/**
 * For a given (day, competitor, channel), find the cheapest price
 * across all rooms and rate conditions. Returns null if nothing available.
 */
function cheapestPriceForDay(dayData, competitorId, channelId) {
  const compData = dayData?.competitors?.[competitorId];
  if (!compData || compData.status !== 'Available') return null;

  const channelData = compData.channels?.[channelId];
  if (!channelData || channelData.status !== 'Available') return null;
  if (!Array.isArray(channelData.prices) || channelData.prices.length === 0) return null;

  let min = Infinity;
  for (const p of channelData.prices) {
    if (typeof p.price === 'number' && p.price > 0 && p.price < min) {
      min = p.price;
    }
  }
  return min === Infinity ? null : min;
}

/**
 * Aggregate rates across the stay: sum up the cheapest daily price per
 * channel. Returns a map { channelId: { total, avgPerNight } }.
 * A channel is only included if ALL nights have a price available;
 * otherwise the widget would show a partial/misleading total.
 */
function aggregateStay(apiDataByMonth, stay, competitorId, channelsEnabled) {
  const nights = nightsInStay(stay);
  const channelTotals = {};

  for (const channelId of channelsEnabled) {
    let sum = 0;
    let complete = true;

    for (const night of nights) {
      // Find which month bucket this night belongs to
      const [y, m] = night.split('-').map(Number);
      const bucket = apiDataByMonth[`${y}-${m}`];
      if (!bucket) { complete = false; break; }

      const dayData = bucket.competitorPrices?.[night];
      const price = cheapestPriceForDay(dayData, competitorId, channelId);
      if (price == null) { complete = false; break; }
      sum += price;
    }

    if (complete && sum > 0) {
      channelTotals[channelId] = {
        id: channelId,
        total: Math.round(sum * 100) / 100,
        avgPerNight: Math.round((sum / nights.length) * 100) / 100,
      };
    }
  }

  return { channels: channelTotals, nights: nights.length };
}

/**
 * Identify the cheapest OTA (non-direct) channel and compute savings vs direct.
 * Returns { bestOtaChannelId, savingsAmount, savingsPercent } or nulls
 * if direct or OTAs are missing.
 */
function computeSavings(channels) {
  const direct = channels[DIRECT_CHANNEL_ID];
  if (!direct) return { bestOtaChannelId: null, savingsAmount: null, savingsPercent: null };

  let bestOtaId = null;
  let bestOtaTotal = Infinity;
  for (const [chId, data] of Object.entries(channels)) {
    const id = parseInt(chId, 10);
    if (id === DIRECT_CHANNEL_ID) continue;
    if (data.total < bestOtaTotal) {
      bestOtaTotal = data.total;
      bestOtaId = id;
    }
  }

  if (!bestOtaId) return { bestOtaChannelId: null, savingsAmount: null, savingsPercent: null };

  const savings = bestOtaTotal - direct.total;
  return {
    bestOtaChannelId: bestOtaId,
    savingsAmount: Math.round(savings * 100) / 100,
    savingsPercent: Math.round((savings / bestOtaTotal) * 100),
  };
}

/**
 * Main entry point: fetch rates from the API and aggregate them for a stay.
 * Returns the aggregated summary the widget uses for rendering.
 */
export async function loadRatesFromApi(config, stay) {
  // Guard against missing config
  if (!config.apiHotelId) {
    console.warn('[hpw] no apiHotelId in config, falling back');
    return {
      status: 'fallback',
      currency: config.currency || 'EUR',
      nights: 0,
      channels: {},
      bestOtaChannelId: null,
      savingsAmount: null,
      savingsPercent: null,
    };
  }

  try {
    const months = monthsToFetch(stay);
    // Fetch all needed months in parallel
    const results = await Promise.all(
      months.map((m) =>
        fetchMonth(config.apiHotelId, m.year, m.month).then((data) => ({
          key: `${m.year}-${m.month}`,
          data,
        }))
      )
    );

    // Index responses by month
    const apiDataByMonth = {};
    for (const r of results) apiDataByMonth[r.key] = r.data;

    // Resolve competitor ID (prefer config, else myHotel auto-detection)
    const firstBucket = results[0]?.data;
    const competitorId = resolveCompetitorId(firstBucket, config.apiCompetitorId);
    if (!competitorId) {
      throw new Error('Could not resolve competitor ID (no myHotel flag and none configured)');
    }

    // Determine currency from API response (use first bucket)
    const sampleDay = firstBucket?.competitorPrices
      ? Object.values(firstBucket.competitorPrices)[0]
      : null;
    const apiCurrency = sampleDay?.competitors?.[competitorId]?.currency || config.currency || 'EUR';

    // Aggregate
    const { channels, nights } = aggregateStay(
      apiDataByMonth,
      stay,
      competitorId,
      config.channelsEnabled
    );

    if (Object.keys(channels).length === 0) {
      console.warn('[hpw] no channel has complete pricing for the stay');
      return {
        status: 'fallback',
        currency: apiCurrency,
        nights,
        channels: {},
        bestOtaChannelId: null,
        savingsAmount: null,
        savingsPercent: null,
      };
    }

    const { bestOtaChannelId, savingsAmount, savingsPercent } = computeSavings(channels);
    const channelNames = {};
    if (firstBucket?.channels) {
      for (const [id, meta] of Object.entries(firstBucket.channels)) {
        channelNames[parseInt(id, 10)] = meta.channelName || `Channel ${id}`;
      }
    }
    return {
      status: 'ok',
      currency: apiCurrency,
      nights,
      channels,
      channelNames, 
      bestOtaChannelId,
      savingsAmount,
      savingsPercent,
    };
  } catch (err) {
    console.warn('[hpw] loadRatesFromApi failed, using fallback', err);
    return {
      status: 'fallback',
      currency: config.currency || 'EUR',
      nights: 0,
      channels: {},
      bestOtaChannelId: null,
      savingsAmount: null,
      savingsPercent: null,
    };
  }
}

/**
 * Build deterministic demo data for the admin preview.
 * No API call, just fake prices that look realistic so the hotelier
 * can see the widget shape while editing.
 */
export function buildPreviewData(config) {
  const nights = 2;
  const directPerNight = 372;
  const bookingPerNight = 445;
  const expediaPerNight = 452;

  const channels = {};
  if ((config.channelsEnabled || []).includes(17)) {
    channels[17] = { id: 17, total: directPerNight * nights, avgPerNight: directPerNight };
  }
  if ((config.channelsEnabled || []).includes(10)) {
    channels[10] = { id: 10, total: bookingPerNight * nights, avgPerNight: bookingPerNight };
  }
  if ((config.channelsEnabled || []).includes(9)) {
    channels[9] = { id: 9, total: expediaPerNight * nights, avgPerNight: expediaPerNight };
  }

  // Best OTA = cheapest non-direct
  let bestOtaId = null;
  let bestOtaTotal = Infinity;
  for (const [id, data] of Object.entries(channels)) {
    const chId = parseInt(id, 10);
    if (chId === 17) continue;
    if (data.total < bestOtaTotal) {
      bestOtaTotal = data.total;
      bestOtaId = chId;
    }
  }

  const direct = channels[17];
  const savingsAmount = direct && bestOtaId ? bestOtaTotal - direct.total : null;
  const savingsPercent = savingsAmount && bestOtaTotal
    ? Math.round((savingsAmount / bestOtaTotal) * 100)
    : null;

  return {
    status: 'ok',
    currency: config.currency || 'EUR',
    nights,
    channels,
    channelNames: {
      17: 'Direct',
      10: 'Booking.com',
      9: 'Expedia',
    },
    bestOtaChannelId: bestOtaId,
    savingsAmount,
    savingsPercent,
  };
}