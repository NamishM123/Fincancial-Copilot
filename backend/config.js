require('dotenv').config();

const isTest = process.env.NODE_ENV === 'test';

// Fail fast rather than silently signing tokens with a guessable secret.
function requireSecret() {
    const secret = process.env.JWT_SECRET;

    if (!secret || secret.length < 32) {
        if (isTest) return 'test-secret-not-for-production-use-only-32b';

        console.error(
            '\nFATAL: JWT_SECRET is missing or shorter than 32 characters.\n' +
            'Generate one with:  npm run gen-secret\n' +
            'then put it in backend/.env as JWT_SECRET=<value>\n'
        );
        process.exit(1);
    }

    return secret;
}

module.exports = {
    isTest,
    port: Number(process.env.PORT) || 3000,
    jwtSecret: requireSecret(),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    databaseFile: process.env.DATABASE_FILE || (isTest ? ':memory:' : 'finance.db'),
    // Comma-separated. Only needed when the frontend is served from a
    // different origin than the API; the default setup serves both together.
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    openai: {
        apiKey: process.env.OPENAI_API_KEY || null,
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        maxOutputTokens: Number(process.env.OPENAI_MAX_TOKENS) || 500,
    },
    limits: {
        chatMessageChars: 1000,
        transactionPageSize: 50,
        transactionPageSizeMax: 200,
        csvMaxRows: 5000,
        csvMaxBytes: 2 * 1024 * 1024,
    },
};
