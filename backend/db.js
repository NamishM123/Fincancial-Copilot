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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_user_date
        ON transactions (user_id, date DESC, id DESC);

    -- Makes re-importing an overlapping CSV export a no-op instead of a duplicate.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_dedupe
        ON transactions (user_id, dedupe_hash);
`;

async function init() {
    await exec(SCHEMA);
}

module.exports = { db, run, get, all, exec, close, init };
