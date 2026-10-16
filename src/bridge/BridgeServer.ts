// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFile, unlink, chmod, appendFile, mkdir, stat, readFile } from 'node:fs/promises';
import { unlinkSync, existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve as pathResolve, dirname, basename, relative, isAbsolute } from 'node:path';
import type { WorkspaceReader } from '../workspace/WorkspaceReader.js';
import {
    DEFAULT_BRIDGE_HOST,
    DEFAULT_BRIDGE_PORT,
    type BridgeActionRequest,
    type BridgeActionResponse,
    type ClientHelloPayload,
    type ClientMessage,
    type ClientWorkspaceChangedPayload,
    type McpActionType,
    type ServerHelloPayload
} from './types.js';

export interface BridgeHealthResponse {
    status?: string;
    service?: string;
    version?: string;
    workspacePath?: string;
    connectedClients?: number;
}

export interface BridgeActionHttpResponse<R = unknown> {
    success: boolean;
    result?: R;
    error?: string;
}

export interface BridgeServerOptions {
    host?: string;
    port?: number;
    workspacePath: string;
    serverVersion?: string;
    reader?: WorkspaceReader;
    allowedOrigins?: string[];
    originMode?: 'add' | 'replace';
}

export interface ConnectedClientMeta {
    ws: WebSocket;
    workspaceId: string;
    workspaceName: string;
    folderName?: string;
    directoryPath?: string;
    token?: string;
    activeDomainId?: string | number | null;
    authenticated: boolean;
    connectedAt: number;
    lastSeenAt: number;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timer: NodeJS.Timeout;
    ws: WebSocket;
}

interface AliveWebSocket extends WebSocket {
    isAlive?: boolean;
}

export interface RejectedConnectionInfo {
    timestamp: number;
    reason: 'missing_token' | 'invalid_token' | 'disallowed_origin' | 'disallowed_host';
    origin?: string;
    clientWorkspaceId?: string;
    clientWorkspaceName?: string;
    clientFolderName?: string;
}

/**
 * BridgeServer provides a local WebSocket server bound strictly to localhost
 * for real-time bidirectional communication between Noust-MCP and the Noust browser client.
 */
export class BridgeServer {
    public static readonly MAX_PAYLOAD_SIZE = 10 * 1024 * 1024; // 10MB limit

    private readonly host: string;
    private readonly port: number;
    private readonly workspacePath: string;
    private readonly serverVersion: string;
    private readonly reader?: WorkspaceReader;
    private readonly allowedOrigins?: string[];
    private readonly originMode?: 'add' | 'replace';

    private httpServer: HttpServer | null = null;
    private wss: WebSocketServer | null = null;
    private clients: Map<WebSocket, ConnectedClientMeta> = new Map();
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private bridgeToken: string | null = null;
    private tokenFilePath: string | null = null;
    private workspaceTokens: Map<string, string> = new Map();
    private exitHandler: (() => void) | null = null;
    private isRunning: boolean = false;
    private isProxyMode: boolean = false;
    private proxyHasConnectedClients: boolean = false;
    private proxyPollTimer: NodeJS.Timeout | null = null;
    private lastRejection: RejectedConnectionInfo | null = null;
    private totalConnectionsAttempted: number = 0;

    constructor(options: BridgeServerOptions) {
        this.host = options.host || DEFAULT_BRIDGE_HOST;
        this.port = options.port || DEFAULT_BRIDGE_PORT;
        this.workspacePath = options.workspacePath;
        this.serverVersion = options.serverVersion || '1.0.0';
        this.reader = options.reader;
        this.allowedOrigins = options.allowedOrigins;
        this.originMode = options.originMode;
    }

    /**
     * Checks whether an Origin header is permitted to prevent Cross-Site WebSocket Hijacking (CSWSH).
     * Strictly rejects opaque / null origins (sandboxed iframes, data URIs) and rejects wildcard subdomains.
     */
    private isOriginAllowed(originHeader?: string): boolean {
        // Local CLI tools, curl, or Node scripts without an Origin header are permitted
        if (originHeader === undefined) {
            return true;
        }

        // Security: Opaque origins ('null' or empty) from sandboxed iframes or data: URLs MUST be rejected
        if (!originHeader || originHeader === 'null' || originHeader.trim() === '') {
            return false;
        }

        try {
            const url = new URL(originHeader);
            const hostname = url.hostname.toLowerCase();
            const protocol = url.protocol.toLowerCase();
            const fullOrigin = url.origin.toLowerCase();

            const isCustomMatched = Boolean(
                this.allowedOrigins &&
                this.allowedOrigins.length > 0 &&
                this.allowedOrigins.includes(fullOrigin)
            );

            // In replace mode (-r), ONLY user-specified origins are allowed
            if (this.originMode === 'replace') {
                return isCustomMatched;
            }

            // In add mode (-d) or if custom matched:
            if (isCustomMatched) {
                return true;
            }

            // Default strict whitelist:
            // Strictly allow only the official noust.app root domain over https (NO wildcards *.noust.app).
            // For local development, specify explicit origin via --allowed-origins (e.g. --allowed-origins http://localhost:5173 -d).
            if (hostname === 'noust.app') {
                return protocol === 'https:';
            }

            return false;
        } catch {
            return false;
        }
    }

    /**
     * Checks whether the Host header matches localhost or 127.0.0.1 (Item B: Anti-DNS Rebinding).
     */
    private isHostAllowed(hostHeader?: string): boolean {
        if (!hostHeader) return false;
        const normalized = hostHeader.toLowerCase().trim();
        const allowedHosts = [
            `localhost:${this.port}`,
            `localhost.local:${this.port}`,
            `127.0.0.1:${this.port}`,
            `[::1]:${this.port}`,
            'localhost',
            'localhost.local',
            '127.0.0.1',
            '[::1]'
        ];
        return allowedHosts.includes(normalized);
    }

    /**
     * Automatically appends an ephemeral file pattern to .git/info/exclude if the workspace is a Git repository.
     * Prevents git status from showing the ephemeral security token as untracked without modifying public .gitignore.
     */
    private async ensureGitExclude(pattern: string, targetDir?: string): Promise<void> {
        const baseDir = targetDir || this.workspacePath;
        try {
            const gitPath = join(baseDir, '.git');
            if (!existsSync(gitPath)) return;

            let infoExcludePath = join(gitPath, 'info', 'exclude');
            const fileStat = await stat(gitPath);

            // If .git is a file (e.g. Git worktree or submodule), resolve gitdir pointer
            if (fileStat.isFile()) {
                const content = readFileSync(gitPath, 'utf-8');
                const match = content.match(/^gitdir:\s*(.+)$/m);
                if (match) {
                    const resolvedGitDir = pathResolve(baseDir, match[1].trim());
                    infoExcludePath = join(resolvedGitDir, 'info', 'exclude');
                }
            }

            if (existsSync(infoExcludePath)) {
                const existing = readFileSync(infoExcludePath, 'utf-8');
                const lines = existing.split('\n').map((l) => l.trim());
                if (!lines.includes(pattern)) {
                    const toAppend = (existing.endsWith('\n') || existing === '' ? '' : '\n') + `${pattern}\n`;
                    await appendFile(infoExcludePath, toAppend, 'utf-8');
                }
            } else {
                const infoDir = dirname(infoExcludePath);
                if (!existsSync(infoDir)) {
                    await mkdir(infoDir, { recursive: true });
                }
                await writeFile(infoExcludePath, `# Locally excluded files for Git\n${pattern}\n`, 'utf-8');
            }
        } catch {
            // Silently ignore if git metadata cannot be accessed or written
        }
    }

    /**
     * Sanitizes a client-provided folder name to prevent Path Traversal attacks.
     * Rejects empty names, navigation tokens ('..'), and path separators ('/' or '\').
     */
    private sanitizeFolderName(raw?: string): string | undefined {
        if (!raw || typeof raw !== 'string') return undefined;
        const trimmed = raw.trim();
        if (!trimmed || trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
            return undefined;
        }
        return trimmed;
    }

    /**
     * Ensures an ephemeral .noust-bridge.token exists in the specified workspace directory
     * and registers it in the local workspaceTokens map.
     * Strictly verifies directory containment against the authorized workspace root to prevent Path Traversal.
     */
    public async ensureDirectoryToken(dirPath: string): Promise<string> {
        let canonicalPath: string;
        try {
            canonicalPath = existsSync(dirPath) ? realpathSync(dirPath) : pathResolve(dirPath);
        } catch {
            canonicalPath = pathResolve(dirPath);
        }

        // Security (Item 2): Prevent Path Traversal and arbitrary token file creation outside authorized workspace root
        let rootCanonical: string;
        try {
            rootCanonical = existsSync(this.workspacePath) ? realpathSync(this.workspacePath) : pathResolve(this.workspacePath);
        } catch {
            rootCanonical = pathResolve(this.workspacePath);
        }

        const rel = relative(rootCanonical, canonicalPath);
        const isContained = canonicalPath === rootCanonical || (!rel.startsWith('..') && !isAbsolute(rel));
        if (!isContained) {
            throw new Error(`Access denied: Directory "${dirPath}" resolves outside authorized workspace root "${this.workspacePath}".`);
        }

        const existingInMemory = this.workspaceTokens.get(canonicalPath);
        if (existingInMemory) {
            return existingInMemory;
        }

        const tokenPath = join(canonicalPath, '.noust-bridge.token');
        let token: string | undefined;

        if (existsSync(tokenPath)) {
            try {
                const content = (await readFile(tokenPath, 'utf-8')).trim();
                if (content.length >= 32) {
                    token = content;
                }
            } catch {}
        }

        if (!token) {
            token = randomBytes(32).toString('hex');
            try {
                await writeFile(tokenPath, token, {
                    mode: 0o600,
                    encoding: 'utf-8'
                });
                try {
                    await chmod(tokenPath, 0o600);
                } catch {}
                await this.ensureGitExclude('.noust-bridge.token', canonicalPath);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[Noust MCP Bridge] Warning: Could not write security token to "${tokenPath}": ${message}`);
            }
        }

        this.workspaceTokens.set(canonicalPath, token);
        this.setupExitHandler();
        return token;
    }

    /**
     * Registers a process exit listener to synchronously remove ephemeral token files on termination.
     */
    private setupExitHandler(): void {
        if (!this.exitHandler) {
            this.exitHandler = () => {
                this.cleanupTokenFilesSync();
            };
            process.on('exit', this.exitHandler);
        }
    }

    /**
     * Synchronously removes all ephemeral .noust-bridge.token files created by this instance.
     * Invoked during process 'exit' to ensure no orphan token files remain on disk.
     */
    private cleanupTokenFilesSync(): void {
        const filePaths = new Set<string>();
        if (this.tokenFilePath) {
            filePaths.add(this.tokenFilePath);
        }
        for (const dir of this.workspaceTokens.keys()) {
            filePaths.add(join(dir, '.noust-bridge.token'));
        }

        for (const filePath of filePaths) {
            try {
                if (existsSync(filePath)) {
                    unlinkSync(filePath);
                }
            } catch {}
        }

        this.tokenFilePath = null;
        this.workspaceTokens.clear();
    }

    /**
     * Starts the HTTP and WebSocket bridge server as Primary, or connects to an existing local Hub in Proxy Mode.
     */
    async start(): Promise<void> {
        if (this.isRunning) return;

        try {
            await this.startAsPrimary();
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr?.code === 'EADDRINUSE') {
                const connected = await this.tryConnectToExistingHub();
                if (connected) {
                    console.error(`[Noust MCP Bridge] Connected to existing local Hub on ${this.host}:${this.port} (Proxy Mode).`);
                    return;
                }
                console.error(`[Noust MCP Bridge] Port ${this.port} is in use by an unrecognized process. Live bridge is disabled; running in offline/file-only mode.`);
                this.isRunning = false;
                return;
            }
            throw err;
        }
    }

    /**
     * Starts the Primary Bridge HTTP and WebSocket server on the configured port.
     */
    private startAsPrimary(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const server = createServer((req, res) => {
                this.handleHttpRequest(req, res);
            });

            server.on('error', (err: NodeJS.ErrnoException) => {
                reject(err);
            });

            const wss = new WebSocketServer({
                noServer: true,
                maxPayload: BridgeServer.MAX_PAYLOAD_SIZE
            });

            server.on('upgrade', (req: IncomingMessage, socket, head) => {
                // Anti-DNS Rebinding check (Item B)
                if (!this.isHostAllowed(req.headers.host)) {
                    console.error(`[Noust MCP Bridge] Rejected connection with unauthorized Host header: ${req.headers.host}`);
                    this.lastRejection = { timestamp: Date.now(), reason: 'disallowed_host' };
                    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                    socket.destroy();
                    return;
                }

                // CSWSH Origin check
                const origin = req.headers.origin;
                if (!this.isOriginAllowed(origin)) {
                    console.error(`[Noust MCP Bridge] Rejected connection from unauthorized origin: ${origin}`);
                    this.lastRejection = { timestamp: Date.now(), reason: 'disallowed_origin', origin };
                    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                    socket.destroy();
                    return;
                }

                wss.handleUpgrade(req, socket, head, (ws) => {
                    wss.emit('connection', ws, req);
                });
            });

            wss.on('connection', (ws: AliveWebSocket) => {
                this.handleConnection(ws);
            });

            server.listen(this.port, this.host, async () => {
                this.httpServer = server;
                this.wss = wss;
                this.isRunning = true;
                this.isProxyMode = false;

                // Security: Ensure ephemeral shared-secret token in workspace directory
                this.bridgeToken = await this.ensureDirectoryToken(this.workspacePath);
                this.tokenFilePath = join(this.workspacePath, '.noust-bridge.token');
                console.error(`[Noust MCP Bridge] Ephemeral security token active for ${this.tokenFilePath}`);

                this.startHeartbeat();
                console.error(`[Noust MCP Bridge] Live WebSocket bridge listening on ${this.host}:${this.port}`);
                resolve();
            });
        });
    }

    /**
     * Handles local HTTP requests (health check and action dispatching for secondary MCP instances).
     */
    private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
        // Socket timeout protection against slowloris / hanging connections (Item 4)
        req.setTimeout(10000, () => {
            if (!res.headersSent) {
                res.writeHead(408, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Request Timeout' }));
            }
            req.destroy();
        });

        const url = req.url ? new URL(req.url, `http://${this.host}:${this.port}`) : null;
        const pathname = url ? url.pathname : req.url;

        // Anti-DNS Rebinding (Item B)
        if (!this.isHostAllowed(req.headers.host)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden: Unauthorized host');
            return;
        }

        // CSWSH / Anti-CSRF Origin check
        const origin = req.headers.origin;
        if (origin !== undefined && !this.isOriginAllowed(origin)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden: Unauthorized origin');
            return;
        }

        // Handle CORS Preflight if invoked from browser
        if (req.method === 'OPTIONS') {
            if (origin && this.isOriginAllowed(origin)) {
                res.writeHead(204, {
                    'Access-Control-Allow-Origin': origin,
                    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Max-Age': '86400'
                });
                res.end();
                return;
            }
            res.writeHead(403);
            res.end();
            return;
        }

        // Health check endpoint (Item A)
        if (req.method === 'GET' && pathname === '/health') {
            const originHeader = origin && this.isOriginAllowed(origin) ? origin : undefined;
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };
            if (originHeader) {
                headers['Access-Control-Allow-Origin'] = originHeader;
            }
            res.writeHead(200, headers);
            res.end(JSON.stringify({
                status: 'ok',
                service: 'noust-mcp-bridge',
                version: this.serverVersion,
                workspacePath: this.workspacePath,
                connectedClients: this.getConnectedClients().length
            }));
            return;
        }

        // Action dispatch endpoint (used by secondary MCP instances / peers)
        if (req.method === 'POST' && pathname === '/action') {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Unauthorized: Missing or invalid Authorization header' }));
                return;
            }

            const token = authHeader.slice(7).trim();
            if (!this.bridgeToken) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Server security token not initialized' }));
                return;
            }

            // Security: Byte-length check and try/catch block against multi-byte DoS exceptions (Item 1)
            let isTokenValid = false;
            try {
                const tokenBuf = Buffer.from(token, 'utf-8');
                if (this.bridgeToken) {
                    const expectedBuf = Buffer.from(this.bridgeToken, 'utf-8');
                    if (tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf)) {
                        isTokenValid = true;
                    }
                }
                if (!isTokenValid) {
                    for (const registeredToken of this.workspaceTokens.values()) {
                        const expectedBuf = Buffer.from(registeredToken, 'utf-8');
                        if (tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf)) {
                            isTokenValid = true;
                            break;
                        }
                    }
                }
            } catch {
                isTokenValid = false;
            }

            if (!isTokenValid) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid bridge token' }));
                return;
            }

            let isAborted = false;
            const chunks: Buffer[] = [];
            let size = 0;
            const MAX_BODY_BYTES = BridgeServer.MAX_PAYLOAD_SIZE;

            req.on('data', (chunk: Buffer) => {
                if (isAborted) return;
                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    isAborted = true;
                    if (!res.headersSent) {
                        res.writeHead(413, {
                            'Content-Type': 'application/json',
                            'Connection': 'close'
                        });
                        res.end(JSON.stringify({ success: false, error: 'Payload Too Large' }));
                    }
                    req.resume(); // Drain and discard remaining bytes cleanly
                    return;
                }
                chunks.push(chunk);
            });

            req.on('error', () => {
                isAborted = true;
            });

            req.on('end', async () => {
                if (isAborted) return;

                const originHeader = origin && this.isOriginAllowed(origin) ? origin : undefined;
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json'
                };
                if (originHeader) {
                    headers['Access-Control-Allow-Origin'] = originHeader;
                }

                const raw = Buffer.concat(chunks).toString('utf-8');
                let body: Record<string, unknown>;
                try {
                    body = JSON.parse(raw);
                } catch {
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload' }));
                    return;
                }

                if (typeof body !== 'object' || body === null || Array.isArray(body)) {
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({ success: false, error: 'Request body must be a JSON object' }));
                    return;
                }

                const { action, payload, timeoutMs, targetWorkspace } = body;

                if (!action || typeof action !== 'string' || !action.trim()) {
                    res.writeHead(400, headers);
                    res.end(JSON.stringify({ success: false, error: 'Missing or invalid required field: action' }));
                    return;
                }

                // Security: sanitize timeoutMs between 100ms and 60000ms (default 5000ms) (Item 8)
                const sanitizedTimeoutMs =
                    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000
                        ? Math.floor(timeoutMs)
                        : 5000;

                const sanitizedTargetWorkspace =
                    typeof targetWorkspace === 'string' && targetWorkspace.trim().length > 0
                        ? targetWorkspace.trim()
                        : undefined;

                try {
                    const result = await this.dispatchAction(action.trim() as McpActionType, payload, sanitizedTimeoutMs, sanitizedTargetWorkspace);
                    res.writeHead(200, headers);
                    res.end(JSON.stringify({ success: true, result }));
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    res.writeHead(500, headers);
                    res.end(JSON.stringify({ success: false, error: message }));
                }
            });
            return;
        }

        // Default 404
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Noust MCP Bridge');
    }

    /**
     * Attempts to connect to an existing local Primary Hub in Proxy Mode.
     */
    private async tryConnectToExistingHub(): Promise<boolean> {
        try {
            const res = await fetch(`http://${this.host}:${this.port}/health`, {
                signal: AbortSignal.timeout(1500)
            });
            if (!res.ok) return false;
            const data = (await res.json()) as BridgeHealthResponse;
            if (data?.service !== 'noust-mcp-bridge') return false;

            // Load existing token from disk if available
            const tokenPath = join(this.workspacePath, '.noust-bridge.token');
            if (existsSync(tokenPath)) {
                this.bridgeToken = readFileSync(tokenPath, 'utf-8').trim();
            }

            this.proxyHasConnectedClients = typeof data.connectedClients === 'number' && data.connectedClients > 0;
            this.isProxyMode = true;
            this.isRunning = true;
            this.startProxyPolling();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Polls the Primary Hub health periodically to keep proxyHasConnectedClients accurate (Item 3).
     */
    private startProxyPolling(): void {
        if (this.proxyPollTimer) clearInterval(this.proxyPollTimer);
        this.proxyPollTimer = setInterval(async () => {
            if (!this.isProxyMode || !this.isRunning) return;
            try {
                const res = await fetch(`http://${this.host}:${this.port}/health`, {
                    signal: AbortSignal.timeout(1500)
                });
                if (res.ok) {
                    const data = (await res.json()) as BridgeHealthResponse;
                    if (data?.service === 'noust-mcp-bridge') {
                        this.proxyHasConnectedClients = typeof data.connectedClients === 'number' && data.connectedClients > 0;
                    } else {
                        this.proxyHasConnectedClients = false;
                    }
                } else {
                    this.proxyHasConnectedClients = false;
                }
            } catch {
                this.proxyHasConnectedClients = false;
            }
        }, 5000);
        this.proxyPollTimer.unref();
    }

    /**
     * Dispatches an action via HTTP to the Primary Bridge Hub when in Proxy Mode.
     */
    private async dispatchActionViaProxy<T, R>(
        action: McpActionType,
        payload: T,
        timeoutMs: number = 5000,
        targetWorkspace?: string
    ): Promise<R> {
        if (!this.bridgeToken) {
            const tokenPath = join(this.workspacePath, '.noust-bridge.token');
            if (existsSync(tokenPath)) {
                this.bridgeToken = readFileSync(tokenPath, 'utf-8').trim();
            }
        }

        if (!this.bridgeToken) {
            throw new Error(
                'Noust bridge security token not found on disk. Ensure the primary Noust MCP instance is running.'
            );
        }

        try {
            const res = await fetch(`http://${this.host}:${this.port}/action`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.bridgeToken}`
                },
                body: JSON.stringify({
                    action,
                    payload,
                    timeoutMs,
                    targetWorkspace
                }),
                signal: AbortSignal.timeout(timeoutMs + 2000)
            });

            const data = (await res.json()) as BridgeActionHttpResponse<R>;
            if (!res.ok || !data.success) {
                if (data?.error && data.error.includes('not connected')) {
                    this.proxyHasConnectedClients = false;
                }
                throw new Error(data?.error || `Action dispatch failed with HTTP status ${res.status}`);
            }

            this.proxyHasConnectedClients = true;
            return data.result as R;
        } catch (err: unknown) {
            // If primary hub disconnected, attempt to promote this instance to Primary
            const errCode = (err as { code?: string; cause?: { code?: string } })?.code
                || (err as { cause?: { code?: string } })?.cause?.code;
            if (errCode === 'ECONNREFUSED') {
                console.error(`[Noust MCP Bridge] Primary Hub disconnected. Attempting to promote to Primary...`);
                const promoted = await this.tryPromoteToPrimary();
                if (promoted) {
                    return this.dispatchAction(action, payload, timeoutMs);
                }
            }
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to dispatch action '${action}' via local bridge: ${message}`);
        }
    }

    /**
     * Promotes this instance to Primary Server if the port becomes available.
     */
    private async tryPromoteToPrimary(): Promise<boolean> {
        const previousProxyMode = this.isProxyMode;
        const previousRunning = this.isRunning;
        this.isProxyMode = false;
        this.isRunning = false;
        try {
            await this.startAsPrimary();
            if (this.proxyPollTimer) {
                clearInterval(this.proxyPollTimer);
                this.proxyPollTimer = null;
            }
            return true;
        } catch {
            // Restore previous proxy state if promotion failed (Item 6)
            this.isProxyMode = previousProxyMode;
            this.isRunning = previousRunning;
            return false;
        }
    }

    private startHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

        // Ping connected sockets every 30 seconds to detect dead connections
        this.heartbeatTimer = setInterval(() => {
            for (const [ws, meta] of this.clients.entries()) {
                const aliveWs = ws as AliveWebSocket;
                if (aliveWs.isAlive === false) {
                    console.error(`[Noust MCP Bridge] Terminating inactive zombie connection (workspace: ${meta.workspaceName})`);
                    this.clients.delete(ws);
                    ws.terminate();
                    continue;
                }

                aliveWs.isAlive = false;
                try {
                    ws.ping();
                } catch {
                    this.clients.delete(ws);
                    ws.terminate();
                }
            }
        }, 30000);
    }

    private handleConnection(ws: AliveWebSocket): void {
        this.totalConnectionsAttempted++;
        ws.isAlive = true;

        const meta: ConnectedClientMeta = {
            ws,
            workspaceId: 'unknown',
            workspaceName: 'unknown',
            authenticated: false,
            connectedAt: Date.now(),
            lastSeenAt: Date.now()
        };
        this.clients.set(ws, meta);

        ws.on('pong', () => {
            ws.isAlive = true;
            meta.lastSeenAt = Date.now();
        });

        ws.on('message', (data: Buffer | string) => {
            ws.isAlive = true;
            meta.lastSeenAt = Date.now();
            void this.handleMessage(ws, data);
        });

        ws.on('close', () => {
            this.clients.delete(ws);
            // Fast-fail any pending requests waiting on this specific closing socket (Item 3)
            for (const [id, pending] of this.pendingRequests.entries()) {
                if (pending.ws === ws) {
                    clearTimeout(pending.timer);
                    this.pendingRequests.delete(id);
                    pending.reject(new Error('Browser client disconnected before completing action.'));
                }
            }
        });

        ws.on('error', (err) => {
            console.error('[Noust MCP Bridge] WebSocket error:', err.message);
            this.clients.delete(ws);
            for (const [id, pending] of this.pendingRequests.entries()) {
                if (pending.ws === ws) {
                    clearTimeout(pending.timer);
                    this.pendingRequests.delete(id);
                    pending.reject(new Error(`Browser client connection error: ${err.message}`));
                }
            }
        });
    }

    private async handleMessage(ws: WebSocket, rawData: Buffer | string): Promise<void> {
        try {
            const message = JSON.parse(rawData.toString()) as ClientMessage;
            const meta = this.clients.get(ws);

            // Security: Reject any message from unauthenticated clients except 'client:hello' (Item 2)
            if (!meta || (!meta.authenticated && (!('type' in message) || message.type !== 'client:hello'))) {
                console.error('[Noust MCP Bridge] Rejected message from unauthenticated WebSocket client.');
                this.clients.delete(ws);
                try {
                    ws.send(JSON.stringify({
                        type: 'server:error',
                        error: 'Unauthorized: Complete handshake with client:hello first'
                    }));
                    ws.close(4001, 'Unauthorized');
                } catch {}
                return;
            }

            if ('type' in message) {
                if (message.type === 'client:hello') {
                    const clientHello = message as ClientHelloPayload;
                    const meta = this.clients.get(ws);

                    const received = typeof clientHello.token === 'string' ? clientHello.token.trim() : '';
                    if (!received) {
                        this.lastRejection = {
                            timestamp: Date.now(),
                            reason: 'missing_token',
                            clientWorkspaceId: clientHello.workspaceId,
                            clientWorkspaceName: clientHello.workspaceName,
                            clientFolderName: clientHello.folderName
                        };
                        console.error('[Noust MCP Bridge] Unauthorized: client supplied missing security token.');
                        this.clients.delete(ws);
                        try {
                            ws.send(JSON.stringify({
                                type: 'server:error',
                                error: 'Unauthorized: Missing bridge token. Ensure File System Sync is active for this workspace folder.'
                            }));
                            ws.close(4001, 'Unauthorized');
                        } catch {}
                        return;
                    }

                    // Zero-Trust Workspace Token Authentication:
                    // Validate that the token belongs strictly to the requested workspace folder
                    let matchedDirectory: string | undefined;

                    let rootCanonical: string;
                    try {
                        rootCanonical = existsSync(this.workspacePath) ? realpathSync(this.workspacePath) : pathResolve(this.workspacePath);
                    } catch {
                        rootCanonical = pathResolve(this.workspacePath);
                    }
                    const rootFolderName = basename(rootCanonical).toLowerCase();
                    const cleanFolderName = this.sanitizeFolderName(clientHello.folderName);
                    const hasRawFolderName = Boolean(clientHello.folderName && typeof clientHello.folderName === 'string' && clientHello.folderName.trim() !== '');

                    // Candidate 1: The root workspace directory served by this MCP server instance
                    // Matches if folderName was omitted, or if the sanitized folderName matches the root workspace folder's name.
                    // If the client provided a folderName that failed sanitization (e.g. contains '..'), it MUST NOT match Candidate 1.
                    if (!hasRawFolderName || (cleanFolderName && cleanFolderName.toLowerCase() === rootFolderName)) {
                        const rootToken = this.bridgeToken || await this.ensureDirectoryToken(rootCanonical);
                        try {
                            const receivedBuf = Buffer.from(received, 'utf-8');
                            const expectedBuf = Buffer.from(rootToken, 'utf-8');
                            if (receivedBuf.length === expectedBuf.length && timingSafeEqual(receivedBuf, expectedBuf)) {
                                matchedDirectory = rootCanonical;
                            }
                        } catch {}
                    }

                    // Candidate 2: Subfolder within this.workspacePath (e.g. multi-workspace setup)
                    if (!matchedDirectory && cleanFolderName) {
                        const localCandidate = join(this.workspacePath, cleanFolderName);
                        if (existsSync(localCandidate)) {
                            try {
                                const stat = statSync(localCandidate);
                                if (stat.isDirectory()) {
                                    const canonicalCandidate = realpathSync(localCandidate);
                                    // Verify candidate is strictly contained within authorized workspace root
                                    const rel = relative(rootCanonical, canonicalCandidate);
                                    if (!rel.startsWith('..') && !isAbsolute(rel)) {
                                        const candidateToken = await this.ensureDirectoryToken(canonicalCandidate);
                                        const receivedBuf = Buffer.from(received, 'utf-8');
                                        const expectedBuf = Buffer.from(candidateToken, 'utf-8');
                                        if (receivedBuf.length === expectedBuf.length && timingSafeEqual(receivedBuf, expectedBuf)) {
                                            matchedDirectory = canonicalCandidate;
                                        }
                                    }
                                }
                            } catch {}
                        }
                    }

                    // Candidate 3: Registered workspace tokens where folder basename matches
                    if (!matchedDirectory && cleanFolderName) {
                        for (const [dir, expectedToken] of this.workspaceTokens.entries()) {
                            if (basename(dir).toLowerCase() === cleanFolderName.toLowerCase()) {
                                try {
                                    const receivedBuf = Buffer.from(received, 'utf-8');
                                    const expectedBuf = Buffer.from(expectedToken, 'utf-8');
                                    if (receivedBuf.length === expectedBuf.length && timingSafeEqual(receivedBuf, expectedBuf)) {
                                        matchedDirectory = dir;
                                        break;
                                    }
                                } catch {}
                            }
                        }
                    }

                    // Zero-Trust Security Enforcement: Reject immediately if no directory matched the supplied token
                    if (!matchedDirectory) {
                        this.lastRejection = {
                            timestamp: Date.now(),
                            reason: 'invalid_token',
                            clientWorkspaceId: clientHello.workspaceId,
                            clientWorkspaceName: clientHello.workspaceName,
                            clientFolderName: clientHello.folderName
                        };
                        console.error(`[Noust MCP Bridge] Unauthorized: Client "${clientHello.workspaceName}" (${clientHello.workspaceId}) provided an invalid security token for folder "${clientHello.folderName || 'root'}".`);
                        this.clients.delete(ws);
                        try {
                            ws.send(JSON.stringify({
                                type: 'server:error',
                                error: 'Unauthorized: Invalid bridge token for workspace folder. Ensure File System Sync is linked to the folder containing this workspace.'
                            }));
                            ws.close(4001, 'Unauthorized');
                        } catch {}
                        return;
                    }

                    this.lastRejection = null;

                    if (meta) {
                        meta.authenticated = true;
                        meta.token = received;
                        meta.workspaceId = clientHello.workspaceId;
                        meta.workspaceName = clientHello.workspaceName;
                        meta.folderName = cleanFolderName;
                        meta.directoryPath = matchedDirectory;
                        meta.activeDomainId = clientHello.activeDomainId;
                    }

                    // Send server:hello response
                    const serverHello: ServerHelloPayload = {
                        type: 'server:hello',
                        status: 'connected',
                        workspacePath: matchedDirectory || this.workspacePath,
                        serverVersion: this.serverVersion
                    };
                    ws.send(JSON.stringify(serverHello));
                    return;
                }

                if (message.type === 'client:workspace_changed') {
                    const changed = message as ClientWorkspaceChangedPayload;
                    const meta = this.clients.get(ws);
                    if (meta && meta.authenticated) {
                        meta.workspaceId = changed.workspaceId;
                        meta.workspaceName = changed.workspaceName;
                        meta.folderName = this.sanitizeFolderName(changed.folderName) || (changed.folderName ? undefined : meta.folderName);
                        meta.activeDomainId = changed.activeDomainId;
                    }
                    return;
                }
            }

            if ('id' in message && 'success' in message) {
                const response = message as BridgeActionResponse;
                const pending = this.pendingRequests.get(response.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingRequests.delete(response.id);
                    if (response.success) {
                        pending.resolve(response.result);
                    } else {
                        pending.reject(new Error(response.error || 'Action failed in browser client'));
                    }
                }
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[Noust MCP Bridge] Failed to parse client message:', message);
        }
    }

    /**
     * Checks if any authenticated browser client is connected.
     */
    isConnected(): boolean {
        if (this.isProxyMode) {
            return this.isRunning && this.proxyHasConnectedClients;
        }
        for (const meta of this.clients.values()) {
            if (meta.authenticated && meta.ws.readyState === WebSocket.OPEN) {
                return true;
            }
        }
        return false;
    }

    /**
     * Returns metadata for all connected authenticated clients.
     */
    getConnectedClients(): ConnectedClientMeta[] {
        return Array.from(this.clients.values()).filter(
            c => c.authenticated && c.ws.readyState === WebSocket.OPEN
        );
    }

    /**
     * Returns unique connected workspaces deduplicated by workspaceId,
     * picking the most recently active connection for each workspace.
     */
    getUniqueConnectedWorkspaces(): ConnectedClientMeta[] {
        const unique = new Map<string, ConnectedClientMeta>();
        for (const c of this.getConnectedClients()) {
            const existing = unique.get(c.workspaceId);
            if (!existing || c.lastSeenAt > existing.lastSeenAt) {
                unique.set(c.workspaceId, c);
            }
        }
        return Array.from(unique.values());
    }


    /**
     * Inspects the current state of the workspace directory, bridge socket, and connection history
     * to provide a clear, actionable diagnostic for agents and users when live mutations are unavailable.
     */
    async getConnectionDiagnostic(): Promise<string> {
        // 1. Check offline .noust workspace file existence in directory
        if (this.reader) {
            try {
                const files = await this.reader.listWorkspaceFiles();
                if (files.length === 0) {
                    return `No .noust workspace file found in the current directory. ` +
                        `Ensure that your workspace folder has a synchronized .noust file or specify the workspace explicitly.`;
                }
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return `Cannot access workspace directory: ${message}`;
            }
        }

        // 2. Check if bridge server is running
        if (!this.isRunning) {
            return `Local WebSocket bridge is not running (port ${this.port} may be in use by another process).`;
        }

        // 3. Check if browser client is connected and authenticated
        if (this.isConnected()) {
            return `Noust WebSocket bridge is connected and active.`;
        }

        // 4. Check recent handshake rejections (within 10 minutes)
        const REJECTION_TTL_MS = 10 * 60 * 1000;
        const recentRejection = this.lastRejection && (Date.now() - this.lastRejection.timestamp < REJECTION_TTL_MS)
            ? this.lastRejection
            : null;

        if (recentRejection) {
            if (recentRejection.reason === 'missing_token') {
                const wsInfo = recentRejection.clientWorkspaceName 
                    ? ` (active workspace in browser: "${recentRejection.clientWorkspaceName}")`
                    : '';
                return `Noust is open in the browser${wsInfo} with MCP enabled, but the connection was rejected because NO security token was provided.\n` +
                    `• Root Cause: The browser only transmits the security token (.noust-bridge.token) when File System Sync is configured for the workspace folder.\n` +
                    `• Action Required:\n` +
                    `  1. In Noust, open the Workspaces menu.\n` +
                    `  2. Configure 'File System Sync' and link it to your workspace folder.\n` +
                    `  Once linked, Noust will automatically create the security token and reconnect to the MCP bridge.`;
            }

            if (recentRejection.reason === 'invalid_token') {
                const wsInfo = recentRejection.clientWorkspaceName 
                    ? ` for workspace "${recentRejection.clientWorkspaceName}"`
                    : '';
                return `Noust attempted to connect from the browser${wsInfo}, but provided an invalid or unverified security token.\n` +
                    `• Action Required: Verify that File System Sync in Noust is linked to the folder containing this workspace's .noust file. Once confirmed, Noust will automatically re-establish the connection.`;
            }

            if (recentRejection.reason === 'disallowed_origin') {
                return `A browser connection from "${recentRejection.origin}" was rejected because the origin is not whitelisted.\n` +
                    `• Action Required: If running Noust on a custom host/port, add it to your MCP configuration args using --allowed-origins "${recentRejection.origin}".`;
            }

            if (recentRejection.reason === 'disallowed_host') {
                return `A connection was rejected due to an invalid Host header (anti-DNS rebinding).`;
            }
        }

        // 5. Default fallback: No connection attempts received
        return `Noust application is not connected via WebSocket bridge (ws://${this.host}:${this.port}).\n` +
            `• Probable Causes:\n` +
            `  1. Noust is not open in your browser.\n` +
            `  2. The MCP toggle is disabled in Noust (Settings > Behavior > Workspace > MCP Bridge).\n` +
            `  3. File System Sync is not active for the workspace folder.\n` +
            `• Action Required:\n` +
            `  - Open Noust in your browser, ensure MCP is enabled in Settings > Behavior > Workspace, and link File System Sync to your workspace folder. The browser connects automatically in the background.`;
    }

    /**
     * Dispatches an action request to the matching Noust browser client and awaits the result.
     * 1. If targetWorkspace is explicitly specified, routes to the matching workspace tab.
     * 2. If omitted and a local .noust file exists in the directory, presumes and routes to that local workspace.
     * 3. If omitted and no local .noust file exists in the directory:
     *    - If exactly 1 workspace is connected, routes to it.
     *    - If multiple workspaces are connected, halts and requires disambiguation.
     */
    async dispatchAction<T, R>(
        action: McpActionType,
        payload: T,
        timeoutMs: number = 5000,
        targetWorkspace?: string
    ): Promise<R> {
        if (this.isProxyMode) {
            return this.dispatchActionViaProxy<T, R>(action, payload, timeoutMs, targetWorkspace);
        }

        if (!this.isConnected()) {
            const diagnostic = await this.getConnectionDiagnostic();
            throw new Error(diagnostic);
        }

        // Determine expected workspaceId from reader if a local .noust file exists
        let expectedWorkspaceId: string | undefined;
        let expectedWorkspaceName: string | undefined;
        if (this.reader) {
            try {
                const wsData = await this.reader.readWorkspace();
                expectedWorkspaceId = typeof wsData.workspaceId === 'string' ? wsData.workspaceId : undefined;
                expectedWorkspaceName = typeof wsData.workspaceName === 'string' ? wsData.workspaceName : undefined;
            } catch {
                // If offline file cannot be read or no file exists locally, proceed without local anchor
            }
        }

        // Filter authenticated and open clients
        const activeClients = Array.from(this.clients.values()).filter(
            c => c.authenticated && c.ws.readyState === WebSocket.OPEN
        );
        if (activeClients.length === 0) {
            throw new Error('All authenticated connections to Noust client are closed.');
        }

        const uniqueWorkspaces = this.getUniqueConnectedWorkspaces();
        let targetMeta: ConnectedClientMeta | undefined;

        // 1. Explicit target workspace provided by user/agent (by ID, case-insensitive name, or folder path)
        if (targetWorkspace && targetWorkspace.trim() !== '') {
            const cleanTarget = targetWorkspace.trim().toLowerCase();
            const rawTarget = targetWorkspace.trim();
            let targetPath: string | undefined;
            let targetToken: string | undefined;

            let canonicalBase: string;
            try {
                canonicalBase = existsSync(this.workspacePath) ? realpathSync(this.workspacePath) : pathResolve(this.workspacePath);
            } catch {
                canonicalBase = pathResolve(this.workspacePath);
            }

            const candidatePaths = [
                rawTarget,
                join(this.workspacePath, rawTarget),
                join(canonicalBase, rawTarget)
            ];

            for (const cand of candidatePaths) {
                if (existsSync(cand)) {
                    try {
                        const candidateRealPath = realpathSync(cand);
                        const rel = relative(canonicalBase, candidateRealPath);
                        if (candidateRealPath === canonicalBase || (!rel.startsWith('..') && !isAbsolute(rel))) {
                            targetPath = candidateRealPath;
                            targetToken = await this.ensureDirectoryToken(targetPath);
                            break;
                        }
                    } catch {}
                }
            }

            const targetFolderName = targetPath ? basename(targetPath).toLowerCase() : undefined;

            const matching = activeClients.filter(c => {
                if (targetPath) {
                    // Strict directory and token routing: target refers to a specific workspace directory
                    if (c.directoryPath && c.directoryPath === targetPath) {
                        return true;
                    }
                    if (targetFolderName && c.folderName && c.folderName.toLowerCase() === targetFolderName) {
                        if (targetToken && c.token) {
                            try {
                                const tBuf = Buffer.from(targetToken, 'utf-8');
                                const cBuf = Buffer.from(c.token, 'utf-8');
                                if (tBuf.length === cBuf.length && timingSafeEqual(tBuf, cBuf)) {
                                    c.directoryPath = targetPath;
                                    return true;
                                }
                            } catch {}
                        }
                        return false;
                    }
                    // When targeting a directory on disk, reject clients that do not match the directory or token
                    return false;
                }

                // Target is a workspace ID or workspace display name (not a filesystem directory)
                if (c.workspaceId.toLowerCase() === cleanTarget) return true;
                if (c.workspaceName.toLowerCase() === cleanTarget) return true;
                if (c.folderName && c.folderName.toLowerCase() === cleanTarget) return true;
                return false;
            });
            if (matching.length > 0) {
                matching.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
                targetMeta = matching[0];
            } else {
                const available = uniqueWorkspaces.map(w => `"${w.workspaceName}" (${w.workspaceId})`).join(', ');
                throw new Error(
                    `Target workspace "${targetWorkspace}" is not active or connected in the browser. Available workspaces: [${available || 'none'}].`
                );
            }
        } else if (expectedWorkspaceId) {
            // 2. Default to local workspace if a .noust file exists in the directory
            let canonicalBase: string;
            try {
                canonicalBase = existsSync(this.workspacePath) ? realpathSync(this.workspacePath) : pathResolve(this.workspacePath);
            } catch {
                canonicalBase = pathResolve(this.workspacePath);
            }
            const matching = activeClients.filter(c =>
                c.workspaceId === expectedWorkspaceId ||
                (c.directoryPath && (c.directoryPath === this.workspacePath || c.directoryPath === canonicalBase)) ||
                (expectedWorkspaceName && c.workspaceName.trim().toLowerCase() === expectedWorkspaceName.trim().toLowerCase() && (!c.workspaceId || c.workspaceId === expectedWorkspaceId))
            );
            if (matching.length > 0) {
                matching.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
                targetMeta = matching[0];
            } else {
                const otherTab = activeClients[0];
                throw new Error(
                    `Noust is connected in the browser, but viewing workspace "${otherTab.workspaceName}" (${otherTab.workspaceId}). ` +
                    `This MCP server is bound to workspace "${expectedWorkspaceName || 'local'}" (${expectedWorkspaceId}). ` +
                    `Please switch to the matching workspace tab in Noust or specify 'workspace: "${otherTab.workspaceName}"'.`
                );
            }
        } else {
            // 3. No local .noust file in directory and no workspace explicitly specified
            if (uniqueWorkspaces.length === 1) {
                // Exactly one unique workspace active: safely use it
                targetMeta = uniqueWorkspaces[0];
            } else if (uniqueWorkspaces.length > 1) {
                // Multiple unique workspaces active: require disambiguation!
                const available = uniqueWorkspaces.map(w => `"${w.workspaceName}" (${w.workspaceId})`).join(', ');
                throw new Error(
                    `Multiple workspaces are currently active in the browser: [${available}], and no local .noust file exists in the current directory. ` +
                    `Please specify the target workspace name or ID using the 'workspace' parameter.`
                );
            } else {
                activeClients.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
                targetMeta = activeClients[0];
            }
        }

        const targetWs = targetMeta.ws;
        const id = randomUUID();
        const request: BridgeActionRequest<T> = {
            id,
            action,
            payload
        };

        return new Promise<R>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Action '${action}' timed out after ${timeoutMs}ms without response from Noust.`));
            }, timeoutMs);

            this.pendingRequests.set(id, {
                resolve: (val: unknown) => resolve(val as R),
                reject,
                timer,
                ws: targetWs
            });
            targetWs.send(JSON.stringify(request), (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pendingRequests.delete(id);
                    reject(new Error(`Failed to send action '${action}' to Noust: ${err.message}`));
                }
            });
        });
    }

    /**
     * Stops the bridge server and terminates all active connections.
     * Deletes the ephemeral token file from disk.
     */
    async stop(): Promise<void> {
        if (this.isProxyMode) {
            if (this.proxyPollTimer) {
                clearInterval(this.proxyPollTimer);
                this.proxyPollTimer = null;
            }
            this.isRunning = false;
            this.isProxyMode = false;
            this.proxyHasConnectedClients = false;
            return;
        }

        if (!this.isRunning && !this.httpServer) return;

        if (this.exitHandler) {
            process.removeListener('exit', this.exitHandler);
            this.exitHandler = null;
        }

        // Collect and asynchronously remove all ephemeral token files created by this server session
        const filePaths = new Set<string>();
        if (this.tokenFilePath) {
            filePaths.add(this.tokenFilePath);
        }
        for (const dir of this.workspaceTokens.keys()) {
            filePaths.add(join(dir, '.noust-bridge.token'));
        }

        for (const filePath of filePaths) {
            try {
                await unlink(filePath);
            } catch {
                // Ignore if already deleted
            }
        }

        this.tokenFilePath = null;
        this.workspaceTokens.clear();

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        // Reject any pending requests
        for (const [id, pending] of this.pendingRequests.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Bridge server is shutting down.'));
        }
        this.pendingRequests.clear();

        for (const [ws] of this.clients.entries()) {
            try {
                ws.terminate();
            } catch {
                // Ignore
            }
        }
        this.clients.clear();

        return new Promise<void>((resolve) => {
            if (this.wss) {
                this.wss.close();
                this.wss = null;
            }
            if (this.httpServer) {
                this.httpServer.close(() => {
                    this.httpServer = null;
                    this.isRunning = false;
                    resolve();
                });
            } else {
                this.isRunning = false;
                resolve();
            }
        });
    }
}
