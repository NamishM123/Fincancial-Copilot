// Single conversion point between the dollars users type and the integer
// cents the database stores.

/**
 * Parse a user- or bank-supplied amount into integer cents.
 *
 * Returns null for anything unparseable so callers can distinguish "not a
 * number" from a legitimate zero. Negative results are meaningful: CSV import
 * uses the sign to decide income vs expense.
 */
function toCents(value) {
    if (value === null || value === undefined) return null;

    let text = String(value).trim();
    if (text === '') return null;

    // Accounting exports write negatives in parentheses: (45.00).
    let negative = false;
    if (/^\(.*\)$/.test(text)) {
        negative = true;
        text = text.slice(1, -1);
    }

    text = text.replace(/[$£€,\s]/g, '');

    if (text.startsWith('-')) {
        negative = !negative;
        text = text.slice(1);
    } else if (text.startsWith('+')) {
        text = text.slice(1);
    }

    const match = text.match(/^(\d*)(?:\.(\d+))?$/);
    if (!match) return null;

    const [, wholePart, fractionPart] = match;
    if (wholePart === '' && !fractionPart) return null;

    // Parse the decimal digits directly instead of computing `value * 100`.
    // Multiplying goes through binary floating point, where 1.005 is stored as
    // slightly less than 1.005 and rounds down to 100 cents instead of 101.
    const whole = wholePart === '' ? 0 : Number(wholePart);
    if (!Number.isSafeInteger(whole)) return null;

    const fraction = fractionPart || '';
    let cents = whole * 100 + Number((fraction + '00').slice(0, 2));

    // Half-up on the third decimal place.
    if (fraction.length > 2 && Number(fraction[2]) >= 5) cents += 1;

    return negative ? -cents : cents;
}

function fromCents(cents) {
    return Number((cents / 100).toFixed(2));
}

function formatCents(cents) {
    const sign = cents < 0 ? '-' : '';
    return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

module.exports = { toCents, fromCents, formatCents };
