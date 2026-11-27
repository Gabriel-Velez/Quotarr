const nodemailer = require('nodemailer');
const webpush = require('web-push');
const { generateVAPIDKeys } = webpush;

const PROVIDER_IDS = [
  'email',
  'webPush',
  'discord',
  'gotify',
  'ntfy',
  'pushbullet',
  'pushover',
  'slack',
  'telegram',
  'webhook',
];

const DEFAULT_PROVIDERS = Object.fromEntries(PROVIDER_IDS.map((id) => [id, []]));

const SECRET_FIELDS = {
  email: ['username', 'password'],
  webPush: [],
  discord: ['webhookUrl'],
  gotify: ['token'],
  ntfy: ['token'],
  pushbullet: ['accessToken'],
  pushover: ['userKey', 'apiToken'],
  slack: ['webhookUrl'],
  telegram: ['botToken'],
  webhook: ['url', 'secret'],
};

function isConfigured(id, config) {
  if (!config) return false;
  switch (id) {
    case 'email':
      return Boolean(config.host && config.from && config.to);
    case 'webPush':
      return Array.isArray(config.subscriptions) && config.subscriptions.length > 0;
    case 'discord':
    case 'slack':
      return Boolean(config.webhookUrl);
    case 'gotify':
      return Boolean(config.url && config.token);
    case 'ntfy':
      return Boolean(config.url && config.topic);
    case 'pushbullet':
      return Boolean(config.accessToken);
    case 'pushover':
      return Boolean(config.userKey && config.apiToken);
    case 'telegram':
      return Boolean(config.botToken && config.chatId);
    case 'webhook':
      return Boolean(config.url);
    default:
      return false;
  }
}

function setVapidDetails(publicKey, privateKey) {
  webpush.setVapidDetails('mailto:quotarr@localhost', publicKey, privateKey);
}

async function postJson(id, url, body, headers = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error(`${id} notification delivery failed because the server could not be reached.`);
  }
  if (!response.ok) throw new Error(`${id} notification delivery failed (HTTP ${response.status}).`);
  return response;
}

async function sendEmail(config, notification) {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: Number(config.port) || 587,
    secure: config.secure === true,
    ...(config.username ? { auth: { user: config.username, pass: config.password || '' } } : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
  try {
    await transport.sendMail({
      from: config.from,
      to: config.to,
      subject: notification.title,
      text: notification.message,
    });
  } catch {
    throw new Error('Email notification delivery failed. Check the SMTP settings and credentials.');
  } finally {
    transport.close();
  }
}

async function sendWebPush(config, notification) {
  const subscriptions = config.subscriptions || [];
  if (!subscriptions.length) throw new Error('Enable Web Push on a browser before sending a test notification.');
  const results = await Promise.allSettled(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: notification.title,
        body: notification.message,
      }), { TTL: 60 });
      return null;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) return subscription.endpoint;
      throw new Error(`Web Push delivery failed (HTTP ${error.statusCode || 'unknown'}).`);
    }
  }));
  const expiredEndpoints = results
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => result.value);
  const delivered = results.some((result) => result.status === 'fulfilled' && result.value === null);
  const failures = results.filter((result) => result.status === 'rejected');
  if (!delivered && failures.length) throw failures[0].reason;
  return { expiredEndpoints, delivered, failedCount: failures.length };
}

async function sendProviderNotification(id, config, notification) {
  switch (id) {
    case 'email':
      return sendEmail(config, notification);
    case 'webPush':
      return sendWebPush(config, notification);
    case 'discord':
      return postJson('Discord', config.webhookUrl, { content: `**${notification.title}**\n${notification.message}` });
    case 'gotify':
      return postJson('Gotify', `${config.url.replace(/\/+$/, '')}/message?token=${encodeURIComponent(config.token)}`, {
        title: notification.title,
        message: notification.message,
        priority: 5,
      });
    case 'ntfy':
      return postJson('ntfy.sh', `${config.url.replace(/\/+$/, '')}/`, {
        topic: config.topic,
        title: notification.title,
        message: notification.message,
        priority: 4,
      }, config.token ? { Authorization: `Bearer ${config.token}` } : {});
    case 'pushbullet':
      return postJson('Pushbullet', 'https://api.pushbullet.com/v2/pushes', {
        type: 'note',
        title: notification.title,
        body: notification.message,
      }, { Authorization: `Bearer ${config.accessToken}` });
    case 'pushover': {
      const body = new URLSearchParams({
        token: config.apiToken,
        user: config.userKey,
        title: notification.title,
        message: notification.message,
      });
      let response;
      try {
        response = await fetch('https://api.pushover.net/1/messages.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        throw new Error('Pushover notification delivery failed because the server could not be reached.');
      }
      let result;
      try {
        result = await response.json();
      } catch {
        if (!response.ok) {
          throw new Error(`Pushover notification delivery failed (HTTP ${response.status}).`);
        }
        throw new Error('Pushover returned an invalid response.');
      }
      const details = Array.isArray(result.errors)
        ? result.errors.filter((error) => typeof error === 'string').join(' ')
        : '';
      if (!response.ok) {
        throw new Error(`Pushover notification delivery failed (HTTP ${response.status})${details ? `: ${details}` : '.'}`);
      }
      if (result.status !== 1) {
        throw new Error(details
          ? `Pushover rejected the notification: ${details}`
          : 'Pushover rejected the notification. Check the user key and API token.');
      }
      return response;
    }
    case 'slack':
      return postJson('Slack', config.webhookUrl, { text: `*${notification.title}*\n${notification.message}` });
    case 'telegram':
      return postJson('Telegram', `https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        chat_id: config.chatId,
        text: `${notification.title}\n${notification.message}`,
      });
    case 'webhook':
      return postJson('Webhook', config.url, notification, config.secret ? { Authorization: `Bearer ${config.secret}` } : {});
    default:
      throw new Error('Unknown notification provider.');
  }
}

module.exports = {
  DEFAULT_PROVIDERS,
  generateVAPIDKeys,
  PROVIDER_IDS,
  SECRET_FIELDS,
  isConfigured,
  sendProviderNotification,
  setVapidDetails,
};
