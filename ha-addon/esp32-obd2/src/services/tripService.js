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

// Ensures an active trip exists. Auto-expires idle trips older than 30 mins.
async function ensureActiveTrip() {
  const now = Date.now();
  const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  // Auto-complete idle trips
  if (currentTripId && lastRecordTime && (now - lastRecordTime > TIMEOUT_MS)) {
    console.log(`[TripService] Auto-completing idle Trip #${currentTripId}`);
    await db.runAsync(`UPDATE trips SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE id = ?`, [currentTripId]);
    currentTripId = null;
  }

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
  const cleanSpeed = (rawSpeed >= 0 && rawSpeed <= 185) ? rawSpeed : (rawSpeed > 185 ? 0 : 0);
  const validDt = (timeDiffSeconds > 0 && timeDiffSeconds <= 60) ? Number(timeDiffSeconds) : 0;
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
  if (!currentTripId) return null;
  
  const finishedId = currentTripId;
  await db.runAsync(`UPDATE trips SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE id = ?`, [finishedId]);
  currentTripId = null;
  lastRecordTime = null;
  console.log(`[TripService] Manually finished Trip #${finishedId}`);
  return finishedId;
}

function reset() {
  currentTripId = null;
  lastRecordTime = null;
}

module.exports = {
  getCurrentTripId,
  getLastRecordTime,
  setLastRecordTime,
  ensureActiveTrip,
  updateTripStats,
  finishCurrentTrip,
  reset
};
