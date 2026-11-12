// User settings, kept in this browser. "?" (or H) opens the panel, which also lists the keyboard shortcuts.

export const SPEEDS = [1, 10, 100]; // clock speeds, x real time
export const DEFAULT_SPEED = 10; // every view (tracking, constellation time-lapse) opens at it; 1 is live
export const SPEED_NAMES: Record<number, string> = { 1: 'Real time', 10: 'Fast', 100: 'Faster' };

export const settings = {
  picture: true    // tracked satellite drawn as its picture on the globe instead of a dot
};
const KEY = 'fromupthere.settings';
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* blocked storage: defaults */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* this session only */ } };

const SHORTCUTS = [
  ['/', 'Search satellites'],
  ['?', 'Settings and shortcuts'],
  ['Esc', 'Back to the constellation (else stop following)'],
  ['F', 'Fullscreen'],
  ['G', 'Globe / flat map'],
  ['← →', 'Previous / next satellite of its constellation'],
  ['B', 'Camera bearing back to automatic'],
  ['[ ]', 'Constellation swaths: shorter / longer past window'],
  ['Ctrl + drag', 'Tilt the camera']
];

export function installSettings() {
  const dialog = document.createElement('dialog');
  dialog.id = 'settings';
  dialog.innerHTML = `<div>
    <h2>Settings</h2>
    <label><input type="checkbox" name="picture"> Satellite picture on the globe, instead of a dot</label>
    <h2>Keyboard</h2>
    <dl>${SHORTCUTS.map(([k, d]) => `<dt><kbd>${k}</kbd></dt><dd>${d}</dd>`).join('')}</dl>
    <form method="dialog"><button>Close</button></form>
  </div>`;
  document.body.appendChild(dialog);
  const picture = dialog.querySelector<HTMLInputElement>('input[name=picture]')!;
  picture.onchange = () => { settings.picture = picture.checked; save(); };
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); }); // click on the backdrop

  document.addEventListener('keydown', e => {
    if (document.activeElement?.tagName === 'INPUT' || e.ctrlKey || e.metaKey) return;
    if (e.key !== '?' && e.key !== 'h' && e.key !== 'H') return;
    e.preventDefault();
    if (dialog.open) return dialog.close();
    picture.checked = settings.picture;
    dialog.showModal();
  });
}
