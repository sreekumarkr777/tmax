// Renders assets/icon.svg to assets/icon.png (1024px) and assets/icon.icns.
// Run with: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = path.join(__dirname, '..', 'assets');
app.dock && app.dock.hide();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = (await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })).resize({ width: 1024, height: 1024 });
  const png = path.join(dir, 'icon.png');
  fs.writeFileSync(png, img.toPNG());

  if (process.platform === 'darwin') {
    const set = path.join(app.getPath('temp'), 'tmax.iconset');
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      execFileSync('sips', ['-z', String(s), String(s), png, '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
      execFileSync('sips', ['-z', String(s * 2), String(s * 2), png, '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(dir, 'icon.icns')]);
  }
  console.log('wrote', png);
  app.exit(0);
});
