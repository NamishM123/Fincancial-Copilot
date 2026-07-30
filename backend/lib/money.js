// Single conversion point between the dollars users type and the integer
// cents the database stores.

function toCents(value) {
    const n = typeof value === 'string' ? Number(value.replace(/[$,\s]/g, '')) : Number(value);
    if (!Number.isFinite(n)) return null;
    // Round rather than truncate: 19.99 * 100 is 1998.9999... in binary float.
    return Math.round(n * 100);
}

function fromCents(cents) {
    return Number((cents / 100).toFixed(2));
}

function formatCents(cents) {
    const sign = cents < 0 ? '-' : '';
    return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

module.exports = { toCents, fromCents, formatCents };
