// macOS shows the app bundle's name (not app.setName) in bold in the menu bar, and its
// icon in the Dock while the app launches. In development that bundle is node_modules/electron's
// Electron.app, so give it Tmax's name and icon. Safe to rerun.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.platform !== 'darwin') process.exit(0);
const NAME = 'Tmax';
const root = path.join(__dirname, '..');
const bundle = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents');
const plist = path.join(bundle, 'Info.plist');
if (!fs.existsSync(plist)) process.exit(0);
let changed = false;
const get = (k) => { try { return execFileSync('plutil', ['-extract', k, 'raw', plist]).toString().trim(); } catch { return ''; } };
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  if (get(key) !== NAME) { execFileSync('plutil', ['-replace', key, '-string', NAME, plist]); changed = true; }
}

const icns = path.join(root, 'assets', 'icon.icns');
const target = path.join(bundle, 'Resources', 'electron.icns');
if (fs.existsSync(icns) && fs.existsSync(target) && !fs.readFileSync(icns).equals(fs.readFileSync(target))) {
  fs.copyFileSync(icns, target);
  changed = true;
}
if (changed) {
  // tell Finder/Dock to forget the cached name and icon
  try { execFileSync('touch', [path.dirname(bundle)]); } catch { /* ignore */ }
  try {
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', path.dirname(bundle)]);
  } catch { /* ignore */ }
}
