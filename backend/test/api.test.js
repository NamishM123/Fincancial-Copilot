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
