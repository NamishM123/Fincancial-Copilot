const { normalizeDescription } = require('./dedupe');

// Everything in this module is deterministic and computed from transaction rows.
// The chat layer narrates these results; it never does arithmetic itself.

function summarize(transactions) {
    let incomeCents = 0;
    let expenseCents = 0;

    for (const t of transactions) {
        if (t.type === 'income') incomeCents += t.amount_cents;
        else expenseCents += t.amount_cents;
    }

    return {
        incomeCents,
        expenseCents,
        balanceCents: incomeCents - expenseCents,
        transactionCount: transactions.length,
        savingsRate: incomeCents > 0 ? (incomeCents - expenseCents) / incomeCents : null,
    };
}

function byCategory(transactions, type = 'expense') {
    const totals = new Map();

    for (const t of transactions) {
        if (t.type !== type) continue;
        totals.set(t.category, (totals.get(t.category) || 0) + t.amount_cents);
    }

    return [...totals.entries()]
        .map(([category, amountCents]) => ({ category, amountCents }))
        .sort((a, b) => b.amountCents - a.amountCents);
}

function monthlySeries(transactions) {
    const months = new Map();

    for (const t of transactions) {
        const month = t.date.slice(0, 7);
        if (!months.has(month)) months.set(month, { month, incomeCents: 0, expenseCents: 0 });
        const bucket = months.get(month);
        if (t.type === 'income') bucket.incomeCents += t.amount_cents;
        else bucket.expenseCents += t.amount_cents;
    }

    return [...months.values()]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((m) => ({ ...m, netCents: m.incomeCents - m.expenseCents }));
}

// Collapses "SQ *BLUE BOTTLE #4412" and "SQ *BLUE BOTTLE #9981" onto one key so
// the same merchant isn't treated as a different payee every month.
function merchantKey(description) {
    return normalizeDescription(description)
        .replace(/\b(?:x{2,}|\*+)?\d{3,}\b/g, ' ')       // card/order numbers
        .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ') // embedded dates
        .replace(/^(?:sq|tst|sp|pos|ach|pmt|recur|autopay)\s*\*?\s*/i, '')
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .slice(0, 3)
        .join(' ');
}

const PERIODS = [
    { name: 'weekly', days: 7, tolerance: 2 },
    { name: 'biweekly', days: 14, tolerance: 3 },
    { name: 'monthly', days: 30.4, tolerance: 5 },
    { name: 'quarterly', days: 91.3, tolerance: 10 },
    { name: 'annual', days: 365.25, tolerance: 20 },
];

function daysBetween(a, b) {
    return Math.abs(Date.parse(b) - Date.parse(a)) / 86400000;
}

function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Find recurring charges: same merchant, roughly stable amount, roughly regular
 * interval, at least three occurrences.
 *
 * Three is the floor because two points always look periodic. Amount drift is
 * allowed (subscriptions raise prices) but reported, since a silent increase is
 * the thing a user most wants flagged.
 */
function detectRecurring(transactions, { minOccurrences = 3 } = {}) {
    const groups = new Map();

    for (const t of transactions) {
        if (t.type !== 'expense') continue;
        const key = merchantKey(t.description);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
    }

    const recurring = [];

    for (const [key, group] of groups) {
        if (group.length < minOccurrences) continue;

        const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
        const gaps = [];
        for (let i = 1; i < sorted.length; i++) {
            gaps.push(daysBetween(sorted[i - 1].date, sorted[i].date));
        }

        const medianGap = median(gaps);
        const period = PERIODS.find((p) => Math.abs(medianGap - p.days) <= p.tolerance);
        if (!period) continue;

        // Require most intervals to actually match the period, so a merchant
        // visited at random that happens to average ~30 days doesn't qualify.
        const consistent = gaps.filter((g) => Math.abs(g - period.days) <= period.tolerance * 1.5).length;
        if (consistent / gaps.length < 0.6) continue;

        const amounts = sorted.map((t) => t.amount_cents);
        const typicalCents = Math.round(median(amounts));
        const spread = Math.max(...amounts) - Math.min(...amounts);

        // Reject merchants whose amount varies wildly — that's a shop you visit
        // often, not a subscription.
        if (typicalCents > 0 && spread / typicalCents > 0.35) continue;

        const latest = sorted[sorted.length - 1];
        const first = sorted[0];

        recurring.push({
            merchant: latest.description,
            merchantKey: key,
            category: latest.category,
            cadence: period.name,
            occurrences: sorted.length,
            typicalCents,
            monthlyEquivalentCents: Math.round((typicalCents * 30.4) / period.days),
            firstSeen: first.date,
            lastSeen: latest.date,
            amountChanged: amounts[0] !== amounts[amounts.length - 1]
                ? { fromCents: amounts[0], toCents: amounts[amounts.length - 1] }
                : null,
        });
    }

    return recurring.sort((a, b) => b.monthlyEquivalentCents - a.monthlyEquivalentCents);
}

/**
 * Project the balance forward: known recurring charges land on their schedule,
 * everything else is modelled as a flat daily rate from recent discretionary spend.
 */
function forecast(transactions, { days = 30, asOf = null } = {}) {
    if (transactions.length === 0) {
        return { startingBalanceCents: 0, projectedBalanceCents: 0, recurringOutflowCents: 0, discretionaryOutflowCents: 0, expectedInflowCents: 0, days };
    }

    const { balanceCents } = summarize(transactions);
    const recurring = detectRecurring(transactions);

    const today = asOf || new Date().toISOString().slice(0, 10);
    const windowStart = new Date(Date.parse(today) - 90 * 86400000).toISOString().slice(0, 10);
    const recent = transactions.filter((t) => t.date >= windowStart && t.date <= today);
    const observedDays = Math.max(1, Math.min(90, recent.length > 0 ? daysBetween(recent[recent.length - 1].date, today) || 1 : 1));

    const recurringKeys = new Set(recurring.map((r) => r.merchantKey));
    const discretionaryCents = recent
        .filter((t) => t.type === 'expense' && !recurringKeys.has(merchantKey(t.description)))
        .reduce((sum, t) => sum + t.amount_cents, 0);

    const incomeCents = recent
        .filter((t) => t.type === 'income')
        .reduce((sum, t) => sum + t.amount_cents, 0);

    const recurringOutflowCents = Math.round(
        recurring.reduce((sum, r) => sum + (r.monthlyEquivalentCents * days) / 30.4, 0)
    );
    const discretionaryOutflowCents = Math.round((discretionaryCents / observedDays) * days);
    const expectedInflowCents = Math.round((incomeCents / observedDays) * days);

    return {
        startingBalanceCents: balanceCents,
        projectedBalanceCents: balanceCents + expectedInflowCents - recurringOutflowCents - discretionaryOutflowCents,
        recurringOutflowCents,
        discretionaryOutflowCents,
        expectedInflowCents,
        days,
    };
}

module.exports = {
    summarize,
    byCategory,
    monthlySeries,
    detectRecurring,
    merchantKey,
    forecast,
};
