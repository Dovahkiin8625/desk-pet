import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function launchApp(options = {}) {
  const userDataDir = options.userDataDir || (await mkdtemp(join(tmpdir(), 'desk-pet-e2e-')));
  const app = await electron.launch({
    args: [join(ROOT, 'src', 'main', 'index.js')],
    cwd: ROOT,
    env: {
      ...process.env,
      DESK_PET_E2E: '1',
      DESK_PET_USER_DATA: userDataDir,
      ...(options.env || {}),
    },
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() => window.__pet && window.__pet.ready === true, null, { timeout: 30000 });
  return {
    app,
    win,
    userDataDir,
    async close() {
      await app.close();
      if (!options.userDataDir) await rm(userDataDir, { recursive: true, force: true });
    },
  };
}
