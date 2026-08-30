import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { credentialPath, writeCredential } from '../src/auth/store.js';
import { profilePaths } from '../src/auth/profiles.js';

export async function credentialEnvironment(home, record) {
  const environment = {
    ...process.env,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    HOME: home,
    NO_COLOR: '1',
    XDG_CONFIG_HOME: path.join(home, '.config'),
  };
  const applicationRoot = path.dirname(credentialPath('credentials', { environment, home }));
  const paths = profilePaths('test', { root: applicationRoot });
  await mkdir(paths.directory, { recursive: true });
  await writeCredential(paths.gala, record);
  await writeCredential(paths.github, {
    accessToken: 'github-test-token',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  await writeFile(paths.metadata, JSON.stringify({
    schemaVersion: 2,
    name: 'test',
    gala: {
      userId: '01M00000000000000000000001',
      email: 'writer@example.com',
      displayName: 'Writer',
    },
    githubLogin: 'test',
  }));
  await writeFile(paths.active, 'test\n');
  return environment;
}
