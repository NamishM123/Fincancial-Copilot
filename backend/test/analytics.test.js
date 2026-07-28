process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { summarize, byCategory, monthlySeries, detectRecurring, merchantKey, forecast } = require('../lib/analytics');

let nextId = 1;
function t(date, description, amountCents, type = 'expense', category = 'Other') {
    return { id: nextId++, date, description, amount_cents: amountCents, type, category };
}

// Generates `count` charges spaced `intervalDays` apart, starting at `start`.
function series(start, count, intervalDays, description, amountCents, category = 'Other') {
    const rows = [];
    const startMs = Date.parse(start);
    for (let i = 0; i < count; i++) {
        const date = new Date(startMs + i * intervalDays * 86400000).toISOString().slice(0, 10);
        rows.push(t(date, description, amountCents, 'expense', category));
    }
    return rows;
}

test('summarize totals income, expenses, balance, and savings rate', () => {
    const rows = [
        t('2026-01-01', 'Salary', 500000, 'income', 'Salary'),
        t('2026-01-02', 'Rent', 150000),
        t('2026-01-03', 'Food', 50000),
    ];

    const s = summarize(rows);
    assert.strictEqual(s.incomeCents, 500000);
    assert.strictEqual(s.expenseCents, 200000);
    assert.strictEqual(s.balanceCents, 300000);
    assert.strictEqual(s.transactionCount, 3);
    assert.strictEqual(s.savingsRate, 0.6);
});

test('summarize reports a null savings rate when there is no income', () => {
    assert.strictEqual(summarize([t('2026-01-02', 'Rent', 150000)]).savingsRate, null);
    assert.strictEqual(summarize([]).balanceCents, 0);
});

test('byCategory sorts descending and filters by type', () => {
    const rows = [
        t('2026-01-01', 'Rent', 150000, 'expense', 'Utilities'),
        t('2026-01-02', 'Lunch', 2000, 'expense', 'Food'),
        t('2026-01-03', 'Dinner', 3000, 'expense', 'Food'),
        t('2026-01-04', 'Salary', 500000, 'income', 'Salary'),
    ];

    assert.deepStrictEqual(byCategory(rows, 'expense'), [
        { category: 'Utilities', amountCents: 150000 },
        { category: 'Food', amountCents: 5000 },
    ]);
    assert.deepStrictEqual(byCategory(rows, 'income'), [{ category: 'Salary', amountCents: 500000 }]);
});

test('monthlySeries buckets by calendar month, oldest first', () => {
    const rows = [
        t('2026-02-15', 'Feb expense', 3000),
        t('2026-01-10', 'Jan salary', 100000, 'income', 'Salary'),
        t('2026-01-20', 'Jan expense', 40000),
    ];

    const months = monthlySeries(rows);
    assert.deepStrictEqual(months.map((m) => m.month), ['2026-01', '2026-02']);
    assert.strictEqual(months[0].netCents, 60000);
    assert.strictEqual(months[1].netCents, -3000);
});

test('merchantKey collapses card and order numbers onto one merchant', () => {
    assert.strictEqual(merchantKey('SQ *BLUE BOTTLE #4412'), merchantKey('SQ *BLUE BOTTLE #9981'));
    assert.notStrictEqual(merchantKey('BLUE BOTTLE'), merchantKey('PEETS COFFEE'));
});

test('detectRecurring finds a monthly subscription', () => {
    const rows = series('2026-01-05', 6, 30, 'NETFLIX.COM', 1599, 'Entertainment');
    const recurring = detectRecurring(rows);

    assert.strictEqual(recurring.length, 1);
    assert.strictEqual(recurring[0].cadence, 'monthly');
    assert.strictEqual(recurring[0].occurrences, 6);
    assert.strictEqual(recurring[0].typicalCents, 1599);
});

test('detectRecurring identifies weekly, biweekly, and annual cadences', () => {
    const cadence = (intervalDays, count) =>
        detectRecurring(series('2026-01-05', count, intervalDays, 'ACME SUB', 1000))[0].cadence;

    assert.strictEqual(cadence(7, 8), 'weekly');
    assert.strictEqual(cadence(14, 6), 'biweekly');
    assert.strictEqual(cadence(365, 3), 'annual');
});

test('detectRecurring needs at least three occurrences', () => {
    // Two points always look periodic; that is not evidence of a subscription.
    assert.strictEqual(detectRecurring(series('2026-01-05', 2, 30, 'SPOTIFY', 1099)).length, 0);
    assert.strictEqual(detectRecurring(series('2026-01-05', 3, 30, 'SPOTIFY', 1099)).length, 1);
});

test('detectRecurring ignores a merchant visited at irregular intervals', () => {
    const rows = [
        t('2026-01-03', 'CORNER STORE', 1200),
        t('2026-01-04', 'CORNER STORE', 800),
        t('2026-02-19', 'CORNER STORE', 1500),
        t('2026-03-30', 'CORNER STORE', 600),
        t('2026-04-01', 'CORNER STORE', 2200),
    ];
    assert.strictEqual(detectRecurring(rows).length, 0);
});

test('detectRecurring ignores a merchant whose amount swings wildly', () => {
    const rows = series('2026-01-05', 6, 30, 'WHOLE FOODS', 5000);
    rows.forEach((r, i) => { r.amount_cents = 2000 + i * 4000; });

    assert.strictEqual(detectRecurring(rows).length, 0);
});

test('detectRecurring reports a subscription price increase', () => {
    const rows = series('2026-01-05', 6, 30, 'SPOTIFY', 1099);
    rows[4].amount_cents = 1199;
    rows[5].amount_cents = 1199;

    const [sub] = detectRecurring(rows);
    assert.ok(sub.amountChanged, 'expected a price change to be reported');
    assert.strictEqual(sub.amountChanged.fromCents, 1099);
    assert.strictEqual(sub.amountChanged.toCents, 1199);
});

test('detectRecurring normalises weekly charges to a monthly equivalent', () => {
    const [weekly] = detectRecurring(series('2026-01-05', 8, 7, 'GYM CLASS', 2500));
    // 25.00 a week is roughly 108.57 a month.
    assert.ok(Math.abs(weekly.monthlyEquivalentCents - 10857) < 50, `got ${weekly.monthlyEquivalentCents}`);
});

test('detectRecurring only considers expenses, not recurring income', () => {
    const paychecks = series('2026-01-05', 6, 14, 'ACME PAYROLL', 250000).map((r) => ({ ...r, type: 'income' }));
    assert.strictEqual(detectRecurring(paychecks).length, 0);
});

test('detectRecurring ranks by monthly cost', () => {
    const rows = [
        ...series('2026-01-05', 5, 30, 'CHEAP SUB', 500),
        ...series('2026-01-07', 5, 30, 'PRICEY SUB', 5000),
    ];

    const recurring = detectRecurring(rows);
    assert.strictEqual(recurring.length, 2);
    assert.strictEqual(recurring[0].merchant, 'PRICEY SUB');
});

test('forecast subtracts recurring and discretionary spend from the balance', () => {
    const rows = [
        t('2026-03-01', 'Salary', 300000, 'income', 'Salary'),
        ...series('2026-01-05', 4, 30, 'NETFLIX.COM', 1599, 'Entertainment'),
    ];

    const f = forecast(rows, { days: 30, asOf: '2026-04-05' });

    assert.strictEqual(f.days, 30);
    assert.strictEqual(f.startingBalanceCents, summarize(rows).balanceCents);
    assert.ok(f.recurringOutflowCents > 0, 'expected the detected subscription to be projected forward');
    assert.ok(f.projectedBalanceCents < f.startingBalanceCents + f.expectedInflowCents);
});

test('forecast on an empty history returns zeroes rather than NaN', () => {
    const f = forecast([], { days: 30 });
    assert.strictEqual(f.projectedBalanceCents, 0);
    assert.ok(Number.isFinite(f.discretionaryOutflowCents));
});
