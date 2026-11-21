// macOS shows the bundle's name (not app.setName) in bold in the menu bar. In development
// that bundle is node_modules/electron's Electron.app, so give it our name. Safe to rerun.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.platform !== 'darwin') process.exit(0);
const NAME = 'Tmax';
const plist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist');
if (!fs.existsSync(plist)) process.exit(0);
const get = (k) => { try { return execFileSync('plutil', ['-extract', k, 'raw', plist]).toString().trim(); } catch { return ''; } };
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  if (get(key) !== NAME) execFileSync('plutil', ['-replace', key, '-string', NAME, plist]);
}
