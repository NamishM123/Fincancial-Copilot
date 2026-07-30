/**
 * A fixed transaction ledger with hand-computed totals, used as ground truth
 * for the assistant evals.
 *
 * Deliberately small enough that every expected value below can be verified by
 * hand, and deliberately spanning more than one month so that range questions
 * have a wrong answer available to get wrong.
 */

let nextId = 1;
const row = (date, description, amountCents, type, category) => ({
    id: nextId++,
    user_id: 1,
    date,
    description,
    amount_cents: amountCents,
    type,
    category,
});

const LEDGER = [
    // --- January ---
    row('2026-01-02', 'ACME PAYROLL', 400000, 'income', 'Salary'),
    row('2026-01-03', 'RENT', 150000, 'expense', 'Utilities'),
    row('2026-01-05', 'NETFLIX.COM', 1599, 'expense', 'Entertainment'),
    row('2026-01-08', 'SAFEWAY #221', 12050, 'expense', 'Food'),
    row('2026-01-14', 'BLUE BOTTLE #4412', 650, 'expense', 'Food'),
    row('2026-01-19', 'UBER TRIP', 2340, 'expense', 'Transportation'),
    row('2026-01-26', 'SAFEWAY #221', 9875, 'expense', 'Food'),

    // --- February ---
    row('2026-02-02', 'ACME PAYROLL', 400000, 'income', 'Salary'),
    row('2026-02-03', 'RENT', 150000, 'expense', 'Utilities'),
    row('2026-02-04', 'NETFLIX.COM', 1599, 'expense', 'Entertainment'),
    row('2026-02-09', 'SAFEWAY #221', 14210, 'expense', 'Food'),
    row('2026-02-12', 'BLUE BOTTLE #9981', 700, 'expense', 'Food'),
    row('2026-02-21', 'UBER TRIP', 1890, 'expense', 'Transportation'),

    // --- March ---
    row('2026-03-02', 'ACME PAYROLL', 400000, 'income', 'Salary'),
    row('2026-03-03', 'RENT', 150000, 'expense', 'Utilities'),
    row('2026-03-06', 'NETFLIX.COM', 1799, 'expense', 'Entertainment'), // price rise
    row('2026-03-11', 'SAFEWAY #221', 11100, 'expense', 'Food'),
    row('2026-03-15', 'FREELANCE INVOICE', 75000, 'income', 'Freelance'),
];

// Every figure below is computed by hand from the rows above. If a change to
// the analytics engine breaks one of these, either the engine regressed or the
// ledger changed -- both worth failing over.
const EXPECTED = {
    totalIncomeCents: 1275000,   // 400000 * 3 + 75000
    totalExpenseCents: 507812,
    balanceCents: 767188,
    transactionCount: 18,

    january: {
        incomeCents: 400000,
        expenseCents: 176514,    // 150000 + 1599 + 12050 + 650 + 2340 + 9875
        netCents: 223486,
    },

    februaryFoodCents: 14910,    // 14210 + 700
    allFoodCents: 48585,         // 12050 + 650 + 9875 + 14210 + 700 + 11100
    allRentCents: 450000,
    safewayVisits: 4,

    // RENT and NETFLIX.COM recur monthly; BLUE BOTTLE and UBER appear only
    // twice each, and SAFEWAY's amount swings too much to qualify.
    recurringMerchants: ['rent', 'netflix com'],
    netflixPriceRise: { fromCents: 1599, toCents: 1799 },
};

module.exports = { LEDGER, EXPECTED };
