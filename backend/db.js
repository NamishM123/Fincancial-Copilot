const sqlite3 = require('sqlite3');
const config = require('./config');

const db = new sqlite3.Database(config.databaseFile);

// sqlite3 is callback-based; everything downstream is async/await.
const run = (sql, params = []) =>
    new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });

const get = (sql, params = []) =>
    new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });

const all = (sql, params = []) =>
    new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

const exec = (sql) =>
    new Promise((resolve, reject) => {
        db.exec(sql, (err) => (err ? reject(err) : resolve()));
    });

const close = () =>
    new Promise((resolve, reject) => {
        db.close((err) => (err ? reject(err) : resolve()));
    });

// Amounts are integer cents everywhere. Storing money as REAL accumulates
// binary-float drift across sums and produces balances that don't reconcile.
const SCHEMA = `
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
        category TEXT NOT NULL,
        date TEXT NOT NULL,
        dedupe_hash TEXT NOT NULL,
        -- How the category was decided: 'user', 'model', 'rules', or 'abstain'.
        -- Kept so corrections can be told apart from the categoriser's own
        -- output when measuring how often it is wrong in practice.
        category_source TEXT NOT NULL DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    -- Every time a user overrides a predicted category we gain a real labeled
    -- example for a merchant they actually transact with, which is worth more
    -- than any row in the hand-authored training corpus.
    CREATE TABLE IF NOT EXISTS category_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        predicted_category TEXT,
        corrected_category TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_user_date
        ON transactions (user_id, date DESC, id DESC);

    -- Makes re-importing an overlapping CSV export a no-op instead of a duplicate.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_dedupe
        ON transactions (user_id, dedupe_hash);

    CREATE INDEX IF NOT EXISTS idx_corrections_user
        ON category_corrections (user_id, created_at DESC);
`;

async function init() {
    await exec(SCHEMA);
}

module.exports = { db, run, get, all, exec, close, init };
