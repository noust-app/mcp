// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import type { CliOptions, CliValidationResult } from './types.js';

export const SERVER_NAME = 'noust-mcp';
export const SERVER_VERSION = '1.0.0';

/**
 * Parses raw command line arguments into structured CliOptions.
 */
export function parseCliArgs(args: string[]): CliOptions {
    try {
        const { values, positionals } = parseArgs({
            args,
            options: {
                workspace: {
                    type: 'string',
                    short: 'w'
                },
                'allowed-origins': {
                    type: 'string'
                },
                add: {
                    type: 'boolean',
                    short: 'd',
                    default: false
                },
                replace: {
                    type: 'boolean',
                    short: 'r',
                    default: false
                },
                help: {
                    type: 'boolean',
                    short: 'h',
                    default: false
                },
                version: {
                    type: 'boolean',
                    short: 'v',
                    default: false
                }
            },
            allowPositionals: true
        });

        const workspacePath = values.workspace || (positionals.length > 0 ? positionals[0] : undefined);
        const allowedOriginsRaw = (values['allowed-origins'] as string | undefined) || process.env.NOUST_ALLOWED_ORIGINS;
        const allowedOrigins = allowedOriginsRaw
            ? allowedOriginsRaw.split(',').map(s => s.trim()).filter(Boolean)
            : undefined;

        const hasAdd = Boolean(values.add);
        const hasReplace = Boolean(values.replace);

        let originMode: CliOptions['originMode'];
        if (allowedOrigins && allowedOrigins.length > 0) {
            if (hasAdd && hasReplace) {
                originMode = 'invalid_both';
            } else if (hasReplace) {
                originMode = 'replace';
            } else {
                // Default to 'add' mode (-d) when allowed origins are provided without explicit -r
                originMode = 'add';
            }
        } else if (hasAdd || hasReplace) {
            originMode = hasAdd && hasReplace ? 'invalid_both' : (hasAdd ? 'add' : 'replace');
        }

        return {
            workspacePath,
            allowedOrigins,
            originMode,
            showHelp: Boolean(values.help),
            showVersion: Boolean(values.version)
        };
    } catch {
        // If unknown flags are encountered, return an option that will trigger help
        return {
            showHelp: true,
            showVersion: false
        };
    }
}

/**
 * Validates parsed CLI options and resolves the workspace directory.
 */
export function validateCliOptions(options: CliOptions): CliValidationResult {
    if (options.showHelp || options.showVersion) {
        return { isValid: true };
    }

    // Default to process.cwd() if --workspace is omitted
    const rawPath = (options.workspacePath && options.workspacePath.trim() !== '')
        ? options.workspacePath.trim()
        : process.cwd();
    const resolvedPath = path.resolve(process.cwd(), rawPath);

    let canonicalPath: string;
    try {
        if (!fs.existsSync(resolvedPath)) {
            return {
                isValid: false,
                errorMessage: `Directory does not exist: "${resolvedPath}"`
            };
        }

        canonicalPath = fs.realpathSync(resolvedPath);
        const stat = fs.statSync(canonicalPath);

        if (!stat.isDirectory()) {
            return {
                isValid: false,
                errorMessage: `Specified path is not a directory: "${canonicalPath}"`
            };
        }

        // Verify read access to the workspace folder
        fs.accessSync(canonicalPath, fs.constants.R_OK);
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'EACCES') {
            return {
                isValid: false,
                errorMessage: `Permission denied to access workspace directory: "${resolvedPath}"`
            };
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
            isValid: false,
            errorMessage: `Cannot access workspace directory "${resolvedPath}": ${message}`
        };
    }

    // Validate origin mode and options if specified
    if (options.originMode === 'invalid_both') {
        return {
            isValid: false,
            errorMessage: 'Cannot specify both -d (--add) and -r (--replace). Choose only one mode for allowed origins.'
        };
    }

    if (options.originMode === 'missing_mode') {
        return {
            isValid: false,
            errorMessage: 'When specifying --allowed-origins, you must choose either -d/--add (to add to default origins) or -r/--replace (to replace default origins).'
        };
    }

    if ((options.originMode === 'add' || options.originMode === 'replace') && (!options.allowedOrigins || options.allowedOrigins.length === 0)) {
        return {
            isValid: false,
            errorMessage: 'Flags -d (--add) or -r (--replace) require --allowed-origins <origins> to be specified.'
        };
    }

    const resolvedAllowedOrigins: string[] = [];
    if (options.allowedOrigins && options.allowedOrigins.length > 0) {
        for (const item of options.allowedOrigins) {
            try {
                const url = new URL(item);
                if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                    return {
                        isValid: false,
                        errorMessage: `Invalid origin "${item}": Only http:// and https:// protocols are permitted.`
                    };
                }
                resolvedAllowedOrigins.push(url.origin.toLowerCase());
            } catch {
                return {
                    isValid: false,
                    errorMessage: `Invalid origin URL format: "${item}". Expected format like "https://example.com" or "http://localhost:3000".`
                };
            }
        }
    }

    return {
        isValid: true,
        resolvedWorkspacePath: canonicalPath,
        resolvedAllowedOrigins: resolvedAllowedOrigins.length > 0 ? resolvedAllowedOrigins : undefined,
        resolvedOriginMode: options.originMode === 'add' || options.originMode === 'replace' ? options.originMode : undefined
    };
}

/**
 * Prints CLI usage instructions to standard error to prevent JSON-RPC pollution.
 */
export function printHelp(): void {
    console.error(`
Noust Model Context Protocol (MCP) Server
Version: ${SERVER_VERSION}

Usage:
  noust-mcp --workspace <path-to-workspace-folder> [options]
  noust-mcp -w <path-to-workspace-folder> [options]

Options:
  -w, --workspace <path>           Path to the linked local workspace directory (default: current directory)
      --allowed-origins <origins>  Comma-separated list of allowed browser origins
  -d, --add                        Add specified origins to default whitelist (default mode)
  -r, --replace                    Replace default whitelist with specified origins
  -h, --help                       Display this help message
  -v, --version                    Display server version

Examples:
  noust-mcp --workspace ~/Documents/NoustExports
  noust-mcp -w ~/Documents/NoustExports --allowed-origins http://localhost:5173 -d
  noust-mcp -w ~/Documents/NoustExports --allowed-origins https://staging.noust.app -d
  noust-mcp -w ~/Documents/NoustExports --allowed-origins https://internal.corp -r
`);
}

/**
 * Prints the server version.
 */
export function printVersion(): void {
    console.error(`${SERVER_NAME} v${SERVER_VERSION}`);
}
