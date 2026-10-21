import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';
import { DeliveryError } from './webhook.js';





class SmtpConn {
  constructor(socket) { this.socket = socket; this.buf = ''; this.waiters = []; this.attach(socket); }
  attach(socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (d) => { this.buf += d; this.flush(); });
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(new Error('Connection closed')));
  }
  fail(e) { this.waiters.splice(0).forEach((w) => w.reject(e)); this.err = e; }
  flush() {
     
    const lines = this.buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const reply = lines.slice(0, i + 1);
        this.buf = lines.slice(i + 1).join('\r\n');
        this.waiters.shift()?.resolve({ code: Number(reply[0].slice(0, 3)), lines: reply });
        return this.flush();
      }
    }
  }
  read() {
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this.flush(); });
  }
  async cmd(line, expect) {
    this.socket.write(line + '\r\n');
    const r = await this.read();
    if (expect && !expect.includes(r.code)) throw new DeliveryError(`SMTP ${r.code}: ${r.lines.join(' ').slice(0, 200)}`, r.code >= 500);
    return r;
  }
}

const b64 = (s) => Buffer.from(s).toString('base64');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function buildMessage({ from, to, subject, text, html }) {
  const boundary = `pulse_${crypto.randomBytes(8).toString('hex')}`;
  const dotStuff = (s) => s.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return [
    `From: Pulse <${from}>`, `To: ${to.join(', ')}`, `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@pulse>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(text).replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(html).replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`, '',
  ].map(dotStuff).join('\r\n');
}

export async function sendEmail(cfg, ev) {
  const port = cfg.port || 587;
  const timeout = 15000;
  const connect = () => new Promise((resolve, reject) => {
    const s = (cfg.secure ? tls : net).connect({ host: cfg.host, port, servername: cfg.host }, () => resolve(s));
    s.setTimeout(timeout, () => s.destroy(new Error('SMTP timeout')));
    s.once('error', reject);
  });
  const socket = await connect();
  const conn = new SmtpConn(socket);
  try {
    let r = await conn.read();
    if (r.code !== 220) throw new DeliveryError(`SMTP greeting ${r.code}`);
    r = await conn.cmd(`EHLO ${os.hostname() || 'pulse'}`, [250]);
    if (!cfg.secure && r.lines.some((l) => /STARTTLS/i.test(l))) {
      await conn.cmd('STARTTLS', [220]);
      socket.removeAllListeners('data'); socket.removeAllListeners('close'); socket.removeAllListeners('error');
      const secured = tls.connect({ socket, servername: cfg.host });
      await new Promise((res, rej) => { secured.once('secureConnect', res); secured.once('error', rej); });
      conn.buf = ''; conn.err = null; conn.attach(secured);
      r = await conn.cmd(`EHLO ${os.hostname() || 'pulse'}`, [250]);
    }
    if (cfg.user) {
      const mechs = r.lines.join(' ').toUpperCase();
      if (mechs.includes('PLAIN')) await conn.cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.password ?? ''}`)}`, [235]);
      else {
        await conn.cmd('AUTH LOGIN', [334]);
        await conn.cmd(b64(cfg.user), [334]);
        await conn.cmd(b64(cfg.password ?? ''), [235]);
      }
    }
    await conn.cmd(`MAIL FROM:<${cfg.from}>`, [250]);
    for (const rcpt of cfg.to) await conn.cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    await conn.cmd('DATA', [354]);
    const html = `<div style="font-family:system-ui,sans-serif;max-width:520px"><h2 style="margin:0 0 8px">${ev.icon} ${escapeHtml(ev.title)}</h2>
      <p style="color:#444">${escapeHtml(ev.text ?? '')}</p>${ev.target ? `<p><code>${escapeHtml(ev.target)}</code></p>` : ''}
      ${ev.url ? `<p><a href="${escapeHtml(ev.url)}">Open in Pulse</a></p>` : ''}<p style="color:#999;font-size:12px">${ev.timestamp}</p></div>`;
    const text = `${ev.icon} ${ev.title}\n\n${ev.text ?? ''}\n${ev.target ? `\n${ev.target}\n` : ''}${ev.url ? `\n${ev.url}\n` : ''}`;
    const msg = buildMessage({ from: cfg.from, to: cfg.to, subject: `${ev.icon} ${ev.title}`, text, html });
    await conn.cmd(`${msg}\r\n.`, [250]);
    await conn.cmd('QUIT').catch(() => {});
  } finally {
    socket.destroy();
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
