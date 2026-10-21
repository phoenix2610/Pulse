 
export const z = {
  webhook: {
    url: { type: 'url', required: true, max: 2000 },
    secret: { type: 'string', max: 200 },
    method: { type: 'string', enum: ['POST', 'PUT'], default: 'POST' },
  },
  slack: { webhookUrl: { type: 'url', required: true, max: 2000 } },
  discord: { webhookUrl: { type: 'url', required: true, max: 2000 }, mention: { type: 'string', max: 100 } },
  telegram: { botToken: { type: 'string', required: true, max: 200 }, chatId: { type: 'string', required: true, max: 100 } },
  ntfy: {
    server: { type: 'url', default: 'https://ntfy.sh' },
    topic: { type: 'string', required: true, pattern: /^[A-Za-z0-9_-]{1,64}$/, message: 'letters, digits, _ and - only' },
    token: { type: 'string', max: 200 },
  },
  email: {
    host: { type: 'string', required: true, max: 255 },
    port: { type: 'int', min: 1, max: 65535, default: 587 },
    secure: { type: 'bool', default: false },
    user: { type: 'string', max: 255 },
    password: { type: 'string', max: 500 },
    from: { type: 'email', required: true },
    to: { type: 'array', required: true, min: 1, max: 20, items: { type: 'email' } },
  },
};
