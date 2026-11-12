// The opening: the bare globe (imagery hidden, still loading: nothing is ever seen loading) and its atmosphere lit by the
// real Sun, whole until the satellite's orbit comes, then low over the satellite's own area, a little to its left. It holds, creeping closer, while the landing view
// loads out of sight, then the imagery fades in and the camera zooms in to the satellite, swinging round behind it.
export const OPENING = {
  APPROACH_MS: 2500, // from the whole globe over to the satellite's area, once its orbit is known
  MIN_MS: 2000,    // then the bare globe holds at least this long (a fast connection doesn't cut it short)
  MAX_MS: 8000,    // ...and at most this long (a slow one isn't stuck on it)
  REVEAL_MS: 1000, // the imagery fading in
  DIVE_MS: 5000    // the zoom in to the satellite
};

const ZOOM_OUT = 0.8;  // levels farther than the landing view: a wide horizon arc across the screen (3: a small globe, far off)
const PITCH = 72;      // low over the globe: its edge a wide arc at mid-screen
const CREEP = 0.15;    // zoom levels closer over OPENING.MAX_MS while it holds (so it isn't a still picture)
const SWING = 35;      // deg the camera starts round to the satellite's left: the dive swings in behind it

/** The opening camera for a landing view `end` (a map camera); `creep`: where it creeps to while it holds */
export function openingCamera(end: { center: [number, number]; zoom: number; bearing: number }, creep = false) {
  return {
    center: end.center, bearing: end.bearing + SWING, pitch: PITCH,
    zoom: end.zoom - ZOOM_OUT + (creep ? CREEP : 0),
    padding: { top: 0, bottom: 0, left: 0, right: 0 }
  };
}
