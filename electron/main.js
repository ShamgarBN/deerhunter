// Desktop shell.
//
// The server is not forked as a child process: it is imported and run inside this one.
// Forking would need a Node on the machine to fork, which is the opposite of standalone,
// and better-sqlite3 is a native module that has to match whichever runtime opens the
// database anyway. One process, one runtime, one copy of the scheduler.
//
// The window is a view onto that server, not the app. Closing it hides it and the app
// keeps running in the menu bar, because the whole point of packaging this was that the
// 3:20am refresh and the 7am alert only fire while something is running.

import { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Pinned before any getPath call, because userData is derived from the app name. Without
// it a dev run resolves to ".../Application Support/deerhunter" and the packaged app to
// ".../DeerHunter", so the two would quietly keep separate sit logs.
app.setName('DeerHunter');

// Everything the tool writes goes to Application Support. The app bundle is read-only and
// signed, so a config write inside it fails outright, and data that lives in the bundle
// would be destroyed by every reinstall.
const USER_DIR = app.getPath('userData');
const CONFIG_DIR = path.join(USER_DIR, 'config');
const DATA_DIR = path.join(USER_DIR, 'data');
const EXPORT_DIR = path.join(USER_DIR, 'exports');

process.env.DEERHUNTER_CONFIG_DIR = CONFIG_DIR;
process.env.DEERHUNTER_DATA_DIR = DATA_DIR;
process.env.DEERHUNTER_EXPORT_DIR = EXPORT_DIR;

let win = null;
let tray = null;
let serverPort = null;
let quitting = false;

const SEEDS = ['config.json', 'scoring.json', 'map.example.json'];

/** Copy the bundled defaults into the writable config dir on first run. */
function seedConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  for (const name of SEEDS) {
    const from = path.join(ROOT, 'config', name);
    const to = path.join(CONFIG_DIR, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
  }
}

/** Where this app was built from, recorded at build time. May not exist any more. */
function sourceHint() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron', 'build-info.json'), 'utf8'));
    return info.sourceDir && fs.existsSync(info.sourceDir) ? info.sourceDir : null;
  } catch { return null; }
}

const IMPORTABLE = [
  ['config', 'config.local.json'],
  ['config', 'map.json'],
  ['data', 'deerhunter.db'],
  ['data', 'normals-rdu.json'],
  ['data', 'cover-cache.json'],
];

/**
 * Bring a checkout's data across.
 *
 * This is the step that decides whether the packaged app is the same tool or a new empty
 * one. The sit log, the property map and the fitted weights are the accumulated value;
 * starting the desktop build with an empty database would quietly split his history in
 * two, with new sits going somewhere the old ones are not.
 */
function importFrom(dir) {
  const copied = [];
  for (const [sub, name] of IMPORTABLE) {
    const from = path.join(dir, sub, name);
    const to = path.join(sub === 'config' ? CONFIG_DIR : DATA_DIR, name);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, to);
      copied.push(name);
    }
  }
  // normals are named for the station, so catch whatever this install actually has.
  const dataDir = path.join(dir, 'data');
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir)) {
      if (/^normals.*\.json$/.test(f) && !fs.existsSync(path.join(DATA_DIR, f))) {
        fs.copyFileSync(path.join(dataDir, f), path.join(DATA_DIR, f));
        copied.push(f);
      }
    }
  }
  return copied;
}

function looksLikeInstall(dir) {
  return fs.existsSync(path.join(dir, 'data', 'deerhunter.db'))
    || fs.existsSync(path.join(dir, 'config', 'map.json'));
}

/**
 * First run only: offer to bring an existing install across.
 *
 * Asked rather than done silently, and asked BEFORE the server starts, because the
 * database has to be in place before anything opens it.
 */
async function offerImport() {
  if (fs.existsSync(path.join(DATA_DIR, 'deerhunter.db'))) return;   // already has data

  const hint = sourceHint();
  const buttons = hint
    ? ['Import from that folder', 'Choose another folder…', 'Start fresh']
    : ['Choose a folder…', 'Start fresh'];

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    title: 'DeerHunter',
    message: 'Bring your existing data across?',
    detail: hint
      ? `This looks like a first run. Your sit log, property map and fitted weights can be copied from:\n\n${hint}\n\nStarting fresh gives you an empty log and the default weights.`
      : 'This looks like a first run. If you have been running DeerHunter from a folder already, its sit log, property map and fitted weights can be copied across.',
  });

  let dir = null;
  if (hint && response === 0) dir = hint;
  else if ((hint && response === 1) || (!hint && response === 0)) {
    const picked = await dialog.showOpenDialog({
      title: 'Pick your DeerHunter folder',
      defaultPath: hint ?? app.getPath('home'),
      properties: ['openDirectory'],
    });
    dir = picked.canceled ? null : picked.filePaths[0];
  }
  if (!dir) return;

  if (!looksLikeInstall(dir)) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'DeerHunter',
      message: 'That folder has no DeerHunter data in it.',
      detail: 'Expected a data/deerhunter.db or a config/map.json inside it. Starting fresh instead; you can import later from the menu bar.',
    });
    return;
  }

  const copied = importFrom(dir);
  await dialog.showMessageBox({
    type: 'info',
    title: 'DeerHunter',
    message: copied.length ? 'Imported.' : 'Nothing to import.',
    detail: copied.length
      ? `Copied: ${copied.join(', ')}.\n\nThe original folder is untouched, so the two now have separate copies. Anything you log here will not appear there.`
      : 'That folder had none of the files this looks for.',
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'DeerHunter',
    backgroundColor: '#0a0b06',   // matches the app's own background, so no white flash
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.loadURL(`http://127.0.0.1:${serverPort}/`);
  win.once('ready-to-show', () => win.show());

  // Links that are not the dashboard open in the real browser rather than replacing it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window hides it. Quitting is a deliberate act from the menu bar, because
  // a closed window that killed the scheduler would silently stop the alerts.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else { win.show(); win.focus(); }
}

async function runJob(name, fn) {
  try {
    const r = await fn();
    return { ok: true, r };
  } catch (err) {
    dialog.showMessageBox({ type: 'error', title: 'DeerHunter', message: `${name} failed`, detail: err.message });
    return { ok: false };
  }
}

function buildTray(jobs) {
  const img = nativeImage.createFromPath(path.join(ROOT, 'assets', 'trayTemplate.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 }));
  tray.setToolTip('DeerHunter');

  const rebuild = () => {
    const openAtLogin = app.getLoginItemSettings().openAtLogin;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open DeerHunter', click: showWindow },
      { type: 'separator' },
      { label: 'Refresh now', click: () => runJob('Refresh', () => jobs.refresh({ log: console.log })) },
      { label: 'Check alerts now', click: () => runJob('Alert check', () => jobs.checkAlerts({ log: console.log })) },
      { label: 'Back up now', click: () => runJob('Backup', async () => jobs.writeBackup({ log: console.log })) },
      { type: 'separator' },
      { label: 'Show data folder', click: () => shell.openPath(USER_DIR) },
      {
        label: 'Import from another folder…',
        click: async () => {
          const picked = await dialog.showOpenDialog({ title: 'Pick a DeerHunter folder', properties: ['openDirectory'] });
          if (picked.canceled) return;
          const dir = picked.filePaths[0];
          if (!looksLikeInstall(dir)) {
            dialog.showMessageBox({ type: 'warning', title: 'DeerHunter', message: 'No DeerHunter data in that folder.' });
            return;
          }
          // Replacing the open database underneath a running server would be a good way
          // to corrupt both, so this one restarts rather than hot-swapping.
          const { response } = await dialog.showMessageBox({
            type: 'warning',
            buttons: ['Import and restart', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: 'Import and replace the current data?',
            detail: 'Your current sit log, map and weights in this app will be overwritten by that folder\'s. A backup is written first.',
          });
          if (response !== 0) return;
          await runJob('Backup', async () => jobs.writeBackup({ log: console.log }));
          importFrom(dir);
          quitting = true;
          app.relaunch();
          app.exit(0);
        },
      },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
          rebuild();
        },
      },
      { type: 'separator' },
      { label: 'Quit DeerHunter', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  rebuild();
  tray.on('click', showWindow);
}

// One instance only. A second copy would arm a second scheduler against the same
// database and double every Discord alert.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
      const dockIcon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png'));
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    }

    seedConfig();
    await offerImport();

    // Imported after the env paths are set and the data is in place: these modules read
    // the paths at import time and open the database on first use.
    const { start } = await import('../src/server.js');
    const jobsMod = await import('../src/jobs.js');
    const backupMod = await import('../src/backup.js');

    try {
      // Port 0: let the OS pick. A fixed port collides with a copy already running from
      // the checkout, which is exactly the situation during development.
      const started = await start({ port: 0, host: '127.0.0.1' });
      serverPort = started.port;
    } catch (err) {
      dialog.showErrorBox('DeerHunter could not start', err.message);
      app.exit(1);
      return;
    }

    buildTray({ refresh: jobsMod.refresh, checkAlerts: jobsMod.checkAlerts, writeBackup: backupMod.writeBackup });
    createWindow();
  });

  // Deliberately no window-all-closed quit: the scheduler is the reason this is an app
  // rather than a browser tab, and it has to outlive the window.
  app.on('activate', showWindow);
  app.on('before-quit', () => { quitting = true; });
}
