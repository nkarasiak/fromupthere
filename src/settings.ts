// User settings, kept in this browser. "?" (or H) opens the panel, which also lists the keyboard shortcuts.

export const SPEEDS = [1, 10, 100, 300]; // time-lapse speeds, x real time

export const settings = {
  speed: 100,      // constellation time-lapse speed it opens at
  picture: false   // tracked satellite drawn as its picture on the globe instead of a dot
};
const KEY = 'fromupthere.settings';
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* blocked storage: defaults */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* this session only */ } };

const SHORTCUTS = [
  ['/', 'Search satellites'],
  ['?', 'Settings and shortcuts'],
  ['Esc', 'Stop following the satellite'],
  ['F', 'Fullscreen'],
  ['G', 'Globe / flat map'],
  ['B', 'Camera bearing back to automatic'],
  ['Ctrl + drag', 'Tilt the camera']
];

export function installSettings() {
  const dialog = document.createElement('dialog');
  dialog.id = 'settings';
  dialog.innerHTML = `<div>
    <h2>Settings</h2>
    <label>Constellation time-lapse speed
      <select name="speed">${SPEEDS.map(v => `<option value="${v}">×${v}</option>`).join('')}</select></label>
    <label><input type="checkbox" name="picture"> Satellite picture on the globe, instead of a dot</label>
    <h2>Keyboard</h2>
    <dl>${SHORTCUTS.map(([k, d]) => `<dt><kbd>${k}</kbd></dt><dd>${d}</dd>`).join('')}</dl>
    <form method="dialog"><button>Close</button></form>
  </div>`;
  document.body.appendChild(dialog);
  const speed = dialog.querySelector<HTMLSelectElement>('select[name=speed]')!;
  const picture = dialog.querySelector<HTMLInputElement>('input[name=picture]')!;
  speed.onchange = () => { settings.speed = Number(speed.value); save(); };
  picture.onchange = () => { settings.picture = picture.checked; save(); };
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); }); // click on the backdrop

  document.addEventListener('keydown', e => {
    if (document.activeElement?.tagName === 'INPUT' || e.ctrlKey || e.metaKey) return;
    if (e.key !== '?' && e.key !== 'h' && e.key !== 'H') return;
    e.preventDefault();
    if (dialog.open) return dialog.close();
    speed.value = String(settings.speed);
    picture.checked = settings.picture;
    dialog.showModal();
  });
}
