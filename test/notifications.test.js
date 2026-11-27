const assert = require('node:assert/strict');
const test = require('node:test');
const nodemailer = require('nodemailer');
const { isConfigured, sendProviderNotification } = require('../notifications');

const notification = {
  title: 'Quotarr alert',
  message: 'A profile reached its storage threshold.',
  event: 'storage_threshold',
};

test('HTTP notification providers send their expected payloads', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), ...options });
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  };
  try {
    await sendProviderNotification('discord', { webhookUrl: 'https://discord.test/hook' }, notification);
    await sendProviderNotification('gotify', { url: 'https://gotify.test', token: 'gotify-token' }, notification);
    await sendProviderNotification('ntfy', { url: 'https://ntfy.test', topic: 'alerts' }, notification);
    await sendProviderNotification('pushbullet', { accessToken: 'pushbullet-token' }, notification);
    await sendProviderNotification('pushover', { apiToken: 'pushover-token', userKey: 'pushover-user' }, notification);
    await sendProviderNotification('slack', { webhookUrl: 'https://slack.test/hook' }, notification);
    await sendProviderNotification('telegram', { botToken: 'telegram-token', chatId: '123' }, notification);
    await sendProviderNotification('webhook', { url: 'https://webhook.test/alerts', secret: 'hook-secret' }, notification);

    assert.deepEqual(JSON.parse(calls[0].body), { content: '**Quotarr alert**\nA profile reached its storage threshold.' });
    assert.equal(calls[1].url, 'https://gotify.test/message?token=gotify-token');
    assert.equal(calls[2].url, 'https://ntfy.test/');
    assert.equal(JSON.parse(calls[2].body).topic, 'alerts');
    assert.equal(calls[3].headers.Authorization, 'Bearer pushbullet-token');
    assert.equal(new URLSearchParams(calls[4].body).get('user'), 'pushover-user');
    const pushoverPayload = new URLSearchParams(calls[4].body);
    assert.equal(calls[4].url, 'https://api.pushover.net/1/messages.json');
    assert.equal(calls[4].headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(pushoverPayload.get('token'), 'pushover-token');
    assert.equal(pushoverPayload.get('title'), notification.title);
    assert.equal(pushoverPayload.get('message'), notification.message);
    assert.deepEqual(JSON.parse(calls[5].body), { text: '*Quotarr alert*\nA profile reached its storage threshold.' });
    assert.equal(JSON.parse(calls[6].body).chat_id, '123');
    assert.equal(calls[7].headers.Authorization, 'Bearer hook-secret');
    assert.equal(JSON.parse(calls[7].body).event, 'storage_threshold');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Pushover API rejection details are surfaced to the caller', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    status: 0,
    errors: ['application token is invalid'],
  }), { status: 200 });
  try {
    await assert.rejects(
      sendProviderNotification('pushover', { apiToken: 'invalid', userKey: 'user' }, notification),
      /application token is invalid/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('email uses SMTP settings and Web Push requires a browser subscription', async () => {
  const originalCreateTransport = nodemailer.createTransport;
  let sentMessage;
  nodemailer.createTransport = (options) => ({
    sendMail: async (message) => {
      sentMessage = { options, message };
    },
    close() {},
  });
  try {
    await sendProviderNotification('email', {
      host: 'smtp.test',
      port: 465,
      secure: true,
      from: 'quotarr@example.test',
      to: 'admin@example.test',
    }, notification);
    assert.equal(sentMessage.options.host, 'smtp.test');
    assert.equal(sentMessage.message.to, 'admin@example.test');
    await assert.rejects(
      sendProviderNotification('webPush', { subscriptions: [] }, notification),
      /Enable Web Push on a browser/,
    );
    assert.equal(isConfigured('email', { host: 'smtp.test', from: 'a@test', to: 'b@test' }), true);
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }
});
