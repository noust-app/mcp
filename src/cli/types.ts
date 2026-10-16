// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

export type OriginMode = 'add' | 'replace' | 'missing_mode' | 'invalid_both';

/**
 * Raw command-line options parsed from process arguments.
 */
export interface CliOptions {
    workspacePath?: string;
    allowedOrigins?: string[];
    originMode?: OriginMode;
    showHelp: boolean;
    showVersion: boolean;
}

/**
 * Result of validating the CLI arguments.
 */
export interface CliValidationResult {
    isValid: boolean;
    errorMessage?: string;
    resolvedWorkspacePath?: string;
    resolvedAllowedOrigins?: string[];
    resolvedOriginMode?: 'add' | 'replace';
}

/**
 * Runtime configuration for the MCP server instance.
 */
export interface McpServerConfig {
    workspacePath: string;
    serverName: string;
    serverVersion: string;
    allowedOrigins?: string[];
    originMode?: 'add' | 'replace';
}
