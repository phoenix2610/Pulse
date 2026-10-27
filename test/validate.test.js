import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../server/validate.js';
import { HttpError, parseDuration, formatDuration, percentile, hashPassword, verifyPassword, Semaphore } from '../server/util.js';

test('validate: coerces, defaults, trims', () => {
  const out = validate({ n: { type: 'int', min: 1, max: 10, default: 5 }, s: { type: 'string', required: true }, b: { type: 'bool', default: false } }, { s: '  hi ', n: '7', b: 'true' });
  assert.deepEqual(out, { n: 7, s: 'hi', b: true });
  assert.equal(validate({ n: { type: 'int', default: 5 } }, {}).n, 5);
});

test('validate: collects every error with field paths', () => {
  try {
    validate({ a: { type: 'string', required: true }, b: { type: 'int', max: 3 }, c: { type: 'email' }, d: { type: 'url' } }, { b: 9, c: 'nope', d: 'ftp://x' });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 422);
    assert.deepEqual(Object.keys(e.details).sort(), ['a', 'b', 'c', 'd']);
  }
});

test('validate: nested arrays and objects report indexed paths', () => {
  const schema = { list: { type: 'array', items: { type: 'int', min: 1 } }, o: { type: 'object', props: { x: { type: 'int', required: true } } } };
  assert.throws(() => validate(schema, { list: [1, 0], o: {} }), (e) => Boolean(e.details['list[1]'] && e.details['o.x']));
});

test('validate: partial skips missing fields and defaults', () => {
  assert.deepEqual(validate({ a: { type: 'int', default: 1 }, b: { type: 'int', required: true } }, { a: 3 }, { partial: true }), { a: 3 });
});

test('validate: rejects non-integer for int and wrong enum', () => {
  assert.throws(() => validate({ n: { type: 'int' } }, { n: 1.5 }));
  assert.throws(() => validate({ e: { type: 'string', enum: ['a', 'b'] } }, { e: 'c' }));
});

test('parseDuration / formatDuration', () => {
  assert.equal(parseDuration('5m'), 300000);
  assert.equal(parseDuration('1.5h'), 5400000);
  assert.equal(parseDuration(250), 250);
  assert.ok(Number.isNaN(parseDuration('soon')));
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(3_780_000), '1h 3m');
  assert.equal(formatDuration(90_061_000), '1d 1h');
});

test('percentile interpolates', () => {
  const s = [10, 20, 30, 40, 50];
  assert.equal(percentile(s, 0.5), 30);
  assert.equal(percentile(s, 0.95), 48);
  assert.equal(percentile([], 0.5), null);
});

test('password hashing verifies and salts', () => {
  const h1 = hashPassword('hunter2hunter2'), h2 = hashPassword('hunter2hunter2');
  assert.notEqual(h1, h2);
  assert.ok(verifyPassword('hunter2hunter2', h1));
  assert.ok(!verifyPassword('wrong-password', h1));
});

test('Semaphore bounds concurrency', async () => {
  const sem = new Semaphore(2);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => sem.run(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
  })));
  assert.equal(peak, 2);
});
