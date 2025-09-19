export function generateAndDownloadBridge() {
    const zip = new JSZip();

    const packageJsonContent = `{
  "name": "websim-forge-bridge",
  "version": "2.0.0",
  "description": "Local bridge that builds Electron apps via Electron Forge.",
  "main": "index.js",
  "scripts": {
    "start:bridge": "node index.js",
    "start:server": "node download-server.js",
    "start": "npm-run-all --parallel start:bridge start:server",
    "postinstall": "npm audit fix --force || echo 'Continuing despite audit issues...'"
  },
  "license": "MIT",
  "dependencies": {
    "archiver": "^7.0.1",
    "rimraf": "^5.0.7",
    "ws": "^8.17.0"
  },
  "devDependencies": {
    "electron": "^30.0.0",
    "@electron-forge/cli": "^7.5.0",
    "@electron-forge/maker-zip": "^7.5.0",
    "npm-run-all": "^4.1.5"
  }
}
`;

    const indexJsContent = `
const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { rimraf } = require('rimraf');

const APP_DIR = path.join(__dirname, 'forge-app');
const OUT_DIR = path.join(APP_DIR, 'out');
const MAKE_DIR = path.join(OUT_DIR, 'make');

const PORT = 3001;
const wss = new WebSocket.Server({ port: PORT });

console.log(\`WebSocket bridge listening on ws://localhost:\${PORT}\`);

// Check and install dependencies on startup
checkDependencies();

wss.on('connection', ws => {
    console.log('Client connected');

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'start_build') {
                console.log('Received build request:', data);
                handleBuild(data, ws);
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
            ws.send(JSON.stringify({ type: 'build_error', error: 'Invalid request from client.' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

function checkDependencies() {
    console.log('Checking system dependencies...');
    if (process.platform === 'linux') {
        exec('which wine', (err) => {
            if (err) console.warn('Wine not found. Windows builds may fail. Install: sudo apt-get install -y wine');
            else console.log('Wine found.');
        });
    }
}

// Helper: wait X ms
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: cleanup old files from dist
function cleanupOldFiles(distDir, maxAgeMs = 15 * 60 * 1000) {
    fs.readdir(distDir, (err, files) => {
        if (err) return;
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(distDir, file);
            fs.stat(filePath, (err, stats) => {
                if (!err && now - stats.mtimeMs > maxAgeMs) {
                    fs.unlink(filePath, () => {});
                }
            });
        });
    });
}

function ensureForgeAppTemplate() {
  if (fs.existsSync(APP_DIR)) return;
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(path.join(APP_DIR, 'src'), { recursive: true });
  fs.writeFileSync(path.join(APP_DIR, 'src', 'main.js'), \`
const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path'); const fs = require('fs');
const cfgPath = path.join(process.resourcesPath || __dirname, 'config.json');
let cfg = { url: 'https://example.com', title: 'App' };
try { const raw = fs.readFileSync(cfgPath, 'utf8'); cfg = JSON.parse(raw); } catch {}
function createWindow() {
  const win = new BrowserWindow({ width: 1280, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.setMenu(null); win.loadURL(cfg.url); win.setTitle(cfg.title || 'App');
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
\`);
  fs.writeFileSync(path.join(APP_DIR, 'forge.config.js'), \`
module.exports = { makers: [ { name: '@electron-forge/maker-zip' } ] };
\`);
  fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify({
    name: "forge-web-wrapper",
    productName: "Forge Web Wrapper",
    version: "1.0.0",
    main: "src/main.js",
    config: { forge: "./forge.config.js" },
    devDependencies: { electron: "^30.0.0", "@electron-forge/cli": "^7.5.0", "@electron-forge/maker-zip": "^7.5.0" },
    scripts: { start: "electron-forge start", make: "electron-forge make" }
  }, null, 2));
}

function zipDirectory(source, out) {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = fs.createWriteStream(out);

    return new Promise((resolve, reject) => {
        archive
            .directory(source, false)
            .on('error', err => reject(err))
            .pipe(stream);

        stream.on('close', () => resolve(out));
        archive.finalize();
    });
}

async function handleBuild(options, ws, attempt = 1) {
  const { url, platform, arch, appName, requestId } = options;
  const distDir = path.join(__dirname, 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
  ensureForgeAppTemplate();

  const cfg = { url, title: appName || 'App' };
  const cfgPath = path.join(APP_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const cmd = \`npx electron-forge make --platform=\${platform} --arch=\${arch}\`;
  console.log(\`[Attempt \${attempt}] Executing: \${cmd}\`);
  ws.send(JSON.stringify({ type: 'build_progress', message: \`[Attempt \${attempt}] Forge make started...\`, requestId }));

  const child = exec(cmd, { cwd: APP_DIR });
  child.stdout.on('data', d => console.log('stdout:', d.toString().trim()));
  child.stderr.on('data', d => console.error('stderr:', d.toString().trim()));
  child.on('close', async (code) => {
    if (code !== 0) {
      const msg = \`electron-forge exited with code \${code}\`;
      if (attempt < 3) { ws.send(JSON.stringify({ type: 'build_progress', message: \`Build failed, retrying (\${attempt+1}/3)...\`, requestId })); return handleBuild(options, ws, attempt+1); }
      ws.send(JSON.stringify({ type: 'build_error', error: msg, requestId })); return;
    }
    // Find the produced zip
    let foundZip = null;
    if (fs.existsSync(MAKE_DIR)) {
      const files = fs.readdirSync(MAKE_DIR).filter(f => f.endsWith('.zip'));
      files.sort((a,b)=>fs.statSync(path.join(MAKE_DIR,b)).mtimeMs - fs.statSync(path.join(MAKE_DIR,a)).mtimeMs);
      foundZip = files[0] ? path.join(MAKE_DIR, files[0]) : null;
    }
    if (!foundZip) { ws.send(JSON.stringify({ type: 'build_error', error: 'No zip artifact produced.', requestId })); return; }
    const outName = \`\${(appName||'App').replace(/[^a-zA-Z0-9.-]/g,'')}_\${platform}_\${Date.now()}.zip\`;
    const outPath = path.join(distDir, outName);
    fs.copyFileSync(foundZip, outPath);
    ws.send(JSON.stringify({ type: 'build_complete', fileName: outName, appName: appName||'App', requestId, downloadUrl: \`/download?file=\${encodeURIComponent(outName)}\` }));
  });
}

// Helper: wait X ms
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: cleanup old files from dist
function cleanupOldFiles(distDir, maxAgeMs = 15 * 60 * 1000) {
    fs.readdir(distDir, (err, files) => {
        if (err) return;
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(distDir, file);
            fs.stat(filePath, (err, stats) => {
                if (!err && now - stats.mtimeMs > maxAgeMs) {
                    fs.unlink(filePath, () => {});
                }
            });
        });
    });
}

function zipDirectory(source, out) {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = fs.createWriteStream(out);

    return new Promise((resolve, reject) => {
        archive
            .directory(source, false)
            .on('error', err => reject(err))
            .pipe(stream);

        stream.on('close', () => resolve(out));
        archive.finalize();
    });
}

async function handleBuild(options, ws, attempt = 1) {
  const { url, platform, arch, appName, requestId } = options;
  const distDir = path.join(__dirname, 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
  ensureForgeAppTemplate();

  const cfg = { url, title: appName || 'App' };
  const cfgPath = path.join(APP_DIR, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const cmd = \`npx electron-forge make --platform=\${platform} --arch=\${arch}\`;
  console.log(\`[Attempt \${attempt}] Executing: \${cmd}\`);
  ws.send(JSON.stringify({ type: 'build_progress', message: \`[Attempt \${attempt}] Forge make started...\`, requestId }));

  const child = exec(cmd, { cwd: APP_DIR });
  child.stdout.on('data', d => console.log('stdout:', d.toString().trim()));
  child.stderr.on('data', d => console.error('stderr:', d.toString().trim()));
  child.on('close', async (code) => {
    if (code !== 0) {
      const msg = \`electron-forge exited with code \${code}\`;
      if (attempt < 3) { ws.send(JSON.stringify({ type: 'build_progress', message: \`Build failed, retrying (\${attempt+1}/3)...\`, requestId })); return handleBuild(options, ws, attempt+1); }
      ws.send(JSON.stringify({ type: 'build_error', error: msg, requestId })); return;
    }
    // Find the produced zip
    let foundZip = null;
    if (fs.existsSync(MAKE_DIR)) {
      const files = fs.readdirSync(MAKE_DIR).filter(f => f.endsWith('.zip'));
      files.sort((a,b)=>fs.statSync(path.join(MAKE_DIR,b)).mtimeMs - fs.statSync(path.join(MAKE_DIR,a)).mtimeMs);
      foundZip = files[0] ? path.join(MAKE_DIR, files[0]) : null;
    }
    if (!foundZip) { ws.send(JSON.stringify({ type: 'build_error', error: 'No zip artifact produced.', requestId })); return; }
    const outName = \`\${(appName||'App').replace(/[^a-zA-Z0-9.-]/g,'')}_\${platform}_\${Date.now()}.zip\`;
    const outPath = path.join(distDir, outName);
    fs.copyFileSync(foundZip, outPath);
    ws.send(JSON.stringify({ type: 'build_complete', fileName: outName, appName: appName||'App', requestId, downloadUrl: \`/download?file=\${encodeURIComponent(outName)}\` }));
  });
}
`;

    const exeServerContent = `
const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST_DIR = path.join(__dirname, 'dist'); const PORT = 3002;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/download?file=')) {
    const fileName = decodeURIComponent(req.url.split('=')[1] || '');
    if (path.normalize(fileName).includes('..') || !fileName.endsWith('.zip')) { res.writeHead(400); return res.end('Invalid request'); }
    const filePath = path.join(DIST_DIR, fileName);
    if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('File not found'); }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': \`attachment; filename="\${fileName}"\`, 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(filePath).pipe(res);
  } else { res.writeHead(404); res.end('Not found'); }
});
server.listen(PORT, 'localhost', () => console.log(\`Download server at http://localhost:\${PORT}\`));
`;

    zip.file("package.json", packageJsonContent);
    zip.file("download-server.js", exeServerContent);
    zip.file("index.js", indexJsContent);
    zip.folder("builds");
    zip.folder("dist");

    zip.generateAsync({ type: "blob" })
        .then(function(content) {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(content);
            link.download = "websim-bridge.zip";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
}