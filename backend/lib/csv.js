const { toCents } = require('./money');
const { dedupeHash } = require('./dedupe');

// RFC 4180-ish parser. Small enough to own, and bank exports are the one place
// where quoting and embedded commas genuinely show up ("AMAZON MKTP, INC").
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    // Strip a UTF-8 BOM; Excel writes one and it corrupts the first header name.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    while (i < text.length) {
        const char = text[i];

        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i++;
                continue;
            }
            field += char;
            i++;
            continue;
        }

        if (char === '"') {
            inQuotes = true;
            i++;
        } else if (char === ',') {
            row.push(field);
            field = '';
            i++;
        } else if (char === '\r' && text[i + 1] === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            i += 2;
        } else if (char === '\n' || char === '\r') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            i++;
        } else {
            field += char;
            i++;
        }
    }

    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const HEADER_ALIASES = {
    date: ['date', 'transaction date', 'posted date', 'post date', 'posting date', 'trans date', 'time'],
    description: ['description', 'name', 'merchant', 'payee', 'memo', 'details', 'transaction', 'narrative'],
    amount: ['amount', 'transaction amount', 'value'],
    debit: ['debit', 'withdrawal', 'withdrawals', 'money out', 'paid out'],
    credit: ['credit', 'deposit', 'deposits', 'money in', 'paid in'],
    category: ['category', 'type of transaction'],
};

function normalizeHeader(h) {
    return h.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

// Banks disagree on everything. Map their header row onto our field names.
function detectColumns(headerRow) {
    const normalized = headerRow.map(normalizeHeader);
    const mapping = {};

    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        const index = normalized.findIndex((h) => aliases.includes(h));
        if (index !== -1) mapping[field] = index;
    }

    // Fall back to substring matching for headers like "Transaction Description".
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (mapping[field] !== undefined) continue;
        const index = normalized.findIndex((h) => aliases.some((a) => h.includes(a)));
        if (index !== -1) mapping[field] = index;
    }

    return mapping;
}

const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Returns ISO yyyy-mm-dd, or null. Ambiguous d/m vs m/d is resolved as US-first
// unless the first component is > 12, which only a day can be.
function parseDate(raw) {
    if (!raw) return null;
    const value = raw.trim();

    let m = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

    m = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
    if (m) {
        let [, a, b, y] = m.map(Number);
        if (y < 100) y += y < 70 ? 2000 : 1900;
        const [month, day] = a > 12 ? [b, a] : [a, b];
        return iso(y, month, day);
    }

    m = value.match(/^(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*[ -](\d{2,4})/);
    if (m) {
        let y = Number(m[3]);
        if (y < 100) y += y < 70 ? 2000 : 1900;
        const month = MONTHS[m[2].toLowerCase()];
        if (month) return iso(y, month, Number(m[1]));
    }

    m = value.match(/^([A-Za-z]{3})[A-Za-z]*[ -](\d{1,2}),?[ -](\d{2,4})/);
    if (m) {
        let y = Number(m[3]);
        if (y < 100) y += y < 70 ? 2000 : 1900;
        const month = MONTHS[m[1].toLowerCase()];
        if (month) return iso(y, month, Number(m[2]));
    }

    return null;
}

function iso(year, month, day) {
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
    const d = new Date(Date.UTC(year, month - 1, day));
    // Rejects 2024-02-31, which Date would silently roll into March.
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const CATEGORY_RULES = [
    [/uber|lyft|shell|chevron|exxon|gas|transit|metro|parking|bp |76 /i, 'Transportation'],
    [/grocery|safeway|kroger|trader joe|whole foods|aldi|costco|wegmans|publix/i, 'Food'],
    [/restaurant|cafe|coffee|starbucks|mcdonald|chipotle|pizza|doordash|grubhub|taco/i, 'Food'],
    [/netflix|spotify|hulu|disney|cinema|theater|steam|playstation|xbox/i, 'Entertainment'],
    [/electric|water|gas bill|internet|comcast|verizon|at&t|t-mobile|utility|sewer/i, 'Utilities'],
    [/amazon|target|walmart|ebay|etsy|best buy|shop|store|mall/i, 'Shopping'],
    [/pharmacy|cvs|walgreens|doctor|dental|medical|clinic|hospital|insurance/i, 'Healthcare'],
    [/tuition|university|college|school|course|udemy|coursera|book/i, 'Education'],
    [/payroll|salary|direct deposit|paycheck/i, 'Salary'],
    [/interest|dividend|vanguard|fidelity|schwab|robinhood/i, 'Investments'],
    [/freelance|invoice|consulting|upwork|fiverr/i, 'Freelance'],
];

// Deterministic baseline. Documented as such in the README so the accuracy
// number a classifier has to beat is an honest one.
function guessCategory(description, type) {
    for (const [pattern, category] of CATEGORY_RULES) {
        if (pattern.test(description)) {
            const isIncomeCategory = ['Salary', 'Investments', 'Freelance'].includes(category);
            if (isIncomeCategory === (type === 'income')) return category;
        }
    }
    return type === 'income' ? 'Other Income' : 'Other';
}

/**
 * Turn raw CSV text into transaction rows, reporting per-row failures instead
 * of throwing, so one malformed line doesn't sink a 400-row statement.
 */
function parseTransactionsCsv(text, { maxRows = 5000 } = {}) {
    const rows = parseCsv(text);
    if (rows.length < 2) {
        return { transactions: [], errors: [{ row: 0, message: 'File is empty or has no data rows' }], columns: {} };
    }

    const columns = detectColumns(rows[0]);
    const errors = [];

    if (columns.date === undefined) {
        return { transactions: [], errors: [{ row: 1, message: 'No date column found. Expected a header like "Date" or "Transaction Date".' }], columns };
    }
    if (columns.description === undefined) {
        return { transactions: [], errors: [{ row: 1, message: 'No description column found. Expected a header like "Description", "Merchant", or "Payee".' }], columns };
    }
    if (columns.amount === undefined && columns.debit === undefined && columns.credit === undefined) {
        return { transactions: [], errors: [{ row: 1, message: 'No amount column found. Expected "Amount", or separate "Debit"/"Credit" columns.' }], columns };
    }

    const transactions = [];
    const dataRows = rows.slice(1, maxRows + 1);

    dataRows.forEach((row, index) => {
        const rowNumber = index + 2; // 1-indexed, and the header is row 1.
        const cell = (i) => (i === undefined ? '' : (row[i] ?? '').trim());

        const date = parseDate(cell(columns.date));
        if (!date) {
            errors.push({ row: rowNumber, message: `Unrecognized date "${cell(columns.date)}"` });
            return;
        }

        const description = cell(columns.description);
        if (!description) {
            errors.push({ row: rowNumber, message: 'Missing description' });
            return;
        }

        let cents = null;
        let type = null;

        if (columns.debit !== undefined || columns.credit !== undefined) {
            const debit = toCents(cell(columns.debit));
            const credit = toCents(cell(columns.credit));
            if (debit) {
                cents = Math.abs(debit);
                type = 'expense';
            } else if (credit) {
                cents = Math.abs(credit);
                type = 'income';
            }
        }

        if (cents === null && columns.amount !== undefined) {
            // toCents keeps the sign, including for parenthesised negatives,
            // which is what tells us income from expense here.
            const parsed = toCents(cell(columns.amount));
            if (parsed !== null && parsed !== 0) {
                cents = Math.abs(parsed);
                type = parsed < 0 ? 'expense' : 'income';
            }
        }

        if (cents === null || cents === 0) {
            errors.push({ row: rowNumber, message: 'Missing or zero amount' });
            return;
        }

        // A category column in the file is the user's own labelling and wins.
        // Otherwise the caller categorises; parseTransactionsCsv stays free of
        // the model so it remains a pure parser.
        const explicitCategory = cell(columns.category);

        transactions.push({
            date,
            description: description.slice(0, 200),
            amountCents: cents,
            type,
            category: explicitCategory || null,
            dedupeHash: dedupeHash({ date, description, amountCents: cents, type }),
        });
    });

    if (rows.length - 1 > maxRows) {
        errors.push({ row: maxRows + 2, message: `File truncated at ${maxRows} rows` });
    }

    return { transactions, errors, columns };
}

module.exports = {
    parseCsv,
    parseDate,
    detectColumns,
    guessCategory,
    parseTransactionsCsv,
};
