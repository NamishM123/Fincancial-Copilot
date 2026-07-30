const crypto = require('crypto');

function normalizeDescription(text) {
    return String(text).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Identity of a transaction for duplicate-detection purposes.
 *
 * Deliberately excludes row position and insertion time so that importing an
 * overlapping bank statement twice is a no-op rather than a double entry.
 */
function dedupeHash({ date, description, amountCents, type }) {
    return crypto
        .createHash('sha256')
        .update([date, normalizeDescription(description), amountCents, type].join('|'))
        .digest('hex')
        .slice(0, 32);
}

module.exports = { normalizeDescription, dedupeHash };
