#!/usr/bin/env node
// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import { parseCliArgs, validateCliOptions, printHelp, printVersion, SERVER_NAME, SERVER_VERSION } from '../cli/args.js';
import { runServer } from '../server.js';
import type { McpServerConfig } from '../cli/types.js';

/**
 * CLI binary entrypoint for noust-mcp.
 */
async function main(): Promise<void> {
    const rawArgs = process.argv.slice(2);
    const parsedOptions = parseCliArgs(rawArgs);

    if (parsedOptions.showHelp) {
        printHelp();
        process.exit(0);
    }

    if (parsedOptions.showVersion) {
        printVersion();
        process.exit(0);
    }

    const validation = validateCliOptions(parsedOptions);
    if (!validation.isValid) {
        console.error(`[Error] ${validation.errorMessage}`);
        printHelp();
        process.exit(1);
    }

    const config: McpServerConfig = {
        workspacePath: validation.resolvedWorkspacePath!,
        serverName: SERVER_NAME,
        serverVersion: SERVER_VERSION,
        allowedOrigins: validation.resolvedAllowedOrigins,
        originMode: validation.resolvedOriginMode
    };

    await runServer(config);
}

main().catch((err) => {
    console.error('[Noust MCP] Fatal startup error:', err);
    process.exit(1);
});
