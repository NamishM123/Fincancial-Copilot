process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const { parseCsv, parseDate, detectColumns, guessCategory, parseTransactionsCsv } = require('../lib/csv');
const { dedupeHash } = require('../lib/dedupe');

test('parseCsv handles quoted fields containing commas', () => {
    const rows = parseCsv('a,b,c\n1,"AMAZON MKTP, INC",3');
    assert.deepStrictEqual(rows[1], ['1', 'AMAZON MKTP, INC', '3']);
});

test('parseCsv handles escaped double quotes', () => {
    const rows = parseCsv('desc\n"He said ""hi"""');
    assert.deepStrictEqual(rows[1], ['He said "hi"']);
});

test('parseCsv handles CRLF line endings and a UTF-8 BOM', () => {
    const rows = parseCsv('﻿Date,Amount\r\n2026-01-01,5.00\r\n');
    assert.deepStrictEqual(rows[0], ['Date', 'Amount']);
    assert.deepStrictEqual(rows[1], ['2026-01-01', '5.00']);
});

test('parseCsv handles embedded newlines inside quotes', () => {
    const rows = parseCsv('a,b\n"line one\nline two",x');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1][0], 'line one\nline two');
});

test('parseCsv skips blank lines', () => {
    const rows = parseCsv('a,b\n\n1,2\n\n');
    assert.strictEqual(rows.length, 2);
});

test('parseDate accepts the formats banks actually emit', () => {
    assert.strictEqual(parseDate('2026-03-04'), '2026-03-04');
    assert.strictEqual(parseDate('2026/03/04'), '2026-03-04');
    assert.strictEqual(parseDate('03/04/2026'), '2026-03-04');   // US month-first
    assert.strictEqual(parseDate('3/4/26'), '2026-03-04');
    assert.strictEqual(parseDate('15/03/2026'), '2026-03-15');   // >12 can only be a day
    assert.strictEqual(parseDate('04-Mar-2026'), '2026-03-04');
    assert.strictEqual(parseDate('Mar 4, 2026'), '2026-03-04');
});

test('parseDate rejects impossible dates instead of rolling them over', () => {
    // new Date(2026, 1, 31) silently becomes March 3rd.
    assert.strictEqual(parseDate('2026-02-31'), null);
    assert.strictEqual(parseDate('2026-13-01'), null);
    assert.strictEqual(parseDate('not a date'), null);
    assert.strictEqual(parseDate(''), null);
});

test('detectColumns maps common bank header spellings', () => {
    assert.deepStrictEqual(detectColumns(['Transaction Date', 'Description', 'Amount']), {
        date: 0, description: 1, amount: 2,
    });

    const chase = detectColumns(['Posting Date', 'Payee', 'Debit', 'Credit']);
    assert.strictEqual(chase.date, 0);
    assert.strictEqual(chase.description, 1);
    assert.strictEqual(chase.debit, 2);
    assert.strictEqual(chase.credit, 3);
});

test('import treats negative amounts as expenses and positives as income', () => {
    const csv = [
        'Date,Description,Amount',
        '2026-01-05,Paycheck,2500.00',
        '2026-01-06,Rent,-1200.00',
    ].join('\n');

    const { transactions, errors } = parseTransactionsCsv(csv);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(transactions[0].type, 'income');
    assert.strictEqual(transactions[0].amountCents, 250000);
    assert.strictEqual(transactions[1].type, 'expense');
    assert.strictEqual(transactions[1].amountCents, 120000);
});

test('import handles separate debit and credit columns', () => {
    const csv = [
        'Date,Description,Debit,Credit',
        '2026-01-05,Salary,,3000.00',
        '2026-01-06,Groceries,84.21,',
    ].join('\n');

    const { transactions } = parseTransactionsCsv(csv);
    assert.strictEqual(transactions[0].type, 'income');
    assert.strictEqual(transactions[1].type, 'expense');
    assert.strictEqual(transactions[1].amountCents, 8421);
});

test('import reads parenthesised negatives as expenses', () => {
    const csv = 'Date,Description,Amount\n2026-01-06,Utilities,(45.00)';
    const { transactions } = parseTransactionsCsv(csv);
    assert.strictEqual(transactions[0].type, 'expense');
    assert.strictEqual(transactions[0].amountCents, 4500);
});

test('import strips currency symbols and thousands separators', () => {
    const csv = 'Date,Description,Amount\n2026-01-06,Bonus,"$1,250.50"';
    const { transactions } = parseTransactionsCsv(csv);
    assert.strictEqual(transactions[0].amountCents, 125050);
});

test('import reports bad rows without discarding the good ones', () => {
    const csv = [
        'Date,Description,Amount',
        '2026-01-05,Good row,10.00',
        'garbage,Bad date,10.00',
        '2026-01-07,,10.00',
        '2026-01-08,Zero amount,0',
        '2026-01-09,Another good row,-20.00',
    ].join('\n');

    const { transactions, errors } = parseTransactionsCsv(csv);

    assert.strictEqual(transactions.length, 2);
    assert.strictEqual(errors.length, 3);
    // Row numbers are 1-indexed with the header as row 1, so they line up with
    // what a spreadsheet shows the user.
    assert.deepStrictEqual(errors.map((e) => e.row), [3, 4, 5]);
});

test('import fails with a useful message when a required column is missing', () => {
    const noAmount = parseTransactionsCsv('Date,Description\n2026-01-05,Coffee');
    assert.strictEqual(noAmount.transactions.length, 0);
    assert.match(noAmount.errors[0].message, /amount/i);

    const noDate = parseTransactionsCsv('Description,Amount\nCoffee,5.00');
    assert.match(noDate.errors[0].message, /date/i);
});

test('the same row always produces the same dedupe hash', () => {
    const csv = 'Date,Description,Amount\n2026-01-05,Coffee,-4.50';
    const first = parseTransactionsCsv(csv).transactions[0];
    const second = parseTransactionsCsv(csv).transactions[0];

    assert.strictEqual(first.dedupeHash, second.dedupeHash);
});

test('dedupe hash ignores case and whitespace in the description', () => {
    const a = dedupeHash({ date: '2026-01-05', description: 'BLUE  Bottle', amountCents: 450, type: 'expense' });
    const b = dedupeHash({ date: '2026-01-05', description: 'blue bottle', amountCents: 450, type: 'expense' });
    assert.strictEqual(a, b);
});

test('dedupe hash separates rows that differ in any meaningful field', () => {
    const base = { date: '2026-01-05', description: 'Coffee', amountCents: 450, type: 'expense' };
    const hashes = new Set([
        dedupeHash(base),
        dedupeHash({ ...base, date: '2026-01-06' }),
        dedupeHash({ ...base, amountCents: 451 }),
        dedupeHash({ ...base, type: 'income' }),
        dedupeHash({ ...base, description: 'Tea' }),
    ]);
    assert.strictEqual(hashes.size, 5);
});

test('guessCategory maps known merchants and respects income vs expense', () => {
    assert.strictEqual(guessCategory('SAFEWAY #1234', 'expense'), 'Food');
    assert.strictEqual(guessCategory('UBER TRIP', 'expense'), 'Transportation');
    assert.strictEqual(guessCategory('NETFLIX.COM', 'expense'), 'Entertainment');
    assert.strictEqual(guessCategory('ACME PAYROLL', 'income'), 'Salary');

    // An income-only rule must not fire on an expense row.
    assert.strictEqual(guessCategory('PAYROLL DEDUCTION', 'expense'), 'Other');
    assert.strictEqual(guessCategory('Unrecognised merchant', 'expense'), 'Other');
    assert.strictEqual(guessCategory('Unrecognised merchant', 'income'), 'Other Income');
});

test('import truncates at the configured row cap and says so', () => {
    const rows = ['Date,Description,Amount'];
    for (let i = 0; i < 20; i++) rows.push(`2026-01-${String((i % 28) + 1).padStart(2, '0')},Row ${i},-1.00`);

    const { transactions, errors } = parseTransactionsCsv(rows.join('\n'), { maxRows: 10 });

    assert.strictEqual(transactions.length, 10);
    assert.match(errors[errors.length - 1].message, /truncated/i);
});
