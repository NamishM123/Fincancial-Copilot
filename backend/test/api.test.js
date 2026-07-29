process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const app = require('../app');
const db = require('../db');

test.before(async () => {
    await db.init();
});

test.after(async () => {
    await db.close();
});

let userCounter = 0;

async function makeUser() {
    userCounter++;
    const creds = {
        username: `user${userCounter}`,
        email: `user${userCounter}@example.com`,
        password: 'correct horse battery',
    };

    const res = await request(app).post('/api/register').send(creds);
    assert.strictEqual(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);

    return { ...creds, token: res.body.token, id: res.body.user.id };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

function txn(overrides = {}) {
    return {
        description: 'Coffee',
        amount: 4.5,
        type: 'expense',
        category: 'Food',
        date: '2026-03-01',
        ...overrides,
    };
}

test('health endpoint reports status without auth', async () => {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
});

test('register rejects short passwords', async () => {
    const res = await request(app)
        .post('/api/register')
        .send({ username: 'shorty', email: 'shorty@example.com', password: 'abc123' });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /at least 8/);
});

test('register rejects a malformed email', async () => {
    const res = await request(app)
        .post('/api/register')
        .send({ username: 'bad', email: 'not-an-email', password: 'a-good-password' });

    assert.strictEqual(res.status, 400);
});

test('register rejects a duplicate email', async () => {
    const user = await makeUser();
    const res = await request(app)
        .post('/api/register')
        .send({ username: 'different', email: user.email, password: 'a-good-password' });

    assert.strictEqual(res.status, 409);
});

test('login succeeds with correct credentials and fails with wrong ones', async () => {
    const user = await makeUser();

    const ok = await request(app).post('/api/login').send({ email: user.email, password: user.password });
    assert.strictEqual(ok.status, 200);
    assert.ok(ok.body.token);

    const bad = await request(app).post('/api/login').send({ email: user.email, password: 'wrong-password' });
    assert.strictEqual(bad.status, 401);
});

test('login does not reveal whether an email is registered', async () => {
    const user = await makeUser();

    const wrongPassword = await request(app).post('/api/login').send({ email: user.email, password: 'wrong-password' });
    const noSuchUser = await request(app).post('/api/login').send({ email: 'ghost@example.com', password: 'wrong-password' });

    assert.strictEqual(wrongPassword.status, noSuchUser.status);
    assert.strictEqual(wrongPassword.body.error, noSuchUser.body.error);
});

test('protected routes reject missing and malformed tokens', async () => {
    const noToken = await request(app).get('/api/transactions');
    assert.strictEqual(noToken.status, 401);

    const badToken = await request(app).get('/api/transactions').set(auth('not-a-real-token'));
    assert.strictEqual(badToken.status, 401);
});

test('a token signed with the wrong secret is rejected', async () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ userId: 1, username: 'attacker' }, 'some-other-secret', { expiresIn: '1h' });

    const res = await request(app).get('/api/transactions').set(auth(forged));
    assert.strictEqual(res.status, 401);
});

test('creating and listing a transaction round-trips as integer cents', async () => {
    const user = await makeUser();

    const created = await request(app).post('/api/transactions').set(auth(user.token)).send(txn({ amount: 19.99 }));
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.transaction.amount_cents, 1999);

    const list = await request(app).get('/api/transactions').set(auth(user.token));
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.transactions.length, 1);
    assert.strictEqual(list.body.transactions[0].amount_cents, 1999);
});

test('summing many cent-denominated amounts stays exact', async () => {
    const user = await makeUser();

    // 0.1 + 0.2 !== 0.3 in binary floating point. Ten of them stored as REAL
    // would not sum to exactly 1.00.
    for (let i = 0; i < 10; i++) {
        const res = await request(app)
            .post('/api/transactions')
            .set(auth(user.token))
            .send(txn({ amount: 0.1, description: `Item ${i}`, date: `2026-03-${String(i + 1).padStart(2, '0')}` }));
        assert.strictEqual(res.status, 201);
    }

    const summary = await request(app).get('/api/transactions/summary').set(auth(user.token));
    assert.strictEqual(summary.body.summary.expenseCents, 100);
});

test('transaction validation rejects bad input', async () => {
    const user = await makeUser();
    const post = (body) => request(app).post('/api/transactions').set(auth(user.token)).send(body);

    assert.strictEqual((await post(txn({ amount: 0 }))).status, 400);
    assert.strictEqual((await post(txn({ amount: -5 }))).status, 400);
    assert.strictEqual((await post(txn({ amount: 'abc' }))).status, 400);
    assert.strictEqual((await post(txn({ type: 'transfer' }))).status, 400);
    assert.strictEqual((await post(txn({ date: '01/03/2026' }))).status, 400);
    assert.strictEqual((await post(txn({ description: '' }))).status, 400);
});

test('an identical duplicate transaction is rejected', async () => {
    const user = await makeUser();

    assert.strictEqual((await request(app).post('/api/transactions').set(auth(user.token)).send(txn())).status, 201);
    assert.strictEqual((await request(app).post('/api/transactions').set(auth(user.token)).send(txn())).status, 409);
});

test('users cannot read each others transactions', async () => {
    const alice = await makeUser();
    const bob = await makeUser();

    await request(app).post('/api/transactions').set(auth(alice.token)).send(txn({ description: 'Alice secret' }));

    const bobList = await request(app).get('/api/transactions').set(auth(bob.token));
    assert.strictEqual(bobList.body.transactions.length, 0);

    const bobSummary = await request(app).get('/api/transactions/summary').set(auth(bob.token));
    assert.strictEqual(bobSummary.body.summary.transactionCount, 0);
});

test('users cannot delete each others transactions', async () => {
    const alice = await makeUser();
    const bob = await makeUser();

    const created = await request(app).post('/api/transactions').set(auth(alice.token)).send(txn());
    const id = created.body.transaction.id;

    const bobDelete = await request(app).delete(`/api/transactions/${id}`).set(auth(bob.token));
    assert.strictEqual(bobDelete.status, 404);

    // Confirm it really is still there rather than merely reported as missing.
    const aliceList = await request(app).get('/api/transactions').set(auth(alice.token));
    assert.strictEqual(aliceList.body.transactions.length, 1);

    const aliceDelete = await request(app).delete(`/api/transactions/${id}`).set(auth(alice.token));
    assert.strictEqual(aliceDelete.status, 200);
});

test('listing is paginated and caps the page size', async () => {
    const user = await makeUser();

    for (let i = 1; i <= 12; i++) {
        await request(app)
            .post('/api/transactions')
            .set(auth(user.token))
            .send(txn({ description: `Txn ${i}`, date: `2026-04-${String(i).padStart(2, '0')}` }));
    }

    const firstPage = await request(app).get('/api/transactions?limit=5').set(auth(user.token));
    assert.strictEqual(firstPage.body.transactions.length, 5);
    assert.strictEqual(firstPage.body.pagination.total, 12);
    assert.strictEqual(firstPage.body.pagination.hasMore, true);

    const lastPage = await request(app).get('/api/transactions?limit=5&offset=10').set(auth(user.token));
    assert.strictEqual(lastPage.body.transactions.length, 2);
    assert.strictEqual(lastPage.body.pagination.hasMore, false);

    // An oversized limit is clamped rather than honoured.
    const huge = await request(app).get('/api/transactions?limit=99999').set(auth(user.token));
    assert.strictEqual(huge.body.pagination.limit, 200);
});

test('summary computes balance, category totals, and savings rate', async () => {
    const user = await makeUser();
    const post = (body) => request(app).post('/api/transactions').set(auth(user.token)).send(body);

    await post(txn({ description: 'Salary', amount: 3000, type: 'income', category: 'Salary', date: '2026-05-01' }));
    await post(txn({ description: 'Rent', amount: 1200, category: 'Utilities', date: '2026-05-02' }));
    await post(txn({ description: 'Groceries', amount: 300, category: 'Food', date: '2026-05-03' }));

    const res = await request(app).get('/api/transactions/summary').set(auth(user.token));

    assert.strictEqual(res.body.summary.incomeCents, 300000);
    assert.strictEqual(res.body.summary.expenseCents, 150000);
    assert.strictEqual(res.body.summary.balanceCents, 150000);
    assert.strictEqual(res.body.summary.transactionCount, 3);
    assert.strictEqual(res.body.summary.savingsRate, 0.5);

    assert.deepStrictEqual(res.body.byCategory[0], { category: 'Utilities', amountCents: 120000 });
});

test('chat requires auth and rejects empty or oversized messages', async () => {
    const user = await makeUser();

    assert.strictEqual((await request(app).post('/api/chat').send({ message: 'hi' })).status, 401);
    assert.strictEqual((await request(app).post('/api/chat').set(auth(user.token)).send({ message: '  ' })).status, 400);

    const tooLong = await request(app).post('/api/chat').set(auth(user.token)).send({ message: 'x'.repeat(1001) });
    assert.strictEqual(tooLong.status, 400);
});

test('chat answers from local analytics when no API key is configured', async () => {
    const user = await makeUser();
    await request(app).post('/api/transactions').set(auth(user.token)).send(txn({ amount: 12.34 }));

    const res = await request(app).post('/api/chat').set(auth(user.token)).send({ message: 'how am I doing?' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mode, 'deterministic');
    assert.match(res.body.message, /12\.34/);
});

test('unknown API routes return JSON, not the SPA shell', async () => {
    const res = await request(app).get('/api/does-not-exist');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'Endpoint not found');
});

// --- CSV import (added with the analytics engine) ---

const SAMPLE_CSV = [
    'Transaction Date,Description,Amount',
    '2026-01-05,ACME PAYROLL,2500.00',
    '2026-01-06,SAFEWAY #1234,-84.21',
    '2026-01-07,"AMAZON MKTP, INC",-32.10',
].join('\n');

test('CSV import inserts rows, categorises them, and reports counts', async () => {
    const user = await makeUser();

    const res = await request(app)
        .post('/api/transactions/import')
        .set(auth(user.token))
        .send({ csv: SAMPLE_CSV });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.imported, 3);
    assert.strictEqual(res.body.rowsFailed, 0);

    const list = await request(app).get('/api/transactions').set(auth(user.token));
    const payroll = list.body.transactions.find((t) => t.description === 'ACME PAYROLL');
    const safeway = list.body.transactions.find((t) => t.description.startsWith('SAFEWAY'));

    assert.strictEqual(payroll.type, 'income');
    assert.strictEqual(payroll.category, 'Salary');
    assert.strictEqual(safeway.type, 'expense');
    assert.strictEqual(safeway.amount_cents, 8421);

    // The quoted field containing a comma must survive as one description.
    assert.ok(list.body.transactions.some((t) => t.description === 'AMAZON MKTP, INC'));
});

test('re-importing the same CSV is a no-op', async () => {
    const user = await makeUser();
    const post = () => request(app).post('/api/transactions/import').set(auth(user.token)).send({ csv: SAMPLE_CSV });

    const first = await post();
    assert.strictEqual(first.body.imported, 3);

    const second = await post();
    assert.strictEqual(second.body.imported, 0);
    assert.strictEqual(second.body.duplicatesSkipped, 3);

    const list = await request(app).get('/api/transactions').set(auth(user.token));
    assert.strictEqual(list.body.pagination.total, 3);
});

test('an overlapping statement imports only the new rows', async () => {
    const user = await makeUser();

    await request(app).post('/api/transactions/import').set(auth(user.token)).send({ csv: SAMPLE_CSV });

    const overlapping = `${SAMPLE_CSV}\n2026-01-08,NEW MERCHANT,-15.00`;
    const res = await request(app).post('/api/transactions/import').set(auth(user.token)).send({ csv: overlapping });

    assert.strictEqual(res.body.imported, 1);
    assert.strictEqual(res.body.duplicatesSkipped, 3);
});

test('CSV import rejects empty input and files with no usable columns', async () => {
    const user = await makeUser();
    const post = (csv) => request(app).post('/api/transactions/import').set(auth(user.token)).send({ csv });

    assert.strictEqual((await post('')).status, 400);
    assert.strictEqual((await post('just,some,headers\n1,2,3')).status, 400);
});

test('CSV import is scoped to the importing user', async () => {
    const alice = await makeUser();
    const bob = await makeUser();

    await request(app).post('/api/transactions/import').set(auth(alice.token)).send({ csv: SAMPLE_CSV });

    const bobList = await request(app).get('/api/transactions').set(auth(bob.token));
    assert.strictEqual(bobList.body.pagination.total, 0);

    // Identical rows for a different user are not duplicates.
    const bobImport = await request(app).post('/api/transactions/import').set(auth(bob.token)).send({ csv: SAMPLE_CSV });
    assert.strictEqual(bobImport.body.imported, 3);
});

test('recurring and forecast endpoints work end to end', async () => {
    const user = await makeUser();

    const rows = ['Date,Description,Amount'];
    for (let i = 0; i < 6; i++) {
        const date = new Date(Date.UTC(2026, 0, 5) + i * 30 * 86400000).toISOString().slice(0, 10);
        rows.push(`${date},NETFLIX.COM,-15.99`);
    }
    await request(app).post('/api/transactions/import').set(auth(user.token)).send({ csv: rows.join('\n') });

    const recurring = await request(app).get('/api/transactions/recurring').set(auth(user.token));
    assert.strictEqual(recurring.status, 200);
    assert.strictEqual(recurring.body.recurring.length, 1);
    assert.strictEqual(recurring.body.recurring[0].cadence, 'monthly');
    assert.strictEqual(recurring.body.recurring[0].typicalCents, 1599);

    const forecast = await request(app).get('/api/transactions/forecast?days=30').set(auth(user.token));
    assert.strictEqual(forecast.status, 200);
    assert.strictEqual(forecast.body.forecast.days, 30);

    // Clamped to the 1-365 range rather than honoured verbatim.
    const clamped = await request(app).get('/api/transactions/forecast?days=99999').set(auth(user.token));
    assert.strictEqual(clamped.body.forecast.days, 365);
});

test('summary includes a monthly series after import', async () => {
    const user = await makeUser();
    await request(app).post('/api/transactions/import').set(auth(user.token)).send({ csv: SAMPLE_CSV });

    const res = await request(app).get('/api/transactions/summary').set(auth(user.token));
    assert.strictEqual(res.body.summary.incomeCents, 250000);
    assert.strictEqual(res.body.summary.expenseCents, 11631);
    assert.ok(Array.isArray(res.body.monthly));
    assert.strictEqual(res.body.monthly[0].month, '2026-01');
});

// --- categorisation wiring and the correction loop ---

test('a transaction with no category gets one from the categoriser', async () => {
    const user = await makeUser();

    const res = await request(app)
        .post('/api/transactions')
        .set(auth(user.token))
        .send({ description: 'TRADER JOES #189', amount: 42.10, type: 'expense', date: '2026-05-01' });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.transaction.category, 'Food');
    assert.notStrictEqual(res.body.transaction.category_source, 'user');
});

test('an explicit category is authoritative over the categoriser', async () => {
    const user = await makeUser();

    const res = await request(app)
        .post('/api/transactions')
        .set(auth(user.token))
        .send({ description: 'TRADER JOES #189', amount: 42.10, type: 'expense', category: 'Shopping', date: '2026-05-02' });

    assert.strictEqual(res.body.transaction.category, 'Shopping');
    assert.strictEqual(res.body.transaction.category_source, 'user');
});

test('CSV import categorises rows and reports how it decided', async () => {
    const user = await makeUser();

    const csv = [
        'Date,Description,Amount',
        '2026-02-01,NETFLIX.COM,-15.99',
        '2026-02-02,SHELL OIL,-48.00',
        '2026-02-03,ACME CORP PAYROLL,2150.00',
    ].join('\n');

    const res = await request(app).post('/api/transactions/import').set(auth(user.token)).send({ csv });

    assert.strictEqual(res.body.imported, 3);
    assert.ok(res.body.categorization, 'expected a categorisation breakdown');

    const list = await request(app).get('/api/transactions').set(auth(user.token));
    const byDescription = Object.fromEntries(list.body.transactions.map((t) => [t.description, t]));

    assert.strictEqual(byDescription['NETFLIX.COM'].category, 'Entertainment');
    assert.strictEqual(byDescription['SHELL OIL'].category, 'Transportation');
    assert.strictEqual(byDescription['ACME CORP PAYROLL'].category, 'Salary');
});

test('a category column in the file overrides the categoriser', async () => {
    const user = await makeUser();

    const csv = 'Date,Description,Amount,Category\n2026-02-01,NETFLIX.COM,-15.99,Education';
    await request(app).post('/api/transactions/import').set(auth(user.token)).send({ csv });

    const list = await request(app).get('/api/transactions').set(auth(user.token));
    assert.strictEqual(list.body.transactions[0].category, 'Education');
    assert.strictEqual(list.body.transactions[0].category_source, 'user');
});

test('correcting a category updates the row and records the correction', async () => {
    const user = await makeUser();

    const created = await request(app)
        .post('/api/transactions')
        .set(auth(user.token))
        .send({ description: 'BLUE BOTTLE COFFEE', amount: 5.50, type: 'expense', date: '2026-05-03' });

    const id = created.body.transaction.id;
    assert.strictEqual(created.body.transaction.category, 'Food');

    const patched = await request(app)
        .patch(`/api/transactions/${id}/category`)
        .set(auth(user.token))
        .send({ category: 'Entertainment' });

    assert.strictEqual(patched.status, 200);
    assert.strictEqual(patched.body.transaction.category, 'Entertainment');
    assert.strictEqual(patched.body.transaction.category_source, 'user');

    const stats = await request(app).get('/api/transactions/categorization-stats').set(auth(user.token));
    assert.strictEqual(stats.body.corrections, 1);
});

test('correcting a category requires a category and rejects other users', async () => {
    const alice = await makeUser();
    const bob = await makeUser();

    const created = await request(app)
        .post('/api/transactions')
        .set(auth(alice.token))
        .send({ description: 'SAFEWAY #221', amount: 30, type: 'expense', date: '2026-05-04' });
    const id = created.body.transaction.id;

    const missing = await request(app).patch(`/api/transactions/${id}/category`).set(auth(alice.token)).send({});
    assert.strictEqual(missing.status, 400);

    const wrongUser = await request(app)
        .patch(`/api/transactions/${id}/category`)
        .set(auth(bob.token))
        .send({ category: 'Food' });
    assert.strictEqual(wrongUser.status, 404);
});

test('categorisation stats report observed accuracy once there is data', async () => {
    const user = await makeUser();

    const csv = [
        'Date,Description,Amount',
        '2026-03-01,NETFLIX.COM,-15.99',
        '2026-03-02,SHELL OIL,-48.00',
        '2026-03-03,SAFEWAY #221,-84.00',
        '2026-03-04,CVS PHARMACY,-22.00',
    ].join('\n');
    await request(app).post('/api/transactions/import').set(auth(user.token)).send({ csv });

    const before = await request(app).get('/api/transactions/categorization-stats').set(auth(user.token));
    assert.strictEqual(before.body.autoCategorized, 4);
    assert.strictEqual(before.body.observedAccuracy, 1);

    const list = await request(app).get('/api/transactions').set(auth(user.token));
    const target = list.body.transactions.find((t) => t.description === 'CVS PHARMACY');
    await request(app)
        .patch(`/api/transactions/${target.id}/category`)
        .set(auth(user.token))
        .send({ category: 'Shopping' });

    const after = await request(app).get('/api/transactions/categorization-stats').set(auth(user.token));
    assert.strictEqual(after.body.corrections, 1);
    // One correction out of the three rows still auto-categorised.
    assert.ok(after.body.observedAccuracy < 1);
});

// --- search, filtering, sorting, editing ---

async function seedForFiltering(token) {
    const rows = [
        ['SAFEWAY GROCERIES', 84.21, 'expense', 'Food', '2026-01-10'],
        ['BLUE BOTTLE COFFEE', 4.50, 'expense', 'Food', '2026-01-15'],
        ['UBER TRIP', 23.40, 'expense', 'Transportation', '2026-02-05'],
        ['NETFLIX SUBSCRIPTION', 15.99, 'expense', 'Entertainment', '2026-02-20'],
        ['ACME PAYROLL', 3000.00, 'income', 'Salary', '2026-03-01'],
        ['UBER EATS ORDER', 31.10, 'expense', 'Food', '2026-03-12'],
    ];

    for (const [description, amount, type, category, date] of rows) {
        const res = await request(app)
            .post('/api/transactions')
            .set(auth(token))
            .send({ description, amount, type, category, date });
        assert.strictEqual(res.status, 201, `seed failed: ${JSON.stringify(res.body)}`);
    }
}

const list = (token, qs = '') => request(app).get(`/api/transactions${qs}`).set(auth(token));

test('search matches descriptions case-insensitively', async () => {
    const user = await makeUser();
    await seedForFiltering(user.token);

    const res = await list(user.token, '?search=uber');
    assert.strictEqual(res.body.pagination.total, 2);
    assert.ok(res.body.transactions.every((t) => t.description.toUpperCase().includes('UBER')));
});

test('search wildcards are escaped rather than interpreted', async () => {
    const user = await makeUser();
    await seedForFiltering(user.token);
    await request(app)
        .post('/api/transactions')
        .set(auth(user.token))
        .send({ description: '100% CASHBACK BONUS', amount: 10, type: 'income', category: 'Other Income', date: '2026-04-01' });

    // An unescaped '%' would make this match every row.
    const res = await list(user.token, '?search=100%25');
    assert.strictEqual(res.body.pagination.total, 1);

    const underscore = await list(user.token, '?search=_');
    assert.strictEqual(underscore.body.pagination.total, 0);
});

test('filters by category, type, and date range', async () => {
    const user = await makeUser();
    await seedForFiltering(user.token);

    assert.strictEqual((await list(user.token, '?category=Food')).body.pagination.total, 3);
    assert.strictEqual((await list(user.token, '?type=income')).body.pagination.total, 1);
    assert.strictEqual((await list(user.token, '?start_date=2026-02-01&end_date=2026-02-28')).body.pagination.total, 2);
});

test('filters by amount range', async () => {
    const user = await makeUser();
    await seedForFiltering(user.token);

    const small = await list(user.token, '?max_amount=25');
    assert.ok(small.body.transactions.every((t) => t.amount_cents <= 2500));

    const large = await list(user.token, '?min_amount=100');
    assert.strictEqual(large.body.pagination.total, 1);
    assert.strictEqual(large.body.transactions[0].description, 'ACME PAYROLL');
});

test('filters combine, and the count matches the rows it describes', async () => {
    const user = await makeUser();
    await seedForFiltering(user.token);

    const res = await list(user.token, '?category=Food&start_date=2026-01-01&end_date=2026-02-28');
    assert.strictEqual(res.body.pagination.total, 2);
    assert.strictEqual(res.body.transactions.length, 2);

    // A count that disagrees with its rows produces a "Load more" that lies.
    const paged = await list(user.token, '?category=Food&limit=1');
    assert.strictEqual(paged.body.pagination.total, 3);
    assert.strictEqual(paged.body.transactions.length, 1);
    assert.strictEqual(paged.body.pagination.hasMore, true);
});

test('sorting is whitelisted and falls back safely', async () => {
    const user = await makeUser();
    await seedForFiltering(user.token);

    const byAmount = await list(user.token, '?sort=amount&order=desc');
    const amounts = byAmount.body.transactions.map((t) => t.amount_cents);
    assert.deepStrictEqual(amounts, [...amounts].sort((a, b) => b - a));

    const ascending = await list(user.token, '?sort=amount&order=asc');
    assert.strictEqual(ascending.body.transactions[0].amount_cents, 450);

    // An unknown sort column must not reach SQL; it falls back to date.
    const injected = await list(user.token, '?sort=amount_cents;DROP TABLE transactions--');
    assert.strictEqual(injected.status, 200);
    assert.strictEqual(injected.body.pagination.total, 6);
});

test('filtering is scoped to the requesting user', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    await seedForFiltering(alice.token);

    const res = await list(bob.token, '?search=uber');
    assert.strictEqual(res.body.pagination.total, 0);
});

test('categories endpoint lists what the user actually has', async () => {
    const user = await makeUser();
    await seedForFiltering(user.token);

    const res = await request(app).get('/api/transactions/categories').set(auth(user.token));
    const food = res.body.categories.find((c) => c.category === 'Food');

    assert.strictEqual(food.count, 3);
    assert.strictEqual(food.type, 'expense');
    assert.ok(res.body.categories.some((c) => c.category === 'Salary'));
});

test('editing updates only the fields that were sent', async () => {
    const user = await makeUser();
    const created = await request(app)
        .post('/api/transactions')
        .set(auth(user.token))
        .send({ description: 'Typo descriptoin', amount: 12.00, type: 'expense', category: 'Food', date: '2026-06-01' });

    const id = created.body.transaction.id;

    const res = await request(app)
        .put(`/api/transactions/${id}`)
        .set(auth(user.token))
        .send({ description: 'Corrected description' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.transaction.description, 'Corrected description');
    assert.strictEqual(res.body.transaction.amount_cents, 1200);
    assert.strictEqual(res.body.transaction.category, 'Food');
    assert.strictEqual(res.body.transaction.date, '2026-06-01');
});

test('editing recomputes the dedupe hash so imports still detect duplicates', async () => {
    const user = await makeUser();
    const created = await request(app)
        .post('/api/transactions')
        .set(auth(user.token))
        .send({ description: 'PLACEHOLDER', amount: 1.00, type: 'expense', category: 'Other', date: '2026-06-02' });

    const id = created.body.transaction.id;
    const originalHash = created.body.transaction.dedupe_hash;

    const edited = await request(app)
        .put(`/api/transactions/${id}`)
        .set(auth(user.token))
        .send({ description: 'REAL MERCHANT', amount: 25.00, date: '2026-06-03' });

    assert.notStrictEqual(edited.body.transaction.dedupe_hash, originalHash);

    // A stale hash here would let this same row import again as a "new" one.
    const csv = 'Date,Description,Amount\n2026-06-03,REAL MERCHANT,-25.00';
    const imported = await request(app).post('/api/transactions/import').set(auth(user.token)).send({ csv });
    assert.strictEqual(imported.body.imported, 0);
    assert.strictEqual(imported.body.duplicatesSkipped, 1);
});

test('editing validates the same rules as creating', async () => {
    const user = await makeUser();
    const created = await request(app)
        .post('/api/transactions')
        .set(auth(user.token))
        .send({ description: 'Valid', amount: 10, type: 'expense', category: 'Food', date: '2026-06-04' });
    const id = created.body.transaction.id;

    const put = (body) => request(app).put(`/api/transactions/${id}`).set(auth(user.token)).send(body);

    assert.strictEqual((await put({ amount: 0 })).status, 400);
    assert.strictEqual((await put({ amount: -3 })).status, 400);
    assert.strictEqual((await put({ type: 'transfer' })).status, 400);
    assert.strictEqual((await put({ date: '06/04/2026' })).status, 400);
    assert.strictEqual((await put({ description: '   ' })).status, 400);
});

test('editing a row into an existing one is rejected as a duplicate', async () => {
    const user = await makeUser();
    const base = { amount: 10, type: 'expense', category: 'Food', date: '2026-07-01' };

    await request(app).post('/api/transactions').set(auth(user.token)).send({ ...base, description: 'FIRST' });
    const second = await request(app).post('/api/transactions').set(auth(user.token)).send({ ...base, description: 'SECOND' });

    const res = await request(app)
        .put(`/api/transactions/${second.body.transaction.id}`)
        .set(auth(user.token))
        .send({ description: 'FIRST' });

    assert.strictEqual(res.status, 409);
});

test('switching type re-derives a category from the new label space', async () => {
    const user = await makeUser();
    const created = await request(app)
        .post('/api/transactions')
        .set(auth(user.token))
        .send({ description: 'ACME CORP PAYROLL', amount: 2000, type: 'expense', category: 'Utilities', date: '2026-07-02' });

    const res = await request(app)
        .put(`/api/transactions/${created.body.transaction.id}`)
        .set(auth(user.token))
        .send({ type: 'income' });

    assert.strictEqual(res.body.transaction.type, 'income');
    // "Utilities" is not a valid income category; it must not survive the switch.
    assert.notStrictEqual(res.body.transaction.category, 'Utilities');
    assert.strictEqual(res.body.transaction.category, 'Salary');
});

test('users cannot edit each others transactions', async () => {
    const alice = await makeUser();
    const bob = await makeUser();

    const created = await request(app)
        .post('/api/transactions')
        .set(auth(alice.token))
        .send({ description: 'Alice row', amount: 10, type: 'expense', category: 'Food', date: '2026-07-03' });

    const res = await request(app)
        .put(`/api/transactions/${created.body.transaction.id}`)
        .set(auth(bob.token))
        .send({ description: 'Hijacked' });

    assert.strictEqual(res.status, 404);

    const stillThere = await request(app).get('/api/transactions?search=Alice row').set(auth(alice.token));
    assert.strictEqual(stillThere.body.transactions[0].description, 'Alice row');
});
