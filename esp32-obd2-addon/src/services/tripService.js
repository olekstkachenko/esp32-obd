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

// Ensures an active trip exists. Auto-expires inactive trips older than 30 mins.
function ensureActiveTrip() {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const timeoutMs = 30 * 60 * 1000; // 30 minutes

    if (currentTripId && lastRecordTime && (now - lastRecordTime > timeoutMs)) {
      console.log(`[TripService] Auto-completing idle Trip #${currentTripId}`);
      db.run(`UPDATE trips SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE id = ?`, [currentTripId]);
      currentTripId = null;
    }

    if (currentTripId) {
      return resolve(currentTripId);
    }

    db.get(`SELECT id FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1`, (err, row) => {
      if (err) return reject(err);

      if (row) {
        currentTripId = row.id;
        lastRecordTime = now;
        return resolve(currentTripId);
      }

      db.run(`INSERT INTO trips (status, max_speed, fuel_liters) VALUES ('active', 0, 0)`, function(err) {
        if (err) return reject(err);
        currentTripId = this.lastID;
        lastRecordTime = now;
        console.log(`[TripService] Created new active Trip #${currentTripId}`);
        resolve(currentTripId);
      });
    });
  });
}

function updateTripStats(tripId, speedKmh, fuelRateLh, timeDiffSeconds) {
  if (timeDiffSeconds <= 0 || timeDiffSeconds > 60) return;
  const distanceKm = (speedKmh > 0) ? (speedKmh * (timeDiffSeconds / 3600.0)) : 0;
  
  let addedFuel = 0;
  if (fuelRateLh && fuelRateLh > 0) {
    addedFuel = fuelRateLh * (timeDiffSeconds / 3600.0);
  } else if (distanceKm > 0) {
    addedFuel = (distanceKm * 7.5) / 100.0;
  }

  db.run(`UPDATE trips SET 
          distance_km = distance_km + ?, 
          fuel_liters = fuel_liters + ?,
          avg_speed = (SELECT AVG(speed) FROM obd_records WHERE trip_id = ? AND speed > 0),
          max_speed = MAX(COALESCE(max_speed, 0), ?)
          WHERE id = ?`, 
          [distanceKm, addedFuel, tripId, speedKmh, tripId]);
}

function finishCurrentTrip() {
  return new Promise((resolve, reject) => {
    if (currentTripId) {
      const finishedId = currentTripId;
      db.run(`UPDATE trips SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE id = ?`, [finishedId], (err) => {
        if (err) return reject(err);
        currentTripId = null;
        lastRecordTime = null;
        console.log(`[TripService] Manually finished Trip #${finishedId}`);
        resolve(finishedId);
      });
    } else {
      resolve(null);
    }
  });
}

module.exports = {
  getCurrentTripId,
  getLastRecordTime,
  setLastRecordTime,
  ensureActiveTrip,
  updateTripStats,
  finishCurrentTrip
};
