const { dedupeHash } = require('./dedupe');

/**
 * Generates a year of plausible transactions for the demo account.
 *
 * Deterministic given a seed, so the demo looks the same every time and the
 * analytics it exercises (recurring detection, month-over-month, forecast) have
 * something real to find. Everything here is fictional.
 */

// Small LCG. Math.random would make the demo different on every provision,
// which makes it impossible to reason about what a reviewer is looking at.
function rng(seed = 42) {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
}

const MONTHLY_BILLS = [
    { description: 'RENT', category: 'Utilities', cents: 165000, day: 1 },
    { description: 'PACIFIC GAS & ELECTRIC', category: 'Utilities', cents: 8450, day: 8, jitterCents: 2500 },
    { description: 'COMCAST INTERNET', category: 'Utilities', cents: 7999, day: 12 },
    { description: 'NETFLIX.COM', category: 'Entertainment', cents: 1599, day: 5 },
    { description: 'SPOTIFY USA', category: 'Entertainment', cents: 1099, day: 17 },
    { description: 'PLANET FITNESS', category: 'Healthcare', cents: 2499, day: 22 },
    { description: 'ICLOUD STORAGE', category: 'Utilities', cents: 299, day: 27 },
];

const DISCRETIONARY = [
    { description: 'SAFEWAY #221', category: 'Food', min: 4500, max: 18000, perMonth: 4 },
    { description: 'BLUE BOTTLE COFFEE', category: 'Food', min: 450, max: 900, perMonth: 8 },
    { description: 'CHIPOTLE #1183', category: 'Food', min: 1100, max: 2400, perMonth: 3 },
    { description: 'UBER TRIP', category: 'Transportation', min: 900, max: 3800, perMonth: 5 },
    { description: 'SHELL OIL', category: 'Transportation', min: 3500, max: 6500, perMonth: 2 },
    { description: 'AMAZON MKTP', category: 'Shopping', min: 1500, max: 12000, perMonth: 3 },
    { description: 'TARGET T-1842', category: 'Shopping', min: 2200, max: 9500, perMonth: 1 },
    { description: 'CVS PHARMACY', category: 'Healthcare', min: 800, max: 4500, perMonth: 1 },
    { description: 'AMC THEATRES', category: 'Entertainment', min: 1600, max: 3200, perMonth: 1 },
    { description: 'DOORDASH', category: 'Food', min: 1800, max: 4200, perMonth: 4 },
    { description: 'STARBUCKS #4471', category: 'Food', min: 500, max: 1100, perMonth: 6 },
    { description: 'TRADER JOES #189', category: 'Food', min: 3000, max: 9000, perMonth: 2 },
];

const iso = (d) => d.toISOString().slice(0, 10);

function generateTransactions({ months = 12, endDate = new Date(), seed = 42 } = {}) {
    const random = rng(seed);
    const between = (min, max) => Math.round(min + random() * (max - min));
    const rows = [];

    const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));

    for (let monthsAgo = months - 1; monthsAgo >= 0; monthsAgo--) {
        const cursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - monthsAgo, 1));
        const year = cursor.getUTCFullYear();
        const month = cursor.getUTCMonth();
        const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

        const push = (day, description, cents, type, category) => {
            const date = new Date(Date.UTC(year, month, Math.min(day, daysInMonth)));
            if (date > end) return;
            rows.push({ date: iso(date), description, amountCents: cents, type, category });
        };

        // Salary, paid on the 1st and 15th, with a raise partway through so the
        // month-over-month view has something to show.
        const salaryCents = monthsAgo >= 6 ? 215000 : 230000;
        push(1, 'ACME CORP PAYROLL', salaryCents, 'income', 'Salary');
        push(15, 'ACME CORP PAYROLL', salaryCents, 'income', 'Salary');

        for (const bill of MONTHLY_BILLS) {
            // Netflix raises its price partway through, which the recurring
            // detector should surface as a price change.
            let cents = bill.cents;
            if (bill.description === 'NETFLIX.COM' && monthsAgo < 4) cents = 1799;
            if (bill.jitterCents) cents += between(-bill.jitterCents, bill.jitterCents);
            push(bill.day, bill.description, cents, 'expense', bill.category);
        }

        for (const item of DISCRETIONARY) {
            for (let i = 0; i < item.perMonth; i++) {
                const day = between(1, daysInMonth);
                push(day, item.description, between(item.min, item.max), 'expense', item.category);
            }
        }

        // Occasional freelance income.
        if (random() < 0.35) {
            push(between(10, 25), 'UPWORK PAYOUT', between(35000, 120000), 'income', 'Freelance');
        }
    }

    // Deduplicate: two discretionary draws can land on the same day with the
    // same amount, which the unique index would reject anyway.
    const seen = new Set();
    return rows
        .map((r) => ({ ...r, dedupeHash: dedupeHash({ date: r.date, description: r.description, amountCents: r.amountCents, type: r.type }) }))
        .filter((r) => {
            if (seen.has(r.dedupeHash)) return false;
            seen.add(r.dedupeHash);
            return true;
        })
        .sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { generateTransactions };
