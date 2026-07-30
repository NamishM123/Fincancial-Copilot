const app = require('./app');
const db = require('./db');
const config = require('./config');
const { trainOnCorrections } = require('./lib/categorize');

async function start() {
    await db.init();

    // Fold every category correction users have made back into the classifier.
    // These are real labels for merchants people actually transact with, so
    // they outweigh the hand-authored corpus.
    const corrections = await db.all(
        'SELECT description, corrected_category AS category FROM category_corrections ORDER BY created_at DESC LIMIT 5000'
    );
    trainOnCorrections(corrections);

    const server = app.listen(config.port, () => {
        console.log(`Finance Copilot listening on http://localhost:${config.port}`);
        console.log(`  database: ${config.databaseFile}`);
        console.log(`  assistant: ${config.openai.apiKey ? `${config.openai.model} (live)` : 'built-in analytics (no OPENAI_API_KEY set)'}`);
        console.log(`  categoriser: trained, +${corrections.length} user corrections`);
    });

    const shutdown = async (signal) => {
        console.log(`\n${signal} received, shutting down.`);
        server.close(async () => {
            await db.close().catch(() => {});
            process.exit(0);
        });
        // Don't hang forever on a stuck connection.
        setTimeout(() => process.exit(1), 10000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
