const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { version: APP_VERSION } = require('./package.json');
const { buildInventory, requestKey } = require('./lib');
const {
  DEFAULT_PROVIDERS,
  generateVAPIDKeys,
  PROVIDER_IDS,
  SECRET_FIELDS,
  isConfigured,
  sendProviderNotification,
  setVapidDetails,
} = require('./notifications');

const ROOT = __dirname;
const DATA_DIR = process.env.STORAGE_TALLY_DATA_DIR
  ? path.resolve(process.env.STORAGE_TALLY_DATA_DIR)
  : path.join(ROOT, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4173;
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_HOSTS || 'localhost,127.0.0.1,[::1]').split(',').map((host) => host.trim()).filter(Boolean));
const SESSION_COOKIE = 'storage_tally_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_PERMISSION = 2;
const GITHUB_REPOSITORY = 'Gabriel-Velez/Quotarr';
const UPDATE_TRACKED_FILES = [
  'package.json',
  'package-lock.json',
  'server.js',
  'lib.js',
  'notifications.js',
];
const sessions = new Map();
const loginAttempts = new Map();
const DEFAULTS = {
  services: {
    seerr: { url: '', apiKey: '' },
    radarr: { url: '', apiKey: '' },
    sonarr: { url: '', apiKey: '' },
  },
  defaultCategory: 'Unrequested',
  caps: {},
  profileNames: {},
  assignments: {},
  reassignments: {},
  deletedMedia: {},
  profileOrder: [],
  pageSize: 25,
  notifications: {
    enabled: true,
    providers: DEFAULT_PROVIDERS,
    thresholdPercent: 80,
    notifyFull: true,
    alertState: {},
    vapidPublicKey: '',
    vapidPrivateKey: '',
  },
};

let settings = { ...DEFAULTS };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeProviderInstances(id, savedValue) {
  const isProvider = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const hasSavedValues = isProvider(savedValue) && Object.entries(savedValue).some(([key, value]) => {
    if (key === 'enabled' || key === 'instanceId') return false;
    if (id === 'webPush' && key === 'subscriptions') {
      return Array.isArray(value) && value.length > 0;
    }
    if (id === 'email' && key === 'port' && Number(value) === 587) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'boolean') return value;
    return value != null;
  });
  const legacyHasSettings = isProvider(savedValue)
    && (savedValue.enabled === true || hasSavedValues);
  const savedInstances = Array.isArray(savedValue)
    ? savedValue
    : legacyHasSettings ? [savedValue] : [];
  const instanceIds = new Set();
  return savedInstances.flatMap((savedInstance) => {
    if (!isProvider(savedInstance)) return [];
    let instanceId = typeof savedInstance.instanceId === 'string'
      && /^[A-Za-z0-9_-]{1,100}$/.test(savedInstance.instanceId)
      ? savedInstance.instanceId
      : crypto.randomUUID();
    if (instanceIds.has(instanceId)) instanceId = crypto.randomUUID();
    instanceIds.add(instanceId);
    const instance = { ...savedInstance, instanceId, enabled: savedInstance.enabled === true };
    if (id === 'webPush') {
      instance.subscriptions = Array.isArray(instance.subscriptions) ? instance.subscriptions : [];
    }
    return [instance];
  });
}

async function loadSettings() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    const savedDeletedMedia = saved.deletedMedia;
    const deletedMedia = savedDeletedMedia && typeof savedDeletedMedia === 'object' && !Array.isArray(savedDeletedMedia)
      ? Object.fromEntries(Object.entries(savedDeletedMedia)
        .filter(([, record]) => !(record && typeof record === 'object' && record.externalRemovalStatus === 'removed')))
      : {};
    settings = {
      ...DEFAULTS,
      ...saved,
      services: { ...DEFAULTS.services, ...saved.services },
      caps: saved.caps || {},
      profileNames: saved.profileNames && typeof saved.profileNames === 'object' && !Array.isArray(saved.profileNames)
        ? Object.fromEntries(Object.entries(saved.profileNames)
          .filter(([id, name]) => id && id.length <= 100 && typeof name === 'string' && name.trim().length <= 255))
        : {},
      assignments: saved.assignments || {},
      reassignments: saved.reassignments || {},
      deletedMedia,
      profileOrder: Array.isArray(saved.profileOrder)
        ? [...new Set(saved.profileOrder.map(String).filter((id) => id && id !== 'default' && id.length <= 100))].slice(0, 20000)
        : DEFAULTS.profileOrder,
      pageSize: [10, 25, 50, 100].includes(Number(saved.pageSize)) ? Number(saved.pageSize) : DEFAULTS.pageSize,
      notifications: {
        ...DEFAULTS.notifications,
        ...(saved.notifications || {}),
        enabled: typeof saved.notifications?.enabled === 'boolean'
          ? saved.notifications.enabled
          : DEFAULTS.notifications.enabled,
        thresholdPercent: Number.isInteger(saved.notifications?.thresholdPercent)
          && saved.notifications.thresholdPercent >= 1
          && saved.notifications.thresholdPercent <= 99
          ? saved.notifications.thresholdPercent
          : DEFAULTS.notifications.thresholdPercent,
        notifyFull: typeof saved.notifications?.notifyFull === 'boolean'
          ? saved.notifications.notifyFull
          : DEFAULTS.notifications.notifyFull,
        providers: Object.fromEntries(PROVIDER_IDS.map((id) => [
          id,
          normalizeProviderInstances(id, saved.notifications?.providers?.[id]),
        ])),
        alertState: saved.notifications?.alertState && typeof saved.notifications.alertState === 'object'
          && !Array.isArray(saved.notifications.alertState)
          ? saved.notifications.alertState
          : {},
        vapidPublicKey: typeof saved.notifications?.vapidPublicKey === 'string'
          ? saved.notifications.vapidPublicKey
          : '',
        vapidPrivateKey: typeof saved.notifications?.vapidPrivateKey === 'string'
          ? saved.notifications.vapidPrivateKey
          : '',
      },
    };
    const providersNeedMigration = PROVIDER_IDS.some((id) => {
      const savedProviders = saved.notifications?.providers?.[id];
      const currentProviders = settings.notifications.providers[id];
      return !Array.isArray(savedProviders)
        || JSON.stringify(savedProviders) !== JSON.stringify(currentProviders);
    });
    if (!settings.notifications.vapidPublicKey || !settings.notifications.vapidPrivateKey) {
      const { publicKey, privateKey } = generateVAPIDKeys();
      settings = {
        ...settings,
        notifications: { ...settings.notifications, vapidPublicKey: publicKey, vapidPrivateKey: privateKey },
      };
      await saveSettings(settings);
    }
    if (savedDeletedMedia && Object.keys(savedDeletedMedia).length !== Object.keys(deletedMedia).length) {
      await saveSettings(settings);
    }
    if (providersNeedMigration) await saveSettings(settings);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    settings = {
      ...DEFAULTS,
      services: DEFAULTS.services,
      notifications: { ...DEFAULTS.notifications, providers: { ...DEFAULT_PROVIDERS } },
    };
  }
  if (!settings.notifications.vapidPublicKey || !settings.notifications.vapidPrivateKey) {
    const { publicKey, privateKey } = generateVAPIDKeys();
    settings = {
      ...settings,
      notifications: { ...settings.notifications, vapidPublicKey: publicKey, vapidPrivateKey: privateKey },
    };
    await saveSettings(settings);
  }
}

async function saveSettings(next) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${SETTINGS_FILE}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempFile, SETTINGS_FILE);
}

function safeSettings() {
  return {
    services: Object.fromEntries(
      Object.entries(settings.services).map(([name, service]) => [
        name,
        { url: service.url, configured: Boolean(service.apiKey) },
      ]),
    ),
    defaultCategory: settings.defaultCategory,
    caps: settings.caps,
    pageSize: settings.pageSize,
    notifications: {
      enabled: settings.notifications.enabled,
      thresholdPercent: settings.notifications.thresholdPercent,
      notifyFull: settings.notifications.notifyFull,
      providers: Object.fromEntries(PROVIDER_IDS.map((id) => [
        id,
        settings.notifications.providers[id].map((provider) => {
          const safeProvider = {
            instanceId: provider.instanceId,
            enabled: provider.enabled === true,
            configured: isConfigured(id, provider),
          };
          if (id === 'webPush') safeProvider.subscriptionCount = provider.subscriptions?.length || 0;
          if (id === 'email') {
            for (const field of ['host', 'port', 'secure', 'from', 'to']) {
              if (provider[field] !== undefined) safeProvider[field] = provider[field];
            }
          }
          if (id === 'gotify' || id === 'ntfy') {
            if (provider.url) safeProvider.url = provider.url;
            if (id === 'ntfy' && provider.topic) safeProvider.topic = provider.topic;
          }
          if (id === 'telegram' && provider.chatId) safeProvider.chatId = provider.chatId;
          return safeProvider;
        }),
      ])),
      webPushPublicKey: settings.notifications.vapidPublicKey,
    },
  };
}

function validateUrl(value, label) {
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} URL must be a valid http:// or https:// address.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} URL must use http:// or https:// and must not contain credentials, a query, or a fragment.`);
  }
  return url.toString().replace(/\/+$/, '');
}

function validateProviderConfig(id, submitted = {}, saved = {}) {
  const instanceId = String(submitted.instanceId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(instanceId)) {
    throw new Error(`The ${id} notification service has an invalid instance ID.`);
  }
  const config = { ...saved, instanceId, enabled: submitted.enabled === true };
  const fields = {
    email: ['host', 'port', 'secure', 'username', 'password', 'from', 'to'],
    discord: ['webhookUrl'],
    gotify: ['url', 'token'],
    ntfy: ['url', 'topic', 'token'],
    pushbullet: ['accessToken'],
    pushover: ['userKey', 'apiToken'],
    slack: ['webhookUrl'],
    telegram: ['botToken', 'chatId'],
    webhook: ['url', 'secret'],
  }[id] || [];

  for (const field of fields) {
    if (field === 'secure') {
      config.secure = submitted.secure === true;
      continue;
    }
    if (field === 'port') {
      const portValue = String(submitted.port ?? '').trim();
      if (!portValue) {
        config.port = 587;
        continue;
      }
      const port = Number(portValue);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Email SMTP port must be a number between 1 and 65535.');
      }
      config.port = port;
      continue;
    }
    const value = String(submitted[field] ?? '').trim();
    if (!value && SECRET_FIELDS[id]?.includes(field)) continue;
    if (value.length > 4096) throw new Error(`${id} notification settings contain a value that is too long.`);
    if (field === 'url' || field === 'webhookUrl') {
      config[field] = validateUrl(value, `${id} notification`);
    } else {
      config[field] = value;
    }
  }

  if (config.enabled) {
    const requiredFields = {
      email: ['host', 'from', 'to'],
      discord: ['webhookUrl'],
      gotify: ['url', 'token'],
      ntfy: ['url', 'topic'],
      pushbullet: ['accessToken'],
      pushover: ['userKey', 'apiToken'],
      slack: ['webhookUrl'],
      telegram: ['botToken', 'chatId'],
      webhook: ['url'],
    }[id] || [];
    if (!requiredFields.every((field) => config[field])) {
      throw new Error(`Complete the required ${id} notification settings before enabling it.`);
    }
    if (id === 'email' && config.username && !config.password) {
      throw new Error('Enter the SMTP password when SMTP authentication is enabled.');
    }
  }
  return config;
}

function safeEqualString(value, maximumLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

async function saveWebPushSubscription(request) {
  if (!settings.notifications.enabled) {
    throw new HttpError(409, 'Enable notifications in Settings before subscribing a browser.');
  }
  const body = await readJson(request);
  const instanceId = String(body.instanceId || '');
  const subscription = body.subscription;
  const endpoint = subscription?.endpoint;
  const keys = subscription?.keys;
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error('The browser returned an invalid Web Push subscription.');
  }
  if (!safeEqualString(endpoint, 4096) || endpointUrl.protocol !== 'https:' || endpointUrl.username || endpointUrl.password
    || !safeEqualString(keys?.p256dh, 1024) || !safeEqualString(keys?.auth, 1024)) {
    throw new Error('The browser returned an invalid Web Push subscription.');
  }
  const providers = [...settings.notifications.providers.webPush];
  const providerIndex = providers.findIndex((saved) => saved.instanceId === instanceId);
  if (providerIndex < 0) throw new HttpError(404, 'Add and save this Web Push service before subscribing a browser.');
  const provider = providers[providerIndex];
  const subscriptions = (provider.subscriptions || []).filter((saved) => saved.endpoint !== endpoint);
  if (subscriptions.length >= 25) throw new HttpError(400, 'Quotarr supports up to 25 Web Push subscriptions.');
  subscriptions.push({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  providers[providerIndex] = { ...provider, enabled: true, subscriptions };
  const nextProviders = { ...settings.notifications.providers, webPush: providers };
  settings = { ...settings, notifications: { ...settings.notifications, providers: nextProviders } };
  await saveSettings(settings);
  return safeSettings().notifications.providers.webPush.find((entry) => entry.instanceId === instanceId);
}

async function removeWebPushSubscription(request) {
  if (!settings.notifications.enabled) {
    throw new HttpError(409, 'Enable notifications in Settings before changing Web Push subscriptions.');
  }
  const body = await readJson(request);
  const instanceId = String(body.instanceId || '');
  const endpoint = String(body.endpoint || '');
  if (!safeEqualString(endpoint, 4096)) throw new Error('A valid Web Push endpoint is required.');
  const providers = [...settings.notifications.providers.webPush];
  const providerIndex = providers.findIndex((saved) => saved.instanceId === instanceId);
  if (providerIndex < 0) throw new HttpError(404, 'That Web Push service was not found.');
  const provider = providers[providerIndex];
  const subscriptions = (provider.subscriptions || []).filter((saved) => saved.endpoint !== endpoint);
  providers[providerIndex] = {
    ...provider,
    enabled: provider.enabled && subscriptions.length > 0,
    subscriptions,
  };
  const unsubscribeBrowser = !providers.some((entry) =>
    entry.subscriptions?.some((saved) => saved.endpoint === endpoint));
  settings = {
    ...settings,
    notifications: {
      ...settings.notifications,
      providers: { ...settings.notifications.providers, webPush: providers },
    },
  };
  await saveSettings(settings);
  return { unsubscribeBrowser };
}

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function profileForClient(user) {
  const permissions = Number(user.permissions) || 0;
  return {
    id: String(user.id),
    name: user.username || user.jellyfinUsername || user.plexUsername || user.email || `User ${user.id}`,
    isAdmin: (permissions & ADMIN_PERMISSION) === ADMIN_PERMISSION,
  };
}

function sessionCookieId(request) {
  const prefix = `${SESSION_COOKIE}=`;
  const cookie = (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

function setSessionCookie(response, id) {
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function checkLoginRateLimit(request) {
  const key = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  if (recent.length >= 8) throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  recent.push(now);
  loginAttempts.set(key, recent);
}

async function getSeerrUser(cookie) {
  const service = settings.services.seerr;
  let response;
  try {
    response = await fetch(`${service.url}/api/v1/auth/me`, {
      headers: { Cookie: cookie, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new HttpError(502, 'Unable to validate your Seerr session. Check the Seerr connection.');
  }
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new HttpError(502, `Seerr could not validate the session (HTTP ${response.status}).`);
  try {
    const user = await response.json();
    return user.id == null ? null : user;
  } catch {
    throw new HttpError(502, 'Seerr returned an invalid sign-in response.');
  }
}

async function signInWithJellyfin(request, response) {
  checkLoginRateLimit(request);
  const body = await readJson(request);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password || username.length > 255 || password.length > 2048) {
    throw new HttpError(400, 'Enter your Jellyfin username and password.');
  }
  const seerr = settings.services.seerr;
  if (!seerr.url) throw new HttpError(503, 'Seerr has not been configured by an administrator.');

  let loginResponse;
  try {
    loginResponse = await fetch(`${seerr.url}/api/v1/auth/jellyfin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HttpError(502, 'Could not reach Seerr to sign in. Check that Seerr is online.');
  }
  if (!loginResponse.ok) {
    throw new HttpError(401, 'Seerr rejected this Jellyfin sign-in. Check the credentials and that Jellyfin login is enabled in Seerr.');
  }
  await loginResponse.arrayBuffer();

  const setCookies = typeof loginResponse.headers.getSetCookie === 'function'
    ? loginResponse.headers.getSetCookie()
    : [loginResponse.headers.get('set-cookie')].filter(Boolean);
  const seerrCookie = setCookies.map((value) => value.split(';', 1)[0].trim()).filter((value) => value.includes('=')).join('; ');
  if (!seerrCookie) throw new HttpError(502, 'Seerr authenticated the account but did not establish a session.');

  const user = await getSeerrUser(seerrCookie);
  if (!user) throw new HttpError(401, 'Seerr did not confirm the signed-in account.');
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { cookie: seerrCookie, user, expiresAt: Date.now() + SESSION_TTL_MS });
  loginAttempts.delete(request.socket.remoteAddress || 'unknown');
  setSessionCookie(response, id);
  return profileForClient(user);
}

async function resolveSession(request) {
  const id = sessionCookieId(request);
  const session = id && sessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  const user = await getSeerrUser(session.cookie);
  if (!user) {
    sessions.delete(id);
    return null;
  }
  session.user = user;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { id, user, profile: profileForClient(user) };
}

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'Send request data as application/json.');
  }
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error('Request body is too large.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

async function serviceJson(serviceName, apiPath) {
  const service = settings.services[serviceName];
  if (!service.url || !service.apiKey) {
    throw new Error(`Configure the ${serviceName[0].toUpperCase()}${serviceName.slice(1)} URL and API key in Settings.`);
  }
  let response;
  try {
    response = await fetch(`${service.url}${apiPath}`, {
      headers: { 'X-Api-Key': service.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(`Could not connect to ${serviceName}. Check its URL and that it is reachable from this machine.`);
  }
  if (!response.ok) {
    throw new Error(`${serviceName[0].toUpperCase()}${serviceName.slice(1)} returned HTTP ${response.status}. Check its URL and API key.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${serviceName[0].toUpperCase()}${serviceName.slice(1)} returned an invalid response.`);
  }
}

async function fetchRequests() {
  const all = [];
  const take = 100;
  for (let skip = 0; skip < 20000; skip += take) {
    const page = await serviceJson('seerr', `/api/v1/request?take=${take}&skip=${skip}&filter=all&sort=added&sortDirection=asc`);
    const results = Array.isArray(page) ? page : page.results;
    if (!Array.isArray(results)) throw new Error('Seerr returned requests in an unexpected format.');
    all.push(...results);
    const total = Number(page.pageInfo?.results);
    if (results.length < take || (Number.isFinite(total) && all.length >= total)) break;
    if (skip + take >= 20000) throw new Error('Seerr has more than 20,000 requests; the sync limit was reached.');
  }
  return all;
}

async function fetchUsers() {
  const all = [];
  const take = 100;
  for (let skip = 0; skip < 20000; skip += take) {
    const page = await serviceJson('seerr', `/api/v1/user?take=${take}&skip=${skip}&sort=displayname&sortDirection=asc`);
    const results = Array.isArray(page) ? page : page.results;
    if (!Array.isArray(results)) throw new Error('Seerr returned users in an unexpected format.');
    all.push(...results);
    const total = Number(page.pageInfo?.results);
    if (results.length < take || (Number.isFinite(total) && all.length >= total)) break;
    if (skip + take >= 20000) throw new Error('Seerr has more than 20,000 profiles; the sync limit was reached.');
  }
  return all;
}

function arrMediaKey(kind, media) {
  if (kind === 'movie') return `movie:${media.tmdbId ?? `radarr-${media.id}`}`;
  return `show:${media.tvdbId ?? `sonarr-${media.id}`}`;
}

async function getCurrentInventory() {
  const [users, requests, movies, series] = await Promise.all([
    fetchUsers(),
    fetchRequests(),
    serviceJson('radarr', '/api/v3/movie'),
    serviceJson('sonarr', '/api/v3/series'),
  ]);
  if (!Array.isArray(movies) || !Array.isArray(series)) {
    throw new Error('One of the services returned data in an unexpected format.');
  }
  const inventory = buildInventory({
    movies,
    series,
    requests,
    users,
    assignments: settings.assignments,
    reassignments: settings.reassignments,
    defaultCategory: settings.defaultCategory,
  });
  const profileNames = { ...(settings.profileNames || {}) };
  let namesChanged = false;
  inventory.profiles.filter((profile) => profile.id !== 'default').forEach((profile) => {
    if (typeof profile.name === 'string' && profileNames[profile.id] !== profile.name) {
      profileNames[profile.id] = profile.name;
      namesChanged = true;
    }
  });
  if (namesChanged) {
    const nextSettings = { ...settings, profileNames };
    await saveSettings(nextSettings);
    settings = nextSettings;
  }
  const arrRecords = new Map();
  movies.forEach((movie) => {
    if (movie.id != null) arrRecords.set(arrMediaKey('movie', movie), { serviceName: 'radarr', id: movie.id });
  });
  series.forEach((show) => {
    if (show.id != null) arrRecords.set(arrMediaKey('show', show), { serviceName: 'sonarr', id: show.id });
  });
  return { inventory, arrRecords };
}

async function getDashboard(includeDeleted = false) {
  const { inventory } = await getCurrentInventory();
  const deletedMedia = settings.deletedMedia || {};
  const deletedKeys = new Set(Object.keys(deletedMedia));
  const currentItems = new Map(inventory.items.map((item) => [item.key, item]));
  const deletedItems = Object.entries(deletedMedia).flatMap(([key, record]) => {
    const savedRecord = record && typeof record === 'object' ? record : { deletedAt: record };
    const item = currentItems.get(key) || savedRecord.item;
    if (!item || typeof item.title !== 'string') return [];
    return [{
      ...item,
      key,
      deletedAt: savedRecord.deletedAt || '',
      externalRemovalStatus: savedRecord.externalRemovalStatus || '',
      deleteFiles: savedRecord.deleteFiles === true,
    }];
  });
  inventory.items = inventory.items.filter((item) => !deletedKeys.has(item.key));
  inventory.requests = inventory.requests.filter((entry) => !deletedKeys.has(entry.itemKey));
  const profileOrder = new Map(settings.profileOrder.map((id, index) => [id, index]));
  const profiles = inventory.profiles.filter((profile) => profile.id !== 'default');
  profiles.sort((a, b) => {
    const aOrder = profileOrder.get(a.id);
    const bOrder = profileOrder.get(b.id);
    if (aOrder == null && bOrder == null) return 0;
    if (aOrder == null) return 1;
    if (bOrder == null) return -1;
    return aOrder - bOrder;
  });
  const defaultProfile = inventory.profiles.find((profile) => profile.id === 'default');
  const dashboard = {
    ...inventory,
    profiles: defaultProfile ? [...profiles, defaultProfile] : profiles,
    caps: settings.caps,
    pageSize: settings.pageSize,
  };
  if (includeDeleted) dashboard.deletedItems = deletedItems;
  return dashboard;
}

async function saveBulkDeletion(request) {
  const body = await readJson(request);
  if (body.confirmed !== true) {
    throw new Error('Confirm the deletion before continuing.');
  }
  if (typeof body.deleteFromArr !== 'boolean' || typeof body.deleteFiles !== 'boolean') {
    throw new Error('Choose whether to remove the selected media from Radarr/Sonarr and whether to delete its files.');
  }
  if (body.deleteFiles && !body.deleteFromArr) {
    throw new Error('Deleting files requires also removing the selected media from Radarr/Sonarr.');
  }
  if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 1000) {
    throw new Error('Confirm the deletion and select at least one media item (up to 1,000).');
  }
  const keys = new Set();
  for (const key of body.keys) {
    if (typeof key !== 'string' || !key || key.length > 200) {
      throw new Error('The selected media list contains an invalid key.');
    }
    keys.add(key);
  }
  const { inventory, arrRecords } = await getCurrentInventory();
  const availableItems = new Map(inventory.items
    .filter((item) => !settings.deletedMedia?.[item.key])
    .map((item) => [item.key, item]));
  for (const key of keys) {
    if (!availableItems.has(key)) {
      throw new HttpError(409, 'Some selected media is no longer in the active library. Refresh and try again.');
    }
    if (body.deleteFromArr && !arrRecords.has(key)) {
      throw new HttpError(409, 'Some selected media no longer has a matching Radarr/Sonarr record. Refresh and try again.');
    }
    if (body.deleteFromArr) {
      const { serviceName } = arrRecords.get(key);
      if (!settings.services[serviceName].url || !settings.services[serviceName].apiKey) {
        throw new HttpError(400, `Configure the ${serviceName[0].toUpperCase()}${serviceName.slice(1)} URL and API key in Settings.`);
      }
    }
  }

  const deletedAt = new Date().toISOString();
  const deletedMedia = { ...(settings.deletedMedia || {}) };
  keys.forEach((key) => {
    deletedMedia[key] = {
      deletedAt,
      item: availableItems.get(key),
      externalRemovalStatus: body.deleteFromArr ? 'pending' : '',
      deleteFiles: body.deleteFromArr && body.deleteFiles,
    };
  });
  const nextSettings = { ...settings, deletedMedia };
  await saveSettings(nextSettings);
  settings = nextSettings;

  let failed = [];
  if (body.deleteFromArr) {
    const outcomes = await Promise.all([...keys].map(async (key) => {
      const { serviceName, id } = arrRecords.get(key);
      try {
        await deleteArrMedia(serviceName, id, body.deleteFiles);
        return { key, status: 'removed' };
      } catch (error) {
        return { key, status: 'failed', message: error.message };
      }
    }));
    const completedDeletedMedia = { ...deletedMedia };
    failed = outcomes.filter((outcome) => outcome.status === 'failed').map(({ key, message }) => ({
      title: availableItems.get(key).title,
      message,
    }));
    outcomes.forEach(({ key, status }) => {
      if (status === 'removed') {
        delete completedDeletedMedia[key];
      } else {
        completedDeletedMedia[key] = { ...completedDeletedMedia[key], externalRemovalStatus: status };
      }
    });
    const completedSettings = { ...settings, deletedMedia: completedDeletedMedia };
    await saveSettings(completedSettings);
    settings = completedSettings;
  }
  return { deleted: keys.size, failed };
}

async function deleteArrMedia(serviceName, id, deleteFiles) {
  const service = settings.services[serviceName];
  if (!service.url || !service.apiKey) {
    throw new Error(`Configure the ${serviceName[0].toUpperCase()}${serviceName.slice(1)} URL and API key in Settings.`);
  }
  const resource = serviceName === 'radarr' ? 'movie' : 'series';
  const url = `${service.url}/api/v3/${resource}/${encodeURIComponent(id)}?deleteFiles=${deleteFiles}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'DELETE',
      headers: { 'X-Api-Key': service.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(`Could not connect to ${serviceName}. The service may or may not have processed the deletion.`);
  }
  if (!response.ok) {
    throw new Error(`${serviceName[0].toUpperCase()}${serviceName.slice(1)} returned HTTP ${response.status}.`);
  }
}

async function restoreMedia(request) {
  const body = await readJson(request);
  const key = String(body.key || '');
  if (!key || key.length > 200 || !settings.deletedMedia?.[key]) {
    throw new HttpError(404, 'That media item is not in deleted media.');
  }
  const deletedMedia = { ...settings.deletedMedia };
  delete deletedMedia[key];
  const nextSettings = { ...settings, deletedMedia };
  await saveSettings(nextSettings);
  settings = nextSettings;
}

async function saveClientSettings(request) {
  const body = await readJson(request);
  const services = {};
  for (const name of ['seerr', 'radarr', 'sonarr']) {
    const submitted = body.services?.[name] || {};
    services[name] = {
      url: validateUrl(String(submitted.url || '').trim(), name),
      apiKey: String(submitted.apiKey || '').trim() || settings.services[name].apiKey,
    };
  }
  const defaultCategory = String(body.defaultCategory || '').trim();
  if (!defaultCategory || defaultCategory.length > 60) {
    throw new Error('Default category must contain between 1 and 60 characters.');
  }
  const caps = {};
  for (const [profileId, value] of Object.entries(body.caps || {})) {
    if (profileId.length > 100) continue;
    const cap = Number(value);
    if (Number.isFinite(cap) && cap >= 0) caps[profileId] = cap;
  }
  const pageSize = [10, 25, 50, 100].includes(Number(body.pageSize)) ? Number(body.pageSize) : settings.pageSize;
  let notifications = settings.notifications;
  if (body.notifications && typeof body.notifications === 'object') {
    const submittedNotifications = body.notifications;
    const enabled = typeof submittedNotifications.enabled === 'boolean'
      ? submittedNotifications.enabled
      : settings.notifications.enabled;
    const thresholdPercent = Number(submittedNotifications.thresholdPercent);
    if (!Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 99) {
      throw new Error('Storage notification threshold must be a whole number between 1 and 99 percent.');
    }
    if (typeof submittedNotifications.notifyFull !== 'boolean') {
      throw new Error('Choose whether to notify when a profile reaches its full storage cap.');
    }
    const providers = {};
    for (const id of PROVIDER_IDS) {
      const currentInstances = settings.notifications.providers[id];
      const rawSubmitted = submittedNotifications.providers?.[id];
      const submittedInstances = Array.isArray(rawSubmitted)
        ? rawSubmitted
        : rawSubmitted && typeof rawSubmitted === 'object'
          ? [{ ...rawSubmitted, instanceId: rawSubmitted.instanceId || currentInstances[0]?.instanceId || crypto.randomUUID() }]
          : [];
      if (submittedInstances.length > 25) throw new Error(`Add no more than 25 ${id} notification services.`);
      const seenInstanceIds = new Set();
      providers[id] = submittedInstances.map((submittedProvider) => {
        if (!submittedProvider || typeof submittedProvider !== 'object' || Array.isArray(submittedProvider)) {
          throw new Error(`The ${id} notification settings are invalid.`);
        }
        const instanceId = String(submittedProvider.instanceId || '');
        if (seenInstanceIds.has(instanceId)) {
          throw new Error(`The ${id} notification services must have unique instance IDs.`);
        }
        seenInstanceIds.add(instanceId);
        const savedProvider = currentInstances.find((instance) => instance.instanceId === instanceId) || {};
        const provider = validateProviderConfig(id, submittedProvider, savedProvider);
        if (id === 'webPush') {
          provider.subscriptions = savedProvider.subscriptions || [];
          provider.enabled = provider.enabled && provider.subscriptions.length > 0;
        }
        return provider;
      });
    }
    notifications = {
      ...notifications,
      enabled,
      thresholdPercent,
      notifyFull: submittedNotifications.notifyFull,
      providers,
    };
  }
  settings = { ...settings, services, defaultCategory, caps, pageSize, notifications };
  await saveSettings(settings);
  return safeSettings();
}

async function sendTestNotification(request) {
  if (!settings.notifications.enabled) {
    throw new HttpError(409, 'Enable notifications in Settings before sending a test.');
  }
  const body = await readJson(request);
  const id = String(body.provider || '');
  const instanceId = String(body.instanceId || '');
  if (!PROVIDER_IDS.includes(id)) throw new Error('Choose a supported notification provider.');
  const provider = settings.notifications.providers[id].find((entry) => entry.instanceId === instanceId);
  if (!provider) throw new HttpError(404, `That ${id} notification service was not found.`);
  if (!isConfigured(id, provider)) throw new HttpError(400, `Complete the ${id} notification settings before testing.`);
  try {
    if (id === 'webPush') {
      setVapidDetails(settings.notifications.vapidPublicKey, settings.notifications.vapidPrivateKey);
    }
    const result = await sendProviderNotification(id, provider, {
      title: 'Quotarr notification test',
      message: 'Notifications are connected and ready to send storage-cap alerts.',
      event: 'test',
    });
    if (result?.expiredEndpoints?.length) {
      const expired = new Set(result.expiredEndpoints);
      const subscriptions = provider.subscriptions.filter((subscription) => !expired.has(subscription.endpoint));
      const providers = [...settings.notifications.providers.webPush];
      const providerIndex = providers.findIndex((entry) => entry.instanceId === instanceId);
      providers[providerIndex] = {
        ...provider,
        subscriptions,
        enabled: provider.enabled && subscriptions.length > 0,
      };
      settings = {
        ...settings,
        notifications: {
          ...settings.notifications,
          providers: {
            ...settings.notifications.providers,
            webPush: providers,
          },
        },
      };
      await saveSettings(settings);
    }
    if (result?.delivered === false) {
      throw new Error('No active browser subscription received the Web Push test.');
    }
  } catch (error) {
    throw new HttpError(502, error.message);
  }
}

let notificationCheckPromise;

async function checkStorageNotifications() {
  if (notificationCheckPromise) return notificationCheckPromise;
  notificationCheckPromise = (async () => {
    if (!settings.notifications.enabled) return;
    const hasEnabledProvider = PROVIDER_IDS.some((id) => {
      return settings.notifications.providers[id].some((provider) =>
        provider.enabled && isConfigured(id, provider));
    });
    if (!hasEnabledProvider) return;

    const { inventory } = await getCurrentInventory();
    const usageByProfile = new Map();
    inventory.items
      .filter((item) => !settings.deletedMedia?.[item.key])
      .forEach((item) => usageByProfile.set(
        item.profileId,
        (usageByProfile.get(item.profileId) || 0) + item.size,
      ));

    const thresholdPercent = settings.notifications.thresholdPercent;
    const alertState = { ...(settings.notifications.alertState || {}) };
    const notifications = [];
    inventory.profiles.filter((profile) => profile.id !== 'default').forEach((profile) => {
      const capGb = Number(settings.caps[profile.id]);
      if (!Number.isFinite(capGb) || capGb <= 0) {
        delete alertState[profile.id];
        return;
      }
      const usedBytes = usageByProfile.get(profile.id) || 0;
      const capBytes = capGb * 1024 ** 3;
      const percent = usedBytes / capBytes * 100;
      const previousState = Number(alertState[profile.id]) || 0;
      const nextState = settings.notifications.notifyFull && percent >= 100
        ? 2
        : percent >= thresholdPercent ? 1 : 0;
      if (nextState > previousState) {
        const full = nextState === 2;
        const usedGb = usedBytes / 1024 ** 3;
        notifications.push({
          profileId: profile.id,
          previousState,
          nextState,
          payload: {
            title: full
              ? `${profile.name} reached their storage cap`
              : `${profile.name} reached ${thresholdPercent}% of their storage cap`,
            message: `${profile.name} is using ${usedGb.toFixed(2)} GB of their ${capGb} GB cap (${Math.floor(percent)}%).`,
            event: full ? 'storage_full' : 'storage_threshold',
            profile: profile.name,
            profileId: profile.id,
            usedGb: Number(usedGb.toFixed(2)),
            capGb,
            percent: Number(percent.toFixed(2)),
          },
        });
      } else {
        alertState[profile.id] = nextState;
      }
    });

    for (const notification of notifications) {
      if (await deliverNotification(notification.payload)) {
        alertState[notification.profileId] = notification.nextState;
      } else {
        alertState[notification.profileId] = notification.previousState;
      }
    }
    settings = {
      ...settings,
      notifications: { ...settings.notifications, alertState },
    };
    await saveSettings(settings);
  })().finally(() => {
    notificationCheckPromise = null;
  });
  return notificationCheckPromise;
}

async function deliverNotification(notification) {
  if (!settings.notifications.enabled) return false;
  const providers = PROVIDER_IDS.flatMap((id) =>
    settings.notifications.providers[id]
      .filter((provider) => provider.enabled && isConfigured(id, provider))
      .map((provider) => ({ id, provider })));
  if (providers.some(({ id }) => id === 'webPush')) {
    setVapidDetails(settings.notifications.vapidPublicKey, settings.notifications.vapidPrivateKey);
  }
  const results = await Promise.allSettled(providers.map(({ id, provider }) =>
    sendProviderNotification(id, provider, notification)));
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      if (result.value?.expiredEndpoints?.length) {
        await removeExpiredWebPushSubscriptions(result.value.expiredEndpoints);
      }
      if (result.value?.failedCount) {
        console.error(`Web Push delivery failed for ${result.value.failedCount} browser subscription(s).`);
      }
      continue;
    }
    console.error(`${providers[index].id} notification delivery failed: ${result.reason?.message || 'Unknown error.'}`);
  }
  return results.some((result) =>
    result.status === 'fulfilled' && result.value?.delivered !== false);
}

async function removeExpiredWebPushSubscriptions(expiredEndpoints) {
  const expired = new Set(expiredEndpoints);
  const providers = settings.notifications.providers.webPush.map((provider) => {
    const subscriptions = provider.subscriptions.filter((subscription) => !expired.has(subscription.endpoint));
    return { ...provider, subscriptions, enabled: provider.enabled && subscriptions.length > 0 };
  });
  settings = {
    ...settings,
    notifications: {
      ...settings.notifications,
      providers: {
        ...settings.notifications.providers,
        webPush: providers,
      },
    },
  };
  await saveSettings(settings);
}

async function saveAssignments(keys, profileId) {
  const requests = await fetchRequests();
  const seerrProfiles = new Map();
  for (const request of requests) {
    const key = requestKey(request.type, request.media);
    if (key && !seerrProfiles.has(key)) {
      seerrProfiles.set(key, request.requestedBy?.id == null ? null : String(request.requestedBy.id));
    }
  }
  const assignments = { ...settings.assignments };
  const reassignments = { ...settings.reassignments };
  keys.forEach((key) => {
    assignments[key] = profileId;
    reassignments[key] = {
      seerrProfileId: reassignments[key]?.seerrProfileId ?? seerrProfiles.get(key) ?? null,
      adminProfileId: profileId,
    };
  });
  const nextSettings = { ...settings, assignments, reassignments };
  await saveSettings(nextSettings);
  settings = nextSettings;
}

async function saveAssignment(request) {
  const body = await readJson(request);
  const key = String(body.key || '');
  const profileId = String(body.profileId || '');
  if (!key || key.length > 200 || !profileId || profileId.length > 100) {
    throw new Error('A media item and profile are required.');
  }
  await saveAssignments([key], profileId);
}

async function saveBulkAssignment(request) {
  const body = await readJson(request);
  const profileId = String(body.profileId || '');
  if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 1000
    || !profileId || profileId.length > 100) {
    throw new Error('Choose a destination profile and at least one media item (up to 1,000).');
  }
  const keys = new Set();
  for (const key of body.keys) {
    if (typeof key !== 'string' || !key || key.length > 200) {
      throw new Error('The selected media list contains an invalid key.');
    }
    keys.add(key);
  }
  await saveAssignments(keys, profileId);
  return keys.size;
}

async function saveProfileOrder(request) {
  const body = await readJson(request);
  if (!Array.isArray(body.order) || body.order.length > 20000) {
    throw new Error('Profile order must be a list of at most 20,000 profile IDs.');
  }
  const seen = new Set();
  const profileOrder = [];
  for (const rawId of body.order) {
    const id = String(rawId);
    if (!id || id.length > 100 || id === 'default') {
      throw new Error('Profile order contains an invalid profile ID.');
    }
    if (!seen.has(id)) {
      seen.add(id);
      profileOrder.push(id);
    }
  }
  settings = { ...settings, profileOrder };
  await saveSettings(settings);
  return profileOrder;
}

async function serveStatic(request, response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  try {
    const body = await fs.readFile(filePath);
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
    }[path.extname(filePath)] || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self' https://image.tmdb.org; img-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

function requireSession(session) {
  if (!session) throw new HttpError(401, 'Sign in with your Jellyfin account to continue.');
  return session;
}

function requireAdmin(session) {
  if (!session.profile.isAdmin) throw new HttpError(403, 'Only Seerr administrators can change settings or manage media.');
}

function gitBlobHash(file, content) {
  const hashContent = file.endsWith('.png')
    ? content
    : Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'));
  return crypto.createHash('sha1')
    .update(`blob ${hashContent.length}\0`)
    .update(hashContent)
    .digest('hex');
}

async function getUpdateInfo() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Quotarr',
  };
  const fetchGitHubJson = async (url) => {
    let response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    } catch {
      throw new HttpError(502, 'Could not reach GitHub to check for updates. Try again later.');
    }
    if (!response.ok) {
      throw new HttpError(502, `GitHub update check failed (HTTP ${response.status}).`);
    }
    try {
      return await response.json();
    } catch {
      throw new HttpError(502, 'GitHub returned an invalid update response.');
    }
  };

  const commits = await fetchGitHubJson(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/commits?per_page=1`,
  );
  const latest = Array.isArray(commits) ? commits[0] : null;
  const sha = typeof latest?.sha === 'string' && /^[a-f0-9]{40}$/i.test(latest.sha)
    ? latest.sha
    : null;
  const message = typeof latest?.commit?.message === 'string'
    ? latest.commit.message.split(/\r?\n/, 1)[0].trim().slice(0, 200)
    : '';
  const date = latest?.commit?.committer?.date || latest?.commit?.author?.date || '';
  if (!sha || !message || !date || Number.isNaN(Date.parse(date))) {
    throw new HttpError(502, 'GitHub did not return valid latest commit information.');
  }

  const remoteTree = await fetchGitHubJson(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/git/trees/${sha}?recursive=1`,
  );
  if (!Array.isArray(remoteTree.tree) || remoteTree.truncated) {
    throw new HttpError(502, 'GitHub returned an incomplete source tree for the update check.');
  }

  const trackedFiles = new Set(UPDATE_TRACKED_FILES);
  const remoteHashes = new Map(remoteTree.tree
    .filter((entry) => entry.type === 'blob'
      && typeof entry.path === 'string'
      && (trackedFiles.has(entry.path) || entry.path.startsWith('public/')))
    .map((entry) => [entry.path, entry.sha]));
  const packageResponse = await fetchGitHubJson(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/package.json?ref=${sha}`,
  );
  if (packageResponse.encoding !== 'base64' || typeof packageResponse.content !== 'string') {
    throw new HttpError(502, 'GitHub did not return valid package version information.');
  }
  let latestVersion;
  try {
    latestVersion = JSON.parse(Buffer.from(packageResponse.content, 'base64').toString('utf8')).version;
  } catch {
    throw new HttpError(502, 'GitHub returned invalid package version information.');
  }
  if (typeof latestVersion !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(latestVersion)) {
    throw new HttpError(502, 'GitHub returned an invalid package version.');
  }

  const publicFiles = [];
  const collectPublicFiles = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await collectPublicFiles(fullPath);
      else if (entry.isFile()) {
        publicFiles.push(path.relative(ROOT, fullPath).split(path.sep).join('/'));
      }
    }
  };
  await collectPublicFiles(PUBLIC_DIR);
  const currentPaths = [...UPDATE_TRACKED_FILES, ...publicFiles].sort();
  const currentHashes = new Map();
  for (const file of currentPaths) {
    let content;
    try {
      content = await fs.readFile(path.join(ROOT, ...file.split('/')));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new HttpError(500, `Installed app file "${file}" is missing; reinstall or rebuild Quotarr.`);
      }
      throw error;
    }
    currentHashes.set(file, gitBlobHash(file, content));
  }
  const isUpToDate = currentHashes.size === remoteHashes.size
    && [...currentHashes].every(([file, hash]) => remoteHashes.get(file) === hash);

  const deploymentType = process.env.QUOTARR_DEPLOYMENT === 'docker' ? 'docker' : 'npm';
  return {
    currentVersion: APP_VERSION,
    latestVersion,
    isUpToDate,
    deploymentType,
    updateCommand: deploymentType === 'docker'
      ? 'git pull && docker compose up -d --build'
      : 'git pull && npm install && npm start',
    commit: {
      sha,
      message,
      date,
      url: `https://github.com/${GITHUB_REPOSITORY}/commit/${sha}`,
    },
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const host = new URL(`http://${request.headers.host || ''}`).hostname;
      if (!ALLOWED_HOSTS.has(host)) {
        return jsonResponse(response, 403, { error: 'This host is not allowed. Configure ALLOWED_HOSTS to match the dashboard address.' });
      }
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`) {
        return jsonResponse(response, 403, { error: 'Cross-origin API requests are not allowed.' });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/session') {
      const session = await resolveSession(request);
      if (!session) clearSessionCookie(response);
      return jsonResponse(response, 200, { authenticated: Boolean(session), user: session?.profile || null });
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      const user = await signInWithJellyfin(request, response);
      return jsonResponse(response, 200, { authenticated: true, user });
    }
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      const id = sessionCookieId(request);
      if (id) sessions.delete(id);
      clearSessionCookie(response);
      return jsonResponse(response, 200, { ok: true });
    }
    const session = url.pathname.startsWith('/api/') ? requireSession(await resolveSession(request)) : null;
    if (request.method === 'GET' && url.pathname === '/api/update') {
      requireAdmin(session);
      return jsonResponse(response, 200, await getUpdateInfo());
    }
    if (request.method === 'GET' && url.pathname === '/api/settings') {
      requireAdmin(session);
      return jsonResponse(response, 200, safeSettings());
    }
    if (request.method === 'POST' && url.pathname === '/api/settings') {
      requireAdmin(session);
      return jsonResponse(response, 200, await saveClientSettings(request));
    }
    if (request.method === 'POST' && url.pathname === '/api/notifications/test') {
      requireAdmin(session);
      await sendTestNotification(request);
      return jsonResponse(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/notifications/subscription') {
      requireAdmin(session);
      return jsonResponse(response, 200, { provider: await saveWebPushSubscription(request) });
    }
    if (request.method === 'DELETE' && url.pathname === '/api/notifications/subscription') {
      requireAdmin(session);
      await removeWebPushSubscription(request);
      return jsonResponse(response, 200, { ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/dashboard') {
      return jsonResponse(response, 200, await getDashboard(Boolean(session.profile.isAdmin)));
    }
    if (request.method === 'POST' && url.pathname === '/api/assign') {
      requireAdmin(session);
      await saveAssignment(request);
      return jsonResponse(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/assign-bulk') {
      requireAdmin(session);
      const assigned = await saveBulkAssignment(request);
      return jsonResponse(response, 200, { assigned });
    }
    if (request.method === 'POST' && url.pathname === '/api/delete-bulk') {
      requireAdmin(session);
      return jsonResponse(response, 200, await saveBulkDeletion(request));
    }
    if (request.method === 'POST' && url.pathname === '/api/restore-media') {
      requireAdmin(session);
      await restoreMedia(request);
      return jsonResponse(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/profile-order') {
      requireAdmin(session);
      const profileOrder = await saveProfileOrder(request);
      return jsonResponse(response, 200, { profileOrder });
    }
    if (url.pathname.startsWith('/api/')) return jsonResponse(response, 404, { error: 'Not found.' });
    if (request.method !== 'GET') return jsonResponse(response, 405, { error: 'Method not allowed.' });
    return await serveStatic(request, response, url.pathname);
  } catch (error) {
    const status = error.status || (error.message.includes('too large') ? 413 : 400);
    return jsonResponse(response, status, { error: error.message || 'The request could not be completed.' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}, 60 * 60 * 1000).unref();

if (require.main === module) {
  loadSettings()
    .then(() => {
      server.listen(PORT, HOST, () => {
        console.log(`Quotarr listening at http://${HOST}:${PORT}`);
      });
      void checkStorageNotifications().catch((error) => {
        console.error(`Could not check storage notification thresholds: ${error.message}`);
      });
      setInterval(() => {
        void checkStorageNotifications().catch((error) => {
          console.error(`Could not check storage notification thresholds: ${error.message}`);
        });
      }, 5 * 60 * 1000).unref();
    })
    .catch((error) => {
      console.error(`Could not load local settings: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { checkStorageNotifications, loadSettings, server };
