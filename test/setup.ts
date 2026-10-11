// Keep Powertools logs out of test output.
process.env.POWERTOOLS_LOG_LEVEL = 'SILENT';

// Metrics: dev mode writes EMF through the global console (so tests can spy on
// it) and would disable metrics; re-enable them explicitly.
process.env.POWERTOOLS_DEV = 'true';
process.env.POWERTOOLS_METRICS_DISABLED = 'false';
process.env.POWERTOOLS_METRICS_NAMESPACE = 'Test';
process.env.POWERTOOLS_SERVICE_NAME = 'ai-gateway';
