// The session server for development, on Windows, macOS and Linux alike:
//
//   npm run server:setup   creates server/.venv and installs server/requirements.txt
//   npm run server         starts it on http://127.0.0.1:8030 with --reload
//
// The virtualenv's Python is server/.venv/Scripts/python.exe on Windows and
// server/.venv/bin/python elsewhere. PYTHON names the Python that creates the
// virtualenv (default: python on Windows, python3 elsewhere; 3.12 is the one the
// image uses).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');
const windows = process.platform === 'win32';
const venvPython = join(server, '.venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: server, stdio: 'inherit' });
  if (result.error) {
    console.error(`${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[2] === 'setup') {
  run(process.env.PYTHON || (windows ? 'python' : 'python3'), ['-m', 'venv', '.venv']);
  run(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
} else {
  if (!existsSync(venvPython)) {
    console.error('No virtualenv in server/.venv yet: run "npm run server:setup" first.');
    process.exit(1);
  }
  run(venvPython, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8030', '--reload']);
}
