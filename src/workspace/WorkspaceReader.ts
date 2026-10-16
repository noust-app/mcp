// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type {
    NoustWorkspaceData,
    NoustDomain,
    NoustNote,
    NoustDocument,
    NoustObjective,
    NoustFlag,
    CachedWorkspace,
    WorkspaceReaderOptions
} from './types.js';
import { resolveNoteTarget } from './address.js';

const NOUS_UNENCRYPTED_VERSION = 1;
const MAX_DECOMPRESSED_METADATA_BYTES = 500 * 1024 * 1024; // 500MB safety ceiling against decompression bombs
const gunzipAsync = promisify(zlib.gunzip);

/**
 * Offline reader and parser for .noust workspace files with mtime-based in-memory caching.
 */
export class WorkspaceReader {
    private readonly workspaceDir: string;
    private readonly cache = new Map<string, CachedWorkspace>();
    private readonly inFlightReads = new Map<string, Promise<NoustWorkspaceData>>();
    private static readonly IO_RETRY_DELAY_MS = 500;
    private static readonly MAX_CACHE_ENTRIES = 20;

    constructor(options: WorkspaceReaderOptions) {
        this.workspaceDir = path.resolve(process.cwd(), options.workspaceDir);
    }

    /**
     * Returns the configured absolute workspace directory.
     */
    getWorkspaceDirectory(): string {
        return this.workspaceDir;
    }

    /**
     * Scans the workspace directory and returns absolute paths to all valid .noust files found.
     * Supports regular files and symbolic links pointing to valid .noust files.
     * Ignores hidden files (e.g. ._*.noust AppleDouble metadata).
     */
    async listWorkspaceFiles(): Promise<string[]> {
        try {
            const canonicalWorkspaceDir = await fs.promises.realpath(this.workspaceDir);
            const entries = await fs.promises.readdir(this.workspaceDir, { withFileTypes: true });
            const candidatePaths = entries
                .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && !entry.name.startsWith('.') && entry.name.endsWith('.noust'))
                .map((entry) => path.join(this.workspaceDir, entry.name));

            const validFiles: string[] = [];
            for (const filePath of candidatePaths) {
                try {
                    const canonicalFilePath = await fs.promises.realpath(filePath);
                    const relative = path.relative(canonicalWorkspaceDir, canonicalFilePath);
                    if (relative.startsWith('..') || path.isAbsolute(relative)) {
                        // Ignore symlinks pointing outside authorized workspace directory
                        continue;
                    }
                    const fileStat = await fs.promises.stat(canonicalFilePath);
                    if (fileStat.isFile()) {
                        validFiles.push(filePath);
                    }
                } catch {
                    // Ignore broken symlinks or inaccessible files
                }
            }

            return validFiles;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to list files in workspace directory "${this.workspaceDir}": ${message}`);
        }
    }

    /**
     * Resolves the primary/default .noust file in the workspace directory.
     * If multiple exist, selects the most recently modified file.
     */
    async getDefaultWorkspaceFile(): Promise<string> {
        const files = await this.listWorkspaceFiles();
        if (files.length === 0) {
            throw new Error(
                `No .noust workspace file found in "${this.workspaceDir}". Ensure the workspace has been exported to this directory.`
            );
        }

        if (files.length === 1) {
            return files[0];
        }

        // Multiple files: sort by mtime descending (most recent first)
        const stats = await Promise.all(
            files.map(async (filePath) => {
                const stat = await fs.promises.stat(filePath);
                return { filePath, mtimeMs: stat.mtimeMs };
            })
        );

        stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return stats[0].filePath;
    }

    /**
     * Reads and parses a .noust workspace file, serving from memory cache if mtime is unchanged.
     * Includes canonical realpath symlink protection and retry logic for in-flight browser writes.
     */
    async readWorkspace(targetFilePath?: string): Promise<NoustWorkspaceData> {
        const resolvedPath = targetFilePath
            ? path.resolve(this.workspaceDir, targetFilePath)
            : await this.getDefaultWorkspaceFile();

        // Security check: resolve canonical paths to prevent symlink traversal outside authorized directory
        const canonicalWorkspaceDir = await fs.promises.realpath(this.workspaceDir);
        let canonicalFilePath: string;
        try {
            canonicalFilePath = await fs.promises.realpath(resolvedPath);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Unable to resolve workspace file "${resolvedPath}": ${message}`);
        }

        // Security check 1: Strict extension boundary (only .noust files permitted)
        if (!canonicalFilePath.toLowerCase().endsWith('.noust')) {
            throw new Error(`Access denied: Only .noust files can be accessed ("${resolvedPath}").`);
        }

        // Security check 2: Strict canonical containment (prevent directory traversal and access outside authorized workspace)
        const relative = path.relative(canonicalWorkspaceDir, canonicalFilePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Access denied: File "${resolvedPath}" resolves outside authorized workspace directory.`);
        }

        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(canonicalFilePath);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Unable to access workspace file "${canonicalFilePath}": ${message}`);
        }

        // Check in-memory cache against mtime
        const cached = this.cache.get(canonicalFilePath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            return cached.data;
        }

        // Deduplicate concurrent in-flight reads for the same workspace file (Single-Flight)
        const existingInFlight = this.inFlightReads.get(canonicalFilePath);
        if (existingInFlight) {
            return await existingInFlight;
        }

        const readPromise = (async () => {
            // Read and parse file with concurrency retry handling
            try {
                return await this.readAndParseWithRetry(canonicalFilePath, stat.mtimeMs);
            } catch (err: unknown) {
                // Fallback to previous cached state if file is temporarily unreadable / being written
                if (cached) {
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(
                        `[Noust MCP] Warning: Workspace file is temporarily unreadable (${message}). Serving previous cached version.`
                    );
                    return cached.data;
                }
                throw err;
            }
        })().finally(() => {
            this.inFlightReads.delete(canonicalFilePath);
        });

        this.inFlightReads.set(canonicalFilePath, readPromise);
        return await readPromise;
    }

    /**
     * Reads and parses NOUS package from disk, retrying once after 500ms backoff if in-flight write is detected.
     */
    private async readAndParseWithRetry(canonicalFilePath: string, initialMtimeMs: number): Promise<NoustWorkspaceData> {
        const fileName = path.basename(canonicalFilePath);

        try {
            return await this.performParse(canonicalFilePath, initialMtimeMs);
        } catch (firstError: unknown) {
            // If the error suggests an incomplete/in-flight write (truncated or empty file), wait and retry
            await new Promise((resolve) => setTimeout(resolve, WorkspaceReader.IO_RETRY_DELAY_MS));

            try {
                const refreshedStat = await fs.promises.stat(canonicalFilePath);
                return await this.performParse(canonicalFilePath, refreshedStat.mtimeMs);
            } catch {
                // If retry also fails, bubble original error
                throw firstError;
            }
        }
    }

    /**
     * Unpacks an unencrypted unified binary NOUS workspace package.
     */
    private async unpackNousBuffer(buffer: Buffer, fileName: string): Promise<NoustWorkspaceData> {
        if (buffer.length < 9) {
            throw new Error(`Invalid .noust file structure in "${fileName}": payload too small.`);
        }

        const magic = buffer.subarray(0, 4).toString('utf-8');
        if (magic !== 'NOUS') {
            throw new Error(`Invalid .noust file structure in "${fileName}": missing NOUS magic header.`);
        }

        const version = buffer[4];
        if (version !== NOUS_UNENCRYPTED_VERSION) {
            throw new Error(
                `Workspace file "${fileName}" is password-protected with a custom password. Offline MCP access requires unencrypted workspace exports.`
            );
        }

        let pOffset = 5;
        const metadataSize = buffer.readUInt32LE(pOffset);
        pOffset += 4;

        if (pOffset + metadataSize > buffer.length) {
            throw new Error(`Corrupted .noust file structure in "${fileName}": metadata size exceeds buffer length.`);
        }

        const compressedMetadata = buffer.subarray(pOffset, pOffset + metadataSize);
        pOffset += metadataSize;

        const decompressed = await gunzipAsync(compressedMetadata, {
            maxOutputLength: MAX_DECOMPRESSED_METADATA_BYTES
        });
        const jsonStr = decompressed.toString('utf-8');
        const parsed: NoustWorkspaceData = JSON.parse(jsonStr);

        // Unpack Assets as raw Buffers (converted to Base64 on-demand in getAsset)
        const assets: Record<string, Buffer | string> = Object.create(null);
        if (pOffset + 4 <= buffer.length) {
            const assetCount = buffer.readUInt32LE(pOffset);
            pOffset += 4;
            const SAFE_HASH_REGEX = /^[a-zA-Z0-9_-]{16,128}$/;

            for (let i = 0; i < assetCount; i++) {
                if (pOffset + 1 > buffer.length) {
                    throw new Error(`Corrupted .noust file structure in "${fileName}": truncated asset entry header.`);
                }
                const hashLen = buffer[pOffset];
                pOffset += 1;
                if (pOffset + hashLen + 4 > buffer.length) {
                    throw new Error(`Corrupted .noust file structure in "${fileName}": truncated asset hash or size.`);
                }
                const hash = buffer.subarray(pOffset, pOffset + hashLen).toString('utf-8');
                pOffset += hashLen;

                if (!SAFE_HASH_REGEX.test(hash) || hash === '__proto__' || hash === 'constructor' || hash === 'prototype') {
                    throw new Error(`Corrupted .noust file structure in "${fileName}": invalid asset hash "${hash}".`);
                }

                const assetSize = buffer.readUInt32LE(pOffset);
                pOffset += 4;
                if (pOffset + assetSize > buffer.length) {
                    throw new Error(`Corrupted .noust file structure in "${fileName}": truncated asset binary data.`);
                }
                const assetBytes = buffer.subarray(pOffset, pOffset + assetSize);
                pOffset += assetSize;

                assets[hash] = assetBytes;
            }
        }

        parsed.assets = assets;
        return parsed;
    }

    private async performParse(canonicalFilePath: string, mtimeMs: number): Promise<NoustWorkspaceData> {
        const fileName = path.basename(canonicalFilePath);
        const fileBuffer = await fs.promises.readFile(canonicalFilePath);

        const parsed: NoustWorkspaceData = await this.unpackNousBuffer(fileBuffer, fileName);

        if (typeof parsed !== 'object' || parsed === null) {
            throw new Error(`Invalid .noust file structure in "${fileName}": expected a JSON object.`);
        }

        // Security check 3: Verify Noust workspace structural signature
        const hasValidSignature =
            (typeof parsed.workspaceId === 'string' && parsed.workspaceId.length > 0) ||
            Array.isArray(parsed.domains) ||
            typeof parsed.version === 'string';

        if (!hasValidSignature) {
            throw new Error(`Invalid workspace signature in "${fileName}": Missing expected Noust workspace structure.`);
        }

        // Normalize internal structures
        parsed.domains = Array.isArray(parsed.domains) ? parsed.domains : [];
        parsed.globalFreeTextDocs = Array.isArray(parsed.globalFreeTextDocs) ? parsed.globalFreeTextDocs : [];
        parsed.assets = typeof parsed.assets === 'object' && parsed.assets !== null ? parsed.assets : {};

        // Update in-memory cache with bounded size to prevent unbounded memory growth
        if (this.cache.size >= WorkspaceReader.MAX_CACHE_ENTRIES) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) {
                this.cache.delete(oldestKey);
            }
        }

        this.cache.set(canonicalFilePath, {
            filePath: canonicalFilePath,
            fileName,
            mtimeMs,
            data: parsed
        });

        return parsed;
    }

    /**
     * Clears cached workspace data.
     */
    invalidateCache(filePath?: string): void {
        if (filePath) {
            const resolved = path.resolve(this.workspaceDir, filePath);
            this.cache.delete(resolved);
            this.inFlightReads.delete(resolved);
            try {
                const canonical = fs.realpathSync(resolved);
                if (canonical !== resolved) {
                    this.cache.delete(canonical);
                    this.inFlightReads.delete(canonical);
                }
            } catch {
                // If file no longer exists or cannot be resolved, deletion of resolved is sufficient
            }
        } else {
            this.cache.clear();
            this.inFlightReads.clear();
        }
    }

    /**
     * Retrieves all notes across all domains in the active workspace.
     */
    async getAllNotes(targetFilePath?: string): Promise<NoustNote[]> {
        const workspace = await this.readWorkspace(targetFilePath);
        const notes: NoustNote[] = [];

        for (const domain of workspace.domains || []) {
            if (Array.isArray(domain.notes)) {
                for (const note of domain.notes) {
                    notes.push({
                        ...note,
                        domainId: note.domainId ?? domain.id,
                        domainTitle: domain.title
                    });
                }
            }
        }

        return notes;
    }

    /**
     * Finds a single note by its ID across all domains using system ID or domain-qualified human ID.
     */
    async getNoteById(noteId: string | number, targetFilePath?: string): Promise<NoustNote | null> {
        const workspace = await this.readWorkspace(targetFilePath);
        const domains = Array.isArray(workspace.domains) ? workspace.domains : [];
        const resolved = resolveNoteTarget<NoustDomain, NoustNote>(noteId, domains);
        return resolved ? resolved.note : null;
    }

    /**
     * Retrieves all Nexus / free-text documents in the workspace.
     */
    async getAllDocuments(targetFilePath?: string): Promise<NoustDocument[]> {
        const workspace = await this.readWorkspace(targetFilePath);
        return Array.isArray(workspace.globalFreeTextDocs) ? [...workspace.globalFreeTextDocs] : [];
    }

    /**
     * Finds a single document by its ID.
     */
    async getDocumentById(docId: string | number, targetFilePath?: string): Promise<NoustDocument | null> {
        const strId = String(docId).trim();
        const allDocs = await this.getAllDocuments(targetFilePath);
        return allDocs.find((doc) => String(doc.id).trim() === strId) || null;
    }

    /**
     * Retrieves all objectives defined in the workspace.
     */
    async getAllObjectives(targetFilePath?: string): Promise<NoustObjective[]> {
        const workspace = await this.readWorkspace(targetFilePath);
        const objectives: NoustObjective[] = [];

        // Top-level objectives if any
        if (Array.isArray(workspace.objectives)) {
            objectives.push(...workspace.objectives);
        }

        // Domain-scoped objectives
        for (const domain of workspace.domains || []) {
            if (Array.isArray(domain.objectives)) {
                for (const obj of domain.objectives) {
                    objectives.push({
                        ...obj,
                        domainId: obj.domainId ?? domain.id,
                        domainTitle: domain.title
                    });
                }
            }
        }

        return objectives;
    }

    /**
     * Finds a single objective by its ID.
     */
    async getObjectiveById(objectiveId: string | number, targetFilePath?: string): Promise<NoustObjective | null> {
        const strId = String(objectiveId).trim();
        const allObjectives = await this.getAllObjectives(targetFilePath);
        return allObjectives.find((obj) => String(obj.id).trim() === strId) || null;
    }

    /**
     * Retrieves a Base64-encoded asset by its content hash.
     */
    async getAsset(hash: string, targetFilePath?: string): Promise<string | null> {
        const workspace = await this.readWorkspace(targetFilePath);
        if (!workspace.assets || typeof workspace.assets !== 'object') {
            return null;
        }

        const normalizedHash = hash.trim();
        if (!Object.prototype.hasOwnProperty.call(workspace.assets, normalizedHash)) {
            return null;
        }

        const asset = workspace.assets[normalizedHash];
        if (Buffer.isBuffer(asset)) {
            return asset.toString('base64');
        }
        return typeof asset === 'string' && asset.trim().length > 0 ? asset : null;
    }

    /**
     * Retrieves all flags from the workspace or from a specific domain in offline mode.
     */
    async getFlags(
        domainId?: string | number,
        targetFilePath?: string
    ): Promise<Array<NoustFlag & { domainId: string | number; domainTitle?: string }>> {
        const workspace = await this.readWorkspace(targetFilePath);
        const results: Array<NoustFlag & { domainId: string | number; domainTitle?: string }> = [];

        const targetStr = domainId !== undefined && domainId !== null ? String(domainId).trim() : null;
        const domains = workspace.domains || [];

        for (const domain of domains) {
            if (targetStr && String(domain.id).trim() !== targetStr) {
                continue;
            }
            if (Array.isArray(domain.flowFlags)) {
                for (const flag of domain.flowFlags) {
                    results.push({
                        id: String(flag.id),
                        label: flag.label,
                        color: flag.color,
                        order: flag.order,
                        domainId: domain.id,
                        domainTitle: domain.title
                    });
                }
            }
        }

        return results;
    }
}
