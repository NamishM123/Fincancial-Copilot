const express = require('express');
const db = require('../db');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const { toCents } = require('../lib/money');
const { dedupeHash } = require('../lib/dedupe');
const { parseTransactionsCsv } = require('../lib/csv');
const { categorize } = require('../lib/categorize');
const analytics = require('../lib/analytics');

const router = express.Router();
router.use(authenticateToken);

const VALID_TYPES = ['income', 'expense'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build the WHERE clause shared by the list and count queries.
 *
 * Filters are composed here rather than in each caller so the two can never
 * disagree -- a count that does not match the rows it describes produces a
 * "Load more" button that lies about how much is left.
 */
function buildFilters(userId, query) {
    const clauses = ['user_id = ?'];
    const params = [userId];

    const search = (query.search || '').trim();
    if (search) {
        // LIKE with escaped wildcards: a user searching for "100%" should not
        // match everything.
        const escaped = search.replace(/[\\%_]/g, (c) => `\\${c}`);
        clauses.push("description LIKE ? ESCAPE '\\'");
        params.push(`%${escaped}%`);
    }

    if (query.category) {
        clauses.push('category = ?');
        params.push(String(query.category));
    }

    if (VALID_TYPES.includes(query.type)) {
        clauses.push('type = ?');
        params.push(query.type);
    }

    if (ISO_DATE_RE.test(query.start_date || '')) {
        clauses.push('date >= ?');
        params.push(query.start_date);
    }

    if (ISO_DATE_RE.test(query.end_date || '')) {
        clauses.push('date <= ?');
        params.push(query.end_date);
    }

    const minCents = toCents(query.min_amount);
    if (minCents !== null) {
        clauses.push('amount_cents >= ?');
        params.push(Math.abs(minCents));
    }

    const maxCents = toCents(query.max_amount);
    if (maxCents !== null) {
        clauses.push('amount_cents <= ?');
        params.push(Math.abs(maxCents));
    }

    return { where: clauses.join(' AND '), params };
}

// Whitelisted so the sort parameter can never reach SQL as user input.
const SORT_COLUMNS = {
    date: 'date',
    amount: 'amount_cents',
    description: 'description',
    category: 'category',
};

// Paginated and filterable. The previous unbounded query returned a user's
// entire history on every dashboard load, and there was no way to find a
// single transaction among hundreds.
router.get('/', async (req, res, next) => {
    const userId = req.user.userId;
    const limit = Math.min(
        Math.max(Number(req.query.limit) || config.limits.transactionPageSize, 1),
        config.limits.transactionPageSizeMax
    );
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const sortColumn = SORT_COLUMNS[req.query.sort] || 'date';
    const direction = String(req.query.order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    // id is the tiebreaker so pagination is stable when many rows share a date.
    const orderBy = `${sortColumn} ${direction}, id ${direction}`;

    const { where, params } = buildFilters(userId, req.query);

    try {
        const [rows, countRow] = await Promise.all([
            db.all(
                `SELECT * FROM transactions WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            ),
            db.get(`SELECT COUNT(*) AS total FROM transactions WHERE ${where}`, params),
        ]);

        res.json({
            transactions: rows,
            pagination: {
                total: countRow.total,
                limit,
                offset,
                hasMore: offset + rows.length < countRow.total,
            },
        });
    } catch (err) {
        next(err);
    }
});

/** Distinct categories actually present, for populating filter controls. */
router.get('/categories', async (req, res, next) => {
    try {
        const rows = await db.all(
            `SELECT category, type, COUNT(*) AS count
             FROM transactions WHERE user_id = ?
             GROUP BY category, type ORDER BY count DESC`,
            [req.user.userId]
        );
        res.json({ categories: rows });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    const userId = req.user.userId;
    const { description, amount, type, category, date } = req.body || {};

    if (!description || amount === undefined || !type || !date) {
        return res.status(400).json({ error: 'Description, amount, type, and date are all required' });
    }
    if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({ error: 'Type must be "income" or "expense"' });
    }
    if (!ISO_DATE_RE.test(date)) {
        return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format' });
    }

    const amountCents = toCents(amount);
    if (amountCents === null || amountCents <= 0) {
        return res.status(400).json({ error: 'Amount must be a number greater than 0' });
    }

    const desc = String(description).trim().slice(0, 200);

    // An explicit category from the user is authoritative; otherwise the
    // categoriser decides and records how it decided.
    let cat;
    let source;
    if (category && String(category).trim()) {
        cat = String(category).trim().slice(0, 60);
        source = 'user';
    } else {
        const predicted = categorize(desc, type);
        cat = predicted.category;
        source = predicted.source;
    }

    const hash = dedupeHash({ date, description: desc, amountCents, type });

    try {
        const result = await db.run(
            `INSERT INTO transactions
                (user_id, description, amount_cents, type, category, date, dedupe_hash, category_source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, desc, amountCents, type, cat, date, hash, source]
        );

        const created = await db.get('SELECT * FROM transactions WHERE id = ?', [result.lastID]);
        res.status(201).json({ transaction: created });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'An identical transaction already exists on that date' });
        }
        next(err);
    }
});

/**
 * Edit a transaction.
 *
 * Every field is optional; only what is sent changes. Editing any field that
 * feeds the dedupe hash means the hash has to be recomputed, or a later import
 * of the same row would no longer be recognised as a duplicate.
 */
router.put('/:id', async (req, res, next) => {
    const userId = req.user.userId;
    const { description, amount, type, category, date } = req.body || {};

    try {
        const existing = await db.get(
            'SELECT * FROM transactions WHERE id = ? AND user_id = ?',
            [req.params.id, userId]
        );
        if (!existing) return res.status(404).json({ error: 'Transaction not found' });

        const next_ = {
            description: existing.description,
            amountCents: existing.amount_cents,
            type: existing.type,
            category: existing.category,
            date: existing.date,
            categorySource: existing.category_source,
        };

        if (description !== undefined) {
            const trimmed = String(description).trim();
            if (!trimmed) return res.status(400).json({ error: 'Description cannot be empty' });
            next_.description = trimmed.slice(0, 200);
        }

        if (amount !== undefined) {
            const cents = toCents(amount);
            if (cents === null || cents <= 0) {
                return res.status(400).json({ error: 'Amount must be a number greater than 0' });
            }
            next_.amountCents = cents;
        }

        if (type !== undefined) {
            if (!VALID_TYPES.includes(type)) {
                return res.status(400).json({ error: 'Type must be "income" or "expense"' });
            }
            next_.type = type;
        }

        if (date !== undefined) {
            if (!ISO_DATE_RE.test(date)) {
                return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format' });
            }
            next_.date = date;
        }

        if (category !== undefined) {
            const trimmed = String(category).trim();
            if (!trimmed) return res.status(400).json({ error: 'Category cannot be empty' });
            next_.category = trimmed.slice(0, 60);
            next_.categorySource = 'user';
        } else if (type !== undefined && type !== existing.type) {
            // Switching income to expense leaves the old category in a label
            // space it no longer belongs to, so re-derive it.
            const predicted = categorize(next_.description, next_.type);
            next_.category = predicted.category;
            next_.categorySource = predicted.source;
        }

        const hash = dedupeHash({
            date: next_.date,
            description: next_.description,
            amountCents: next_.amountCents,
            type: next_.type,
        });

        await db.run(
            `UPDATE transactions
             SET description = ?, amount_cents = ?, type = ?, category = ?, date = ?,
                 dedupe_hash = ?, category_source = ?
             WHERE id = ? AND user_id = ?`,
            [next_.description, next_.amountCents, next_.type, next_.category, next_.date,
             hash, next_.categorySource, req.params.id, userId]
        );

        const updated = await db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
        res.json({ transaction: updated });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'Those changes would duplicate an existing transaction' });
        }
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        // The `user_id` predicate is the authorization check. Without it, any
        // logged-in user could delete any row by guessing an id.
        const result = await db.run(
            'DELETE FROM transactions WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.userId]
        );

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }
        res.json({ deleted: Number(req.params.id) });
    } catch (err) {
        next(err);
    }
});

/**
 * CSV import.
 *
 * Takes raw text rather than multipart: the browser reads the file locally and
 * posts its contents, which keeps the dependency list shorter and means the
 * same endpoint is trivially testable.
 */
router.post('/import', async (req, res, next) => {
    const userId = req.user.userId;
    const csvText = (req.body && req.body.csv) || '';

    if (typeof csvText !== 'string' || csvText.trim() === '') {
        return res.status(400).json({ error: 'No CSV content received' });
    }
    if (Buffer.byteLength(csvText, 'utf8') > config.limits.csvMaxBytes) {
        return res.status(413).json({ error: 'File is too large (limit 2 MB)' });
    }

    const { transactions, errors, columns } = parseTransactionsCsv(csvText, {
        maxRows: config.limits.csvMaxRows,
    });

    if (transactions.length === 0) {
        return res.status(400).json({
            error: errors[0] ? errors[0].message : 'No importable rows found',
            errors: errors.slice(0, 20),
            detectedColumns: columns,
        });
    }

    try {
        await db.run('BEGIN');
        let imported = 0;
        const sourceCounts = {};

        for (const t of transactions) {
            // The parser leaves category null unless the file carried one, so
            // categorisation happens here where the model lives.
            let category = t.category;
            let categorySource = 'user';
            if (!category) {
                const predicted = categorize(t.description, t.type);
                category = predicted.category;
                categorySource = predicted.source;
            }
            sourceCounts[categorySource] = (sourceCounts[categorySource] || 0) + 1;

            // INSERT OR IGNORE against the unique (user_id, dedupe_hash) index
            // makes re-importing an overlapping statement a no-op.
            const result = await db.run(
                `INSERT OR IGNORE INTO transactions
                    (user_id, description, amount_cents, type, category, date, dedupe_hash, category_source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, t.description, t.amountCents, t.type, category, t.date, t.dedupeHash, categorySource]
            );
            if (result.changes > 0) imported++;
        }

        await db.run('COMMIT');

        res.json({
            imported,
            duplicatesSkipped: transactions.length - imported,
            rowsFailed: errors.length,
            errors: errors.slice(0, 20),
            detectedColumns: columns,
            categorization: sourceCounts,
        });
    } catch (err) {
        await db.run('ROLLBACK').catch(() => {});
        next(err);
    }
});

async function loadAll(userId) {
    return db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC', [userId]);
}

router.get('/summary', async (req, res, next) => {
    try {
        const rows = await loadAll(req.user.userId);
        res.json({
            summary: analytics.summarize(rows),
            byCategory: analytics.byCategory(rows, 'expense'),
            monthly: analytics.monthlySeries(rows).slice(-12),
        });
    } catch (err) {
        next(err);
    }
});

router.get('/recurring', async (req, res, next) => {
    try {
        const rows = await loadAll(req.user.userId);
        res.json({ recurring: analytics.detectRecurring(rows) });
    } catch (err) {
        next(err);
    }
});

router.get('/forecast', async (req, res, next) => {
    try {
        const rows = await loadAll(req.user.userId);
        const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
        res.json({ forecast: analytics.forecast(rows, { days }) });
    } catch (err) {
        next(err);
    }
});

/**
 * Correct a transaction's category.
 *
 * Records the correction as training data as well as updating the row: a user
 * override is a real label for a merchant they actually transact with, which is
 * better evidence than anything in the hand-authored corpus.
 */
router.patch('/:id/category', async (req, res, next) => {
    const userId = req.user.userId;
    const category = req.body && req.body.category;

    if (!category || typeof category !== 'string' || !category.trim()) {
        return res.status(400).json({ error: 'A category is required' });
    }

    try {
        const existing = await db.get(
            'SELECT * FROM transactions WHERE id = ? AND user_id = ?',
            [req.params.id, userId]
        );
        if (!existing) return res.status(404).json({ error: 'Transaction not found' });

        const corrected = category.trim().slice(0, 60);

        if (corrected !== existing.category) {
            await db.run(
                `INSERT INTO category_corrections
                    (user_id, description, predicted_category, corrected_category)
                 VALUES (?, ?, ?, ?)`,
                [userId, existing.description, existing.category, corrected]
            );
        }

        await db.run(
            "UPDATE transactions SET category = ?, category_source = 'user' WHERE id = ? AND user_id = ?",
            [corrected, req.params.id, userId]
        );

        const updated = await db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
        res.json({ transaction: updated });
    } catch (err) {
        next(err);
    }
});

/**
 * How the categoriser is performing for this user, measured by how often they
 * had to override it. Held-out accuracy from the eval says how the model does
 * on unseen merchant names; this says how it does on their statement.
 */
router.get('/categorization-stats', async (req, res, next) => {
    const userId = req.user.userId;

    try {
        const [bySource, corrections] = await Promise.all([
            db.all(
                `SELECT category_source, COUNT(*) AS count
                 FROM transactions WHERE user_id = ? GROUP BY category_source`,
                [userId]
            ),
            db.get('SELECT COUNT(*) AS total FROM category_corrections WHERE user_id = ?', [userId]),
        ]);

        const autoCategorized = bySource
            .filter((r) => r.category_source !== 'user')
            .reduce((sum, r) => sum + r.count, 0);

        res.json({
            bySource: Object.fromEntries(bySource.map((r) => [r.category_source, r.count])),
            autoCategorized,
            corrections: corrections.total,
            // Only meaningful once there is something to divide by.
            observedAccuracy: autoCategorized > 0
                ? Math.max(0, 1 - corrections.total / autoCategorized)
                : null,
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
