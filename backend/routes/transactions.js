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

// Paginated. The previous unbounded query returned a user's entire history on
// every dashboard load.
router.get('/', async (req, res, next) => {
    const userId = req.user.userId;
    const limit = Math.min(
        Math.max(Number(req.query.limit) || config.limits.transactionPageSize, 1),
        config.limits.transactionPageSizeMax
    );
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    try {
        const [rows, countRow] = await Promise.all([
            db.all(
                'SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ? OFFSET ?',
                [userId, limit, offset]
            ),
            db.get('SELECT COUNT(*) AS total FROM transactions WHERE user_id = ?', [userId]),
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
