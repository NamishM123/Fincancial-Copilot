process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { toCents, fromCents, formatCents } = require('../lib/money');

test('toCents converts plain numbers and numeric strings', () => {
    assert.strictEqual(toCents(4.5), 450);
    assert.strictEqual(toCents('4.50'), 450);
    assert.strictEqual(toCents(0.1), 10);
    assert.strictEqual(toCents('1000'), 100000);
});

test('toCents rounds rather than truncating', () => {
    // 19.99 * 100 is 1998.9999999999998 in binary floating point, so a
    // truncating conversion would lose a cent on a very common price.
    assert.strictEqual(toCents(19.99), 1999);
    assert.strictEqual(toCents(0.07), 7);
    assert.strictEqual(toCents(1.005), 101);
});

test('toCents strips currency symbols and thousands separators', () => {
    assert.strictEqual(toCents('$1,250.50'), 125050);
    assert.strictEqual(toCents('£99.00'), 9900);
    assert.strictEqual(toCents('  42.00  '), 4200);
});

test('toCents preserves sign, including accounting-style parentheses', () => {
    assert.strictEqual(toCents('-45.00'), -4500);
    assert.strictEqual(toCents('(45.00)'), -4500);
    assert.strictEqual(toCents('($1,200.00)'), -120000);
    assert.strictEqual(toCents('+45.00'), 4500);
});

test('toCents returns null for unparseable input rather than NaN or zero', () => {
    // Distinguishing null from 0 matters: a zero-amount row is a data problem,
    // an unparseable one is a format problem, and they get different messages.
    assert.strictEqual(toCents('abc'), null);
    assert.strictEqual(toCents(''), null);
    assert.strictEqual(toCents('   '), null);
    assert.strictEqual(toCents(null), null);
    assert.strictEqual(toCents(undefined), null);
    assert.strictEqual(toCents('12.34.56'), null);
    assert.strictEqual(toCents('1e5'), null);
});

test('toCents accepts a legitimate zero', () => {
    assert.strictEqual(toCents('0'), 0);
    assert.strictEqual(toCents('0.00'), 0);
});

test('fromCents and formatCents render values for display', () => {
    assert.strictEqual(fromCents(1999), 19.99);
    assert.strictEqual(fromCents(100), 1);
    assert.strictEqual(formatCents(1999), '$19.99');
    assert.strictEqual(formatCents(-4500), '-$45.00');
    assert.strictEqual(formatCents(0), '$0.00');
});

test('cents round-trip through display formatting without drift', () => {
    for (const cents of [1, 7, 99, 100, 1999, 123456]) {
        assert.strictEqual(toCents(String(fromCents(cents))), cents);
    }
});
