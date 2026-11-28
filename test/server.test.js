const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function respond(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(raw) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
  });
}

async function waitForNotificationCount(deliveries, expectedCount) {
  const deadline = Date.now() + 2000;
  while (deliveries.length < expectedCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForNotificationAlertState(dataDir, profileId, expectedState) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    if (Number(saved.notifications.alertState?.[profileId] || 0) === expectedState) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Notification state for profile ${profileId} did not reach ${expectedState}.`);
}

async function localUpdateTree() {
  const root = path.resolve(__dirname, '..');
  const files = [
    'package.json',
    'package-lock.json',
    'server.js',
    'lib.js',
    'notifications.js',
  ];
  const collectFiles = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await collectFiles(fullPath);
      else if (entry.isFile()) files.push(path.relative(root, fullPath).split(path.sep).join('/'));
    }
  };
  await collectFiles(path.join(root, 'public'));
  return Promise.all(files.map(async (file) => {
    const content = await fs.readFile(path.join(root, ...file.split('/')));
    const sha = gitBlobSha(file, content);
    return { path: file, type: 'blob', sha };
  }));
}

function gitBlobSha(file, content) {
  const hashContent = file.endsWith('.png')
    ? content
    : Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'));
  return crypto.createHash('sha1')
    .update(`blob ${hashContent.length}\0`)
    .update(hashContent)
    .digest('hex');
}

test('Jellyfin sessions grant overview access and enforce Seerr admin permissions', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-tally-test-'));
  const mockServers = [];
  let app;
  let appModule;
  const previousEnvironment = {
    dataDir: process.env.STORAGE_TALLY_DATA_DIR,
    allowedHosts: process.env.ALLOWED_HOSTS,
    deployment: process.env.QUOTARR_DEPLOYMENT,
  };
  const seerrSessions = new Map();
  const seerrRequests = [{
    id: 11,
    type: 'movie',
    createdAt: '2024-01-02T00:00:00.000Z',
    media: { tmdbId: 99, posterPath: '/movie.jpg' },
    requestedBy: { id: 1 },
  }];
  const radarrMovies = [
    { id: 5, tmdbId: 99, title: 'Test Movie', sizeOnDisk: 4096, releaseDate: '2023-12-01' },
  ];
  const sonarrSeries = [];
  const radarrDeletes = [];
  const sonarrDeletes = [];
  const notificationDeliveries = [];
  const failedDeleteIds = new Set([9]);

  const seerrServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/v1/auth/jellyfin' && request.method === 'POST') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const { username, password } = JSON.parse(raw);
      if (password !== 'valid-test-password') return respond(response, 401, { error: 'invalid' });
      const token = `session-${username}`;
      seerrSessions.set(token, {
        id: username === 'admin' ? 1 : 2,
        username,
        jellyfinUsername: username,
        email: `${username}@example.test`,
        permissions: username === 'admin' ? 2 : 0,
      });
      response.setHeader('Set-Cookie', `connect.sid=${token}; Path=/; HttpOnly`);
      return respond(response, 200, { ok: true });
    }
    if (url.pathname === '/api/v1/auth/me') {
      const cookie = request.headers.cookie || '';
      const session = [...seerrSessions.entries()].find(([token]) => cookie.includes(`connect.sid=${token}`))?.[1];
      return session ? respond(response, 200, session) : respond(response, 401, { error: 'unauthenticated' });
    }
    if (url.pathname === '/api/v1/user') {
      return respond(response, 200, { pageInfo: { results: 2 }, results: [
        { id: 1, username: 'admin' },
        { id: 2, username: 'regular' },
      ] });
    }
    if (url.pathname === '/api/v1/request') {
      const requests = [...seerrRequests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return respond(response, 200, { pageInfo: { results: requests.length }, results: requests });
    }
    return respond(response, 404, { error: 'not found' });
  });
  const createArrServer = (items, deletes) => http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'DELETE') {
      const id = Number(url.pathname.split('/').pop());
      deletes.push({ id, deleteFiles: url.searchParams.get('deleteFiles') });
      if (failedDeleteIds.has(id)) return respond(response, 500, { error: 'delete failed' });
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return respond(response, 404, { error: 'not found' });
      items.splice(index, 1);
      response.writeHead(200);
      return response.end();
    }
    return respond(response, 200, items);
  });
  const radarrServer = createArrServer(radarrMovies, radarrDeletes);
  const sonarrServer = createArrServer(sonarrSeries, sonarrDeletes);
  const notificationServer = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    notificationDeliveries.push({
      body: JSON.parse(raw),
      authorization: request.headers.authorization,
    });
    response.writeHead(204);
    response.end();
  });
  mockServers.push(seerrServer, radarrServer, sonarrServer, notificationServer);

  try {
    const seerrUrl = await listen(seerrServer);
    const radarrUrl = await listen(radarrServer);
    const sonarrUrl = await listen(sonarrServer);
    const notificationUrl = await listen(notificationServer);
    await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({
      services: {
        seerr: { url: seerrUrl, apiKey: 'test-seerr-key' },
        radarr: { url: radarrUrl, apiKey: 'test-radarr-key' },
        sonarr: { url: sonarrUrl, apiKey: 'test-sonarr-key' },
      },
      defaultCategory: 'Unrequested',
      caps: {},
      assignments: {},
      pageSize: 25,
    }));
    process.env.STORAGE_TALLY_DATA_DIR = dataDir;
    process.env.ALLOWED_HOSTS = 'localhost,127.0.0.1';
    appModule = require('../server');
    app = appModule.server;
    await appModule.loadSettings();
    const baseUrl = await listen(app);
    const call = (route, options = {}) => fetch(`${baseUrl}${route}`, options);
    assert.match(await (await call('/')).text(), /Notification services/);
    assert.match(await (await call('/')).text(), /data-settings-section="updates"/);
    assert.match(await (await call('/')).text(), /id="settings-updates"/);
    assert.match(await (await call('/service-worker.js')).text(), /showNotification/);
    const login = async (username) => {
      const response = await call('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'valid-test-password' }),
      });
      return {
        response,
        cookie: response.headers.getSetCookie()[0].split(';', 1)[0],
        body: await response.json(),
      };
    };

    assert.equal((await call('/api/dashboard')).status, 401);
    const regular = await login('regular');
    assert.equal(regular.response.status, 200);
    assert.equal(regular.body.user.isAdmin, false);
    assert.match(regular.response.headers.getSetCookie()[0], /HttpOnly/);
    const regularHeaders = { Cookie: regular.cookie };
    assert.equal((await call('/api/dashboard', { headers: regularHeaders })).status, 200);
    assert.equal((await call('/api/settings', { headers: regularHeaders })).status, 403);
    assert.equal((await call('/api/update', { headers: regularHeaders })).status, 403);
    assert.equal((await call('/api/notifications/test', {
      method: 'POST',
      headers: { ...regularHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'webhook' }),
    })).status, 403);
    assert.equal((await call('/api/settings', {
      method: 'POST',
      headers: { ...regularHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultCategory: 'Changed' }),
    })).status, 403);
    assert.equal((await call('/api/assign', {
      method: 'POST',
      headers: { ...regularHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'movie:99', profileId: '1' }),
    })).status, 403);
    assert.equal((await call('/api/assign-bulk', {
      method: 'POST',
      headers: { ...regularHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['movie:99'], profileId: '1' }),
    })).status, 403);
    assert.equal((await call('/api/delete-bulk', {
      method: 'POST',
      headers: { ...regularHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['movie:99'], confirmed: true }),
    })).status, 403);
    assert.equal((await call('/api/profile-order', {
      method: 'POST',
      headers: { ...regularHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ['2', '1'] }),
    })).status, 403);

    const admin = await login('admin');
    assert.equal(admin.response.status, 200);
    assert.equal(admin.body.user.isAdmin, true);
    const adminHeaders = { Cookie: admin.cookie };
    const originalFetch = global.fetch;
    const githubUrl = 'https://api.github.com/repos/Gabriel-Velez/Quotarr/commits?per_page=1';
    const latestSha = 'a'.repeat(40);
    const localTree = await localUpdateTree();
    const localPackage = await fs.readFile(path.resolve(__dirname, '..', 'package.json'));
    const packageJson = JSON.parse(localPackage);
    let updateAvailable = false;
    global.fetch = async (input, options) => {
      if (String(input) === githubUrl) {
        return new Response(JSON.stringify([{
          sha: latestSha,
          commit: {
            message: 'Test update\nDetails',
            committer: { date: '2026-11-26T18:04:21Z' },
          },
        }]), { headers: { 'Content-Type': 'application/json' } });
      }
      if (String(input) === `https://api.github.com/repos/Gabriel-Velez/Quotarr/git/trees/${latestSha}?recursive=1`) {
        const remotePackage = updateAvailable
          ? Buffer.from(localPackage.toString().replace(
            `"version": "${packageJson.version}"`,
            '"version": "1.0.1"',
          ))
          : localPackage;
        const tree = updateAvailable
          ? localTree.map((entry) => {
            if (entry.path === 'server.js') return { ...entry, sha: 'f'.repeat(40) };
            if (entry.path === 'package.json') return { ...entry, sha: gitBlobSha(entry.path, remotePackage) };
            return entry;
          })
          : localTree;
        return new Response(JSON.stringify({ truncated: false, tree }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (String(input) === `https://api.github.com/repos/Gabriel-Velez/Quotarr/contents/package.json?ref=${latestSha}`) {
        const remotePackage = updateAvailable
          ? localPackage.toString().replace(`"version": "${packageJson.version}"`, '"version": "1.0.1"')
          : localPackage.toString();
        return new Response(JSON.stringify({
          encoding: 'base64',
          content: Buffer.from(remotePackage).toString('base64'),
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input, options);
    };
    try {
      const npmCurrent = await requestJson(`${baseUrl}/api/update`, adminHeaders);
      assert.equal(npmCurrent.status, 200);
      assert.equal(npmCurrent.body.isUpToDate, true);
      assert.equal(npmCurrent.body.deploymentType, 'npm');
      assert.equal(npmCurrent.body.currentVersion, packageJson.version);
      assert.equal(npmCurrent.body.latestVersion, packageJson.version);

      updateAvailable = true;
      const npmUpdate = await requestJson(`${baseUrl}/api/update`, adminHeaders);
      assert.equal(npmUpdate.status, 200);
      assert.equal(npmUpdate.body.isUpToDate, false);
      assert.equal(npmUpdate.body.latestVersion, '1.0.1');
      assert.equal(npmUpdate.body.updateCommand, 'git pull && npm install && npm start');
      assert.equal(npmUpdate.body.commit.message, 'Test update');

      process.env.QUOTARR_DEPLOYMENT = 'docker';
      const dockerUpdate = await requestJson(`${baseUrl}/api/update`, adminHeaders);
      assert.equal(dockerUpdate.status, 200);
      assert.equal(dockerUpdate.body.isUpToDate, false);
      assert.equal(dockerUpdate.body.deploymentType, 'docker');
      assert.equal(dockerUpdate.body.updateCommand, 'git pull && docker compose up -d --build');
    } finally {
      global.fetch = originalFetch;
      if (previousEnvironment.deployment === undefined) delete process.env.QUOTARR_DEPLOYMENT;
      else process.env.QUOTARR_DEPLOYMENT = previousEnvironment.deployment;
    }
    const settingsResponse = await call('/api/settings', { headers: adminHeaders });
    assert.equal(settingsResponse.status, 200);
    const safeSettings = await settingsResponse.json();
    assert.equal(JSON.stringify(safeSettings).includes('test-seerr-key'), false);
    assert.equal(safeSettings.pageSize, 25);
    assert.equal(safeSettings.notifications.thresholdPercent, 80);
    assert.equal(safeSettings.notifications.enabled, true);
    assert.equal(safeSettings.notifications.providers.discord.length, 0);
    assert.deepEqual(
      Object.values(safeSettings.notifications.providers).map((providers) => providers.length),
      Array(10).fill(0),
    );
    assert.equal(JSON.stringify(safeSettings).includes('vapidPrivateKey'), false);
    const assignment = await call('/api/assign', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'movie:99', profileId: '1' }),
    });
    assert.equal(assignment.status, 200);
    const singleDashboard = await (await call('/api/dashboard', { headers: adminHeaders })).json();
    assert.equal(singleDashboard.items[0].profileId, '1');
    assert.equal(singleDashboard.requests[0].profileId, '1');
    const bulkAssignment = await call('/api/assign-bulk', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['movie:99', 'show:123', 'movie:99'], profileId: '2' }),
    });
    assert.equal(bulkAssignment.status, 200);
    assert.deepEqual(await bulkAssignment.json(), { assigned: 2 });
    const invalidBulkAssignment = await call('/api/assign-bulk', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [], profileId: '2' }),
    });
    assert.equal(invalidBulkAssignment.status, 400);
    const unconfirmedDelete = await call('/api/delete-bulk', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['movie:99'], deleteFromArr: false, deleteFiles: false }),
    });
    assert.equal(unconfirmedDelete.status, 400);
    const invalidFileDelete = await call('/api/delete-bulk', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['movie:99'], confirmed: true, deleteFromArr: false, deleteFiles: true }),
    });
    assert.equal(invalidFileDelete.status, 400);
    const deletion = await call('/api/delete-bulk', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['movie:99'], confirmed: true, deleteFromArr: false, deleteFiles: false }),
    });
    assert.equal(deletion.status, 200);
    assert.deepEqual(await deletion.json(), { deleted: 1, failed: [] });
    assert.deepEqual(radarrDeletes, []);
    const deletedDashboard = await (await call('/api/dashboard', { headers: adminHeaders })).json();
    assert.equal(deletedDashboard.items.length, 0);
    assert.equal(deletedDashboard.requests.length, 0);
    assert.equal(deletedDashboard.deletedItems[0].key, 'movie:99');
    assert.ok(Number.isFinite(Date.parse(deletedDashboard.deletedItems[0].deletedAt)));
    assert.ok(JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).deletedMedia['movie:99']);
    const regularDashboard = await (await call('/api/dashboard', { headers: regularHeaders })).json();
    assert.equal(Object.hasOwn(regularDashboard, 'deletedItems'), false);
    assert.equal(regularDashboard.items.length, 0);
    const restore = await call('/api/restore-media', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'movie:99' }),
    });
    assert.equal(restore.status, 200);
    const restoredDashboard = await (await call('/api/dashboard', { headers: adminHeaders })).json();
    assert.equal(restoredDashboard.items[0].key, 'movie:99');
    assert.deepEqual(restoredDashboard.deletedItems, []);
    const profileOrder = await call('/api/profile-order', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ['2', '1'] }),
    });
    assert.equal(profileOrder.status, 200);
    const dashboard = await (await call('/api/dashboard', { headers: adminHeaders })).json();
    assert.equal(dashboard.items[0].profileId, '2');
    assert.equal(dashboard.requests[0].profileId, '2');
    assert.equal(dashboard.requests[0].size, 4096);
    assert.equal(dashboard.requests[0].dateRequested, '2024-01-02T00:00:00.000Z');
    assert.deepEqual(dashboard.profiles.map(({ id }) => id), ['2', '1', 'default']);

    const crossOrigin = await call('/api/assign', {
      method: 'POST',
      headers: { ...adminHeaders, Origin: 'http://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'movie:99', profileId: '2' }),
    });
    assert.equal(crossOrigin.status, 403);
    const savedSettings = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8');
    assert.equal(savedSettings.includes('valid-test-password'), false);
    assert.deepEqual(JSON.parse(savedSettings).profileOrder, ['2', '1']);
    assert.equal(JSON.parse(savedSettings).assignments['movie:99'], '2');
    assert.equal(JSON.parse(savedSettings).assignments['show:123'], '2');
    assert.deepEqual(JSON.parse(savedSettings).profileNames, { '1': 'admin', '2': 'regular' });
    assert.deepEqual(JSON.parse(savedSettings).deletedMedia, {});
    assert.deepEqual(JSON.parse(savedSettings).reassignments['movie:99'], {
      seerrProfileId: '1',
      adminProfileId: '2',
    });
    assert.deepEqual(JSON.parse(savedSettings).reassignments['show:123'], {
      seerrProfileId: null,
      adminProfileId: '2',
    });

    radarrMovies.push(
      { id: 6, tmdbId: 100, title: 'External Delete Movie', sizeOnDisk: 8192 },
      { id: 7, tmdbId: 101, title: 'File Delete Movie', sizeOnDisk: 1024 },
    );
    sonarrSeries.push({ id: 8, tvdbId: 200, title: 'External Delete Show', statistics: { sizeOnDisk: 4096 } });
    const externalDeletion = await call('/api/delete-bulk', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['movie:100', 'show:200'], confirmed: true, deleteFromArr: true, deleteFiles: false }),
    });
    assert.equal(externalDeletion.status, 200);
    assert.deepEqual(await externalDeletion.json(), { deleted: 2, failed: [] });
    assert.deepEqual(radarrDeletes, [{ id: 6, deleteFiles: 'false' }]);
    assert.deepEqual(sonarrDeletes, [{ id: 8, deleteFiles: 'false' }]);
    const fileDeletion = await call('/api/delete-bulk', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['movie:101'], confirmed: true, deleteFromArr: true, deleteFiles: true }),
    });
    assert.equal(fileDeletion.status, 200);
    assert.deepEqual(await fileDeletion.json(), { deleted: 1, failed: [] });
    assert.deepEqual(radarrDeletes[1], { id: 7, deleteFiles: 'true' });
    const externalDashboard = await (await call('/api/dashboard', { headers: adminHeaders })).json();
    assert.deepEqual(externalDashboard.deletedItems, []);
    assert.equal(externalDashboard.items.some(({ key }) => ['movie:100', 'show:200', 'movie:101'].includes(key)), false);
    const externalRestore = await call('/api/restore-media', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'movie:100' }),
    });
    assert.equal(externalRestore.status, 404);
    radarrMovies.push({ id: 9, tmdbId: 102, title: 'Failed Delete Movie', sizeOnDisk: 2048 });
    const failedExternalDeletion = await call('/api/delete-bulk', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['movie:102'], confirmed: true, deleteFromArr: true, deleteFiles: false }),
    });
    assert.equal(failedExternalDeletion.status, 200);
    assert.deepEqual(await failedExternalDeletion.json(), {
      deleted: 1,
      failed: [{ title: 'Failed Delete Movie', message: 'Radarr returned HTTP 500.' }],
    });
    const failedDashboard = await (await call('/api/dashboard', { headers: adminHeaders })).json();
    assert.deepEqual(failedDashboard.deletedItems.map(({ key, externalRemovalStatus }) => [key, externalRemovalStatus]), [
      ['movie:102', 'failed'],
    ]);
    const restoreFailed = await call('/api/restore-media', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'movie:102' }),
    });
    assert.equal(restoreFailed.status, 200);
    assert.equal((await (await call('/api/dashboard', { headers: adminHeaders })).json()).items.some(({ key }) => key === 'movie:102'), true);

    const savedWithLegacyExternalDeletion = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    savedWithLegacyExternalDeletion.deletedMedia['movie:100'] = {
      deletedAt: new Date().toISOString(),
      item: { key: 'movie:100', title: 'Previously removed movie' },
      externalRemovalStatus: 'removed',
    };
    await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(savedWithLegacyExternalDeletion));
    await appModule.loadSettings();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).deletedMedia, {});
    assert.deepEqual((await (await call('/api/dashboard', { headers: adminHeaders })).json()).deletedItems, []);

    const notificationSettings = await call('/api/settings', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        services: {
          seerr: { url: seerrUrl, apiKey: '' },
          radarr: { url: radarrUrl, apiKey: '' },
          sonarr: { url: sonarrUrl, apiKey: '' },
        },
        defaultCategory: 'Unrequested',
        caps: { '1': 0.000001, '2': 0.00001 },
        pageSize: 25,
        notifications: {
          enabled: true,
          thresholdPercent: 80,
          notifyFull: true,
          providers: {
            webhook: [{
              instanceId: 'alert-hook',
              enabled: true,
              url: notificationUrl,
              secret: 'webhook-secret',
            }, {
              instanceId: 'alert-hook-secondary',
              enabled: true,
              url: notificationUrl,
              secret: 'second-webhook-secret',
            }],
          },
        },
      }),
    });
    assert.equal(notificationSettings.status, 200);
    const safeNotificationSettings = await notificationSettings.json();
    assert.equal(safeNotificationSettings.notifications.providers.webhook.length, 2);
    assert.equal(safeNotificationSettings.notifications.providers.webhook[0].configured, true);
    assert.equal(Object.hasOwn(safeNotificationSettings.notifications.providers.webhook[0], 'url'), false);
    assert.equal(JSON.stringify(safeNotificationSettings).includes(notificationUrl), false);
    assert.equal(JSON.stringify(safeNotificationSettings).includes('webhook-secret'), false);
    const reassignment = await call('/api/assign', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'movie:99', profileId: '1' }),
    });
    const reassignmentResult = await reassignment.json();
    assert.equal(reassignment.status, 200, reassignmentResult.error);
    await call('/api/dashboard', { headers: adminHeaders });
    await waitForNotificationCount(notificationDeliveries, 2);
    assert.equal(notificationDeliveries[0].body.event, 'storage_full');
    assert.equal(notificationDeliveries[0].body.profileId, '1');
    const reassignmentBack = await call('/api/assign', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'movie:99', profileId: '2' }),
    });
    assert.equal(reassignmentBack.status, 200);
    await call('/api/dashboard', { headers: adminHeaders });
    await waitForNotificationAlertState(dataDir, '1', 0);
    const testNotice = await call('/api/notifications/test', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'webhook', instanceId: 'alert-hook' }),
    });
    assert.equal(testNotice.status, 200);
    assert.equal(notificationDeliveries[2].body.event, 'test');
    assert.equal(notificationDeliveries[2].authorization, 'Bearer webhook-secret');
    await appModule.checkStorageNotifications();
    assert.equal(notificationDeliveries.length, 3);
    const thresholdCapUpdate = await call('/api/settings', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        services: {
          seerr: { url: seerrUrl, apiKey: '' },
          radarr: { url: radarrUrl, apiKey: '' },
          sonarr: { url: sonarrUrl, apiKey: '' },
        },
        defaultCategory: 'Unrequested',
        caps: { '1': 0.000001, '2': 0.0000045 },
        pageSize: 25,
      }),
    });
    assert.equal(thresholdCapUpdate.status, 200);
    await waitForNotificationCount(notificationDeliveries, 5);
    assert.equal(notificationDeliveries[3].body.event, 'storage_threshold');
    assert.equal(notificationDeliveries[3].body.profileId, '2');
    assert.ok(notificationDeliveries[3].body.percent >= 80 && notificationDeliveries[3].body.percent < 100);
    assert.equal(notificationDeliveries[4].body.event, 'storage_threshold');
    assert.equal(notificationDeliveries[4].authorization, 'Bearer second-webhook-secret');
    await appModule.checkStorageNotifications();
    assert.equal(notificationDeliveries.length, 5);
    const fullCapUpdate = await call('/api/settings', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        services: {
          seerr: { url: seerrUrl, apiKey: '' },
          radarr: { url: radarrUrl, apiKey: '' },
          sonarr: { url: sonarrUrl, apiKey: '' },
        },
        defaultCategory: 'Unrequested',
        caps: { '1': 0.000001, '2': 0.000003 },
        pageSize: 25,
      }),
    });
    assert.equal(fullCapUpdate.status, 200);
    await waitForNotificationCount(notificationDeliveries, 7);
    assert.equal(notificationDeliveries[5].body.event, 'storage_full');
    assert.equal(notificationDeliveries[6].body.event, 'storage_full');
    await appModule.checkStorageNotifications();
    assert.equal(notificationDeliveries.length, 7);

    const requestAlertState = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    requestAlertState.notifications.alertState['2'] = 0;
    await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(requestAlertState));
    await appModule.loadSettings();
    seerrRequests.push({
      id: 12,
      type: 'movie',
      createdAt: '2026-11-28T00:00:00.000Z',
      media: { tmdbId: 100, title: 'New Request' },
      requestedBy: { id: 2 },
    });
    const requestDashboard = await call('/api/dashboard', { headers: adminHeaders });
    assert.equal(requestDashboard.status, 200);
    await waitForNotificationCount(notificationDeliveries, 9);
    assert.equal(notificationDeliveries[7].body.event, 'storage_full');
    assert.equal(notificationDeliveries[8].body.event, 'storage_full');

    const notificationDeletion = await call('/api/delete-bulk', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['movie:99'], confirmed: true, deleteFromArr: false, deleteFiles: false }),
    });
    assert.equal(notificationDeletion.status, 200);
    await call('/api/dashboard', { headers: adminHeaders });
    await waitForNotificationAlertState(dataDir, '2', 0);
    const restoration = await call('/api/restore-media', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'movie:99' }),
    });
    assert.equal(restoration.status, 200);
    await call('/api/dashboard', { headers: adminHeaders });
    await waitForNotificationCount(notificationDeliveries, 11);
    assert.equal(notificationDeliveries[9].body.event, 'storage_full');
    assert.equal(notificationDeliveries[10].body.event, 'storage_full');

    await call('/api/settings', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        services: {
          seerr: { url: seerrUrl, apiKey: '' },
          radarr: { url: radarrUrl, apiKey: '' },
          sonarr: { url: sonarrUrl, apiKey: '' },
        },
        defaultCategory: 'Unrequested',
        caps: { '2': 0.000003 },
        pageSize: 25,
        notifications: {
          enabled: true,
          thresholdPercent: 80,
          notifyFull: true,
          providers: {
            webhook: [{
              instanceId: 'alert-hook',
              enabled: true,
              url: notificationUrl,
              secret: 'webhook-secret',
            }],
            webPush: [],
          },
        },
      }),
    });
    await appModule.loadSettings();
    const persistedProviders = await (await call('/api/settings', { headers: adminHeaders })).json();
    assert.equal(persistedProviders.notifications.providers.webhook.length, 1);
    assert.equal(persistedProviders.notifications.providers.webPush.length, 0);

    const resetAlertState = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    resetAlertState.notifications.alertState['2'] = 0;
    await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(resetAlertState));
    await appModule.loadSettings();
    await call('/api/settings', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        services: {
          seerr: { url: seerrUrl, apiKey: '' },
          radarr: { url: radarrUrl, apiKey: '' },
          sonarr: { url: sonarrUrl, apiKey: '' },
        },
        defaultCategory: 'Unrequested',
        caps: { '2': 0.000003 },
        pageSize: 25,
        notifications: {
          enabled: false,
          thresholdPercent: 80,
          notifyFull: true,
          providers: {
            webhook: [{ instanceId: 'alert-hook', enabled: true, url: '', secret: '' }],
          },
        },
      }),
    });
    await appModule.checkStorageNotifications();
    assert.equal(notificationDeliveries.length, 11);
    const disabledTest = await call('/api/notifications/test', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'webhook', instanceId: 'alert-hook' }),
    });
    assert.equal(disabledTest.status, 409);

    const legacyNotificationSettings = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    legacyNotificationSettings.notifications.providers = {
      discord: { enabled: false, webhookUrl: 'https://discord.test/legacy' },
      webPush: { enabled: false, subscriptions: [] },
      webhook: { enabled: true, url: notificationUrl, secret: 'legacy-secret' },
    };
    await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(legacyNotificationSettings));
    await appModule.loadSettings();
    const migratedSettings = await (await call('/api/settings', { headers: adminHeaders })).json();
    assert.equal(migratedSettings.notifications.enabled, false);
    assert.equal(migratedSettings.notifications.providers.webhook.length, 1);
    assert.equal(migratedSettings.notifications.providers.webhook[0].configured, true);
    assert.equal(migratedSettings.notifications.providers.discord.length, 1);
    assert.equal(migratedSettings.notifications.providers.discord[0].configured, true);
    assert.equal(migratedSettings.notifications.providers.webPush.length, 0);
    assert.equal(JSON.stringify(migratedSettings).includes('legacy-secret'), false);
  } finally {
    if (appModule) await appModule.checkStorageNotifications();
    if (app?.listening) await new Promise((resolve) => app.close(resolve));
    await Promise.all(mockServers.map((server) => server.listening
      ? new Promise((resolve) => server.close(resolve))
      : Promise.resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
    if (previousEnvironment.dataDir === undefined) delete process.env.STORAGE_TALLY_DATA_DIR;
    else process.env.STORAGE_TALLY_DATA_DIR = previousEnvironment.dataDir;
    if (previousEnvironment.allowedHosts === undefined) delete process.env.ALLOWED_HOSTS;
    else process.env.ALLOWED_HOSTS = previousEnvironment.allowedHosts;
    if (previousEnvironment.deployment === undefined) delete process.env.QUOTARR_DEPLOYMENT;
    else process.env.QUOTARR_DEPLOYMENT = previousEnvironment.deployment;
  }
});
