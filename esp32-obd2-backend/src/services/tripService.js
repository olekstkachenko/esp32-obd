const db = require('../db');

let currentTripId = null;
let lastRecordTime = null;

function getCurrentTripId() {
  return currentTripId;
}

function getLastRecordTime() {
  return lastRecordTime;
}

function setLastRecordTime(time) {
  lastRecordTime = time;
}

// Helper function to safely parse DB timestamps regardless of timezone format
function parseTimestamp(ts) {
  if (!ts) return 0;
  const str = String(ts).trim();
  const isoStr = str.includes('T') ? str : (str.replace(' ', 'T') + (str.endsWith('Z') ? '' : 'Z'));
  const ms = new Date(isoStr).getTime();
  return isNaN(ms) ? 0 : ms;
}

// Auto-closes any active trips that haven't received telemetry for > 15 minutes
async function autoCloseStaleTrips() {
  const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  const now = Date.now();

  const staleTrips = await db.allAsync(`
    SELECT t.id, 
           MAX(r.timestamp) as last_rec_time,
           t.start_time
    FROM trips t
    LEFT JOIN obd_records r ON r.trip_id = t.id
    WHERE t.status = 'active'
    GROUP BY t.id
  `);

  for (const t of (staleTrips || [])) {
    const rawTime = t.last_rec_time || t.start_time;
    if (rawTime) {
      const timeMs = parseTimestamp(rawTime);
      if (timeMs > 0 && (now - timeMs > TIMEOUT_MS)) {
        const endTime = t.last_rec_time || t.start_time || new Date().toISOString().replace('T', ' ').substring(0, 19);
        await db.runAsync(`UPDATE trips SET status = 'completed', end_time = ? WHERE id = ?`, [endTime, t.id]);
        if (currentTripId === t.id) {
          currentTripId = null;
          lastRecordTime = null;
        }
        console.log(`[TripService] Auto-completed stale Trip #${t.id} (end_time: ${endTime})`);
      }
    }
  }
}

// Ensures an active trip exists. Auto-expires idle trips older than 15 mins.
async function ensureActiveTrip() {
  const now = Date.now();
  await autoCloseStaleTrips();

  if (currentTripId) {
    return currentTripId;
  }

  // Look for any existing active trip
  const row = await db.getAsync(`SELECT id FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1`);
  if (row) {
    currentTripId = row.id;
    lastRecordTime = now;
    return currentTripId;
  }

  // Create a new active trip
  const result = await db.runAsync(`INSERT INTO trips (status, max_speed, fuel_liters) VALUES ('active', 0, 0)`);
  currentTripId = result.lastID;
  lastRecordTime = now;
  console.log(`[TripService] Created new active Trip #${currentTripId}`);
  return currentTripId;
}

async function updateTripStats(tripId, speedKmh, fuelRateLh, timeDiffSeconds) {
  // Pajero 4 physical speed cap (185 km/h) to filter out ELM327 glitches (e.g. 255 km/h artifacts)
  const rawSpeed = Number(speedKmh) || 0;
  const cleanSpeed = (rawSpeed >= 0 && rawSpeed <= 185) ? rawSpeed : 0;
  const validDt = (timeDiffSeconds > 0 && timeDiffSeconds <= 60.0) ? Number(timeDiffSeconds) : 0.5;
  const distanceKm = (cleanSpeed > 0 && validDt > 0) ? (cleanSpeed * (validDt / 3600.0)) : 0;
  
  let addedFuel = 0;
  if (fuelRateLh && fuelRateLh > 0 && validDt > 0) {
    addedFuel = Number(fuelRateLh) * (validDt / 3600.0);
  } else if (distanceKm > 0) {
    addedFuel = (distanceKm * 7.5) / 100.0;
  }

  await db.runAsync(`
    UPDATE trips SET 
      distance_km = distance_km + ?, 
      fuel_liters = fuel_liters + ?,
      avg_speed = (SELECT COALESCE(AVG(speed), 0) FROM obd_records WHERE trip_id = ? AND speed > 0 AND speed <= 185),
      max_speed = (SELECT COALESCE(MAX(speed), 0) FROM obd_records WHERE trip_id = ? AND speed <= 185)
    WHERE id = ?`, 
    [distanceKm, addedFuel, tripId, tripId, tripId]
  );
}

async function finishCurrentTrip() {
  let tripIdToFinish = currentTripId;
  if (!tripIdToFinish) {
    const row = await db.getAsync(`SELECT id FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1`);
    if (row) tripIdToFinish = row.id;
  }
  
  if (!tripIdToFinish) return null;
  
  const lastRec = await db.getAsync(`SELECT timestamp FROM obd_records WHERE trip_id = ? ORDER BY id DESC LIMIT 1`, [tripIdToFinish]);
  const endTime = (lastRec && lastRec.timestamp) ? lastRec.timestamp : new Date().toISOString().replace('T', ' ').substring(0, 19);

  await db.runAsync(`UPDATE trips SET status = 'completed', end_time = ? WHERE id = ?`, [endTime, tripIdToFinish]);
  currentTripId = null;
  lastRecordTime = null;
  console.log(`[TripService] Manually finished Trip #${tripIdToFinish} with end_time: ${endTime}`);
  return tripIdToFinish;
}

function reset() {
  currentTripId = null;
  lastRecordTime = null;
}

module.exports = {
  getCurrentTripId,
  getLastRecordTime,
  setLastRecordTime,
  autoCloseStaleTrips,
  ensureActiveTrip,
  updateTripStats,
  finishCurrentTrip,
  reset
};
