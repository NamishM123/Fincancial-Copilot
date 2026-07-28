const app = require('./app');
const db = require('./db');
const config = require('./config');

async function start() {
    await db.init();

    const server = app.listen(config.port, () => {
        console.log(`Finance Copilot listening on http://localhost:${config.port}`);
        console.log(`  database: ${config.databaseFile}`);
        console.log(`  assistant: ${config.openai.apiKey ? `${config.openai.model} (live)` : 'built-in analytics (no OPENAI_API_KEY set)'}`);
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
