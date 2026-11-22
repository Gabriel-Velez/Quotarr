const assert = require('node:assert/strict');
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

test('Jellyfin sessions grant overview access and enforce Seerr admin permissions', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-tally-test-'));
  const mockServers = [];
  let app;
  const previousEnvironment = {
    dataDir: process.env.STORAGE_TALLY_DATA_DIR,
    allowedHosts: process.env.ALLOWED_HOSTS,
  };
  const seerrSessions = new Map();

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
      return respond(response, 200, { pageInfo: { results: 1 }, results: [{
        id: 11,
        type: 'movie',
        createdAt: '2024-01-02T00:00:00.000Z',
        media: { tmdbId: 99, posterPath: '/movie.jpg' },
        requestedBy: { id: 2 },
      }] });
    }
    return respond(response, 404, { error: 'not found' });
  });
  const radarrServer = http.createServer((request, response) => respond(response, 200, [{
    id: 5, tmdbId: 99, title: 'Test Movie', sizeOnDisk: 4096, releaseDate: '2023-12-01',
  }]));
  const sonarrServer = http.createServer((request, response) => respond(response, 200, []));
  mockServers.push(seerrServer, radarrServer, sonarrServer);

  try {
    const seerrUrl = await listen(seerrServer);
    const radarrUrl = await listen(radarrServer);
    const sonarrUrl = await listen(sonarrServer);
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
    const appModule = require('../server');
    app = appModule.server;
    await appModule.loadSettings();
    const baseUrl = await listen(app);
    const call = (route, options = {}) => fetch(`${baseUrl}${route}`, options);
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
    assert.equal((await call('/api/profile-order', {
      method: 'POST',
      headers: { ...regularHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ['2', '1'] }),
    })).status, 403);

    const admin = await login('admin');
    assert.equal(admin.response.status, 200);
    assert.equal(admin.body.user.isAdmin, true);
    const adminHeaders = { Cookie: admin.cookie };
    const settingsResponse = await call('/api/settings', { headers: adminHeaders });
    assert.equal(settingsResponse.status, 200);
    const safeSettings = await settingsResponse.json();
    assert.equal(JSON.stringify(safeSettings).includes('test-seerr-key'), false);
    assert.equal(safeSettings.pageSize, 25);
    const assignment = await call('/api/assign', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'movie:99', profileId: '1' }),
    });
    assert.equal(assignment.status, 200);
    const singleDashboard = await (await call('/api/dashboard', { headers: adminHeaders })).json();
    assert.equal(singleDashboard.items[0].profileId, '1');
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
    const profileOrder = await call('/api/profile-order', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ['2', '1'] }),
    });
    assert.equal(profileOrder.status, 200);
    const dashboard = await (await call('/api/dashboard', { headers: adminHeaders })).json();
    assert.equal(dashboard.items[0].profileId, '2');
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
  } finally {
    if (app?.listening) await new Promise((resolve) => app.close(resolve));
    await Promise.all(mockServers.map((server) => server.listening
      ? new Promise((resolve) => server.close(resolve))
      : Promise.resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
    if (previousEnvironment.dataDir === undefined) delete process.env.STORAGE_TALLY_DATA_DIR;
    else process.env.STORAGE_TALLY_DATA_DIR = previousEnvironment.dataDir;
    if (previousEnvironment.allowedHosts === undefined) delete process.env.ALLOWED_HOSTS;
    else process.env.ALLOWED_HOSTS = previousEnvironment.allowedHosts;
  }
});
