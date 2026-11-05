const http = require('http');
const { spawn } = require('child_process');

function checkVite() {
  const req = http.get('http://localhost:5173', (res) => {
    console.log('[Runner] Vite is ready, launching Electron...');
    const electron = spawn('npx', ['electron', 'electron/main.cjs'], {
      stdio: 'inherit',
      shell: true,
    });
    electron.on('close', (code) => {
      process.exit(code || 0);
    });
  });

  req.on('error', () => {
    setTimeout(checkVite, 400);
  });
}

checkVite();
