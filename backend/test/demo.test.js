process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const app = require('../app');
const db = require('../db');
const { generateTransactions } = require('../lib/seed');
const analytics = require('../lib/analytics');

test.before(async () => {
    await db.init();
});

test.after(async () => {
    await db.close();
});

test('seed generation is deterministic', () => {
    const endDate = new Date('2026-07-28T00:00:00Z');
    const a = generateTransactions({ months: 12, endDate });
    const b = generateTransactions({ months: 12, endDate });

    // Math.random would make the demo different on every provision, which
    // makes it impossible to reason about what a reviewer is looking at.
    assert.deepStrictEqual(a, b);
});

test('seed data spans the requested window and has no duplicates', () => {
    const rows = generateTransactions({ months: 12, endDate: new Date('2026-07-28T00:00:00Z') });

    assert.ok(rows.length > 300, `expected a year of activity, got ${rows.length} rows`);

    const months = new Set(rows.map((r) => r.date.slice(0, 7)));
    assert.strictEqual(months.size, 12);

    // The unique (user_id, dedupe_hash) index would reject these on insert.
    const hashes = new Set(rows.map((r) => r.dedupeHash));
    assert.strictEqual(hashes.size, rows.length);

    // Dates must be sorted and in the past relative to the end date.
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    assert.deepStrictEqual(rows.map((r) => r.date), sorted.map((r) => r.date));
    assert.ok(rows[rows.length - 1].date <= '2026-07-28');
});

test('seed data exercises the analytics the demo is meant to show off', () => {
    const rows = generateTransactions({ months: 12, endDate: new Date('2026-07-28T00:00:00Z') })
        .map((r, i) => ({ id: i, date: r.date, description: r.description, amount_cents: r.amountCents, type: r.type, category: r.category }));

    const recurring = analytics.detectRecurring(rows);
    assert.ok(recurring.length >= 4, `expected several subscriptions, found ${recurring.length}`);

    // The Netflix price rise is deliberate: it gives the detector something
    // worth surfacing rather than a flat list.
    const netflix = recurring.find((r) => r.merchant.includes('NETFLIX'));
    assert.ok(netflix, 'expected NETFLIX in the recurring set');
    assert.ok(netflix.amountChanged, 'expected the seeded price rise to be detected');

    const summary = analytics.summarize(rows);
    assert.ok(summary.incomeCents > summary.expenseCents, 'demo account should be solvent');
    assert.ok(summary.savingsRate > 0.1 && summary.savingsRate < 0.5,
        `savings rate ${summary.savingsRate} should look plausible, not synthetic`);

    assert.strictEqual(analytics.monthlySeries(rows).length, 12);
});

test('POST /api/demo provisions a usable seeded account', async () => {
    const res = await request(app).post('/api/demo');

    assert.strictEqual(res.status, 201);
    assert.ok(res.body.token);
    assert.strictEqual(res.body.user.is_demo, 1);
    assert.ok(res.body.seeded > 300);

    const headers = { Authorization: `Bearer ${res.body.token}` };

    const list = await request(app).get('/api/transactions').set(headers);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.pagination.total, res.body.seeded);

    const summary = await request(app).get('/api/transactions/summary').set(headers);
    assert.ok(summary.body.summary.balanceCents > 0);
    assert.strictEqual(summary.body.monthly.length, 12);

    const recurring = await request(app).get('/api/transactions/recurring').set(headers);
    assert.ok(recurring.body.recurring.length >= 4);
});

test('each demo account is isolated from the others', async () => {
    const first = await request(app).post('/api/demo');
    const second = await request(app).post('/api/demo');

    assert.notStrictEqual(first.body.user.id, second.body.user.id);
    assert.notStrictEqual(first.body.user.email, second.body.user.email);

    // Same seeded rows, different owners: the dedupe index is per-user, so
    // the second account must still get a full set.
    assert.strictEqual(first.body.seeded, second.body.seeded);

    const secondList = await request(app)
        .get('/api/transactions')
        .set({ Authorization: `Bearer ${second.body.token}` });

    assert.strictEqual(secondList.body.pagination.total, second.body.seeded);
});
