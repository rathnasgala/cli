import path from 'node:path';

import { credentialPath, writeCredential } from '../src/auth/store.js';

export async function credentialEnvironment(home, record) {
  const environment = {
    ...process.env,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    HOME: home,
    NO_COLOR: '1',
    XDG_CONFIG_HOME: path.join(home, '.config'),
  };
  await writeCredential(credentialPath('credentials', { environment, home }), record);
  return environment;
}
