// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

/**
 * Individual note structure within a Noust workspace.
 */
export interface NoustNote {
    id: string | number;
    title?: string;
    content?: string;
    tags?: string[];
    color?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    createdAt?: number;
    updatedAt?: number;
    pinned?: boolean;
    domainId?: string | number;
    [key: string]: unknown;
}

/**
 * Nexus document structure (free-text markdown document).
 */
export interface NoustDocument {
    id: string | number;
    title?: string;
    content?: string;
    createdAt?: number;
    updatedAt?: number;
    domainId?: string | number;
    folderId?: string | number;
    [key: string]: unknown;
}

/**
 * Objective / task item associated with a workspace or domain.
 */
export interface NoustObjective {
    id: string | number;
    title?: string;
    description?: string;
    status?: string;
    completed?: boolean;
    dueDate?: string | number;
    priority?: string;
    domainId?: string | number;
    [key: string]: unknown;
}

/**
 * Domain (section / canvas board) structure in Noust.
 */
export interface NoustFlag {
    id: string;
    label: string;
    color: string;
    order: number;
}

export interface NoustDomain {
    id: string | number;
    title: string;
    notes?: NoustNote[];
    objectives?: NoustObjective[];
    flowFlags?: NoustFlag[];
    [key: string]: unknown;
}

/**
 * Top-level structure of an unpacked .noust workspace package.
 */
export interface NoustWorkspaceData {
    workspaceId?: string;
    workspaceName?: string;
    version?: string;
    exportDate?: string;
    exportedAt?: number;
    domains?: NoustDomain[];
    globalFreeTextDocs?: NoustDocument[];
    objectives?: NoustObjective[];
    assets?: Record<string, string | Buffer>; // hash -> base64 string or raw Buffer
    [key: string]: unknown;
}

/**
 * Cached workspace entry in memory.
 */
export interface CachedWorkspace {
    filePath: string;
    fileName: string;
    mtimeMs: number;
    data: NoustWorkspaceData;
}

/**
 * Configuration options for WorkspaceReader.
 */
export interface WorkspaceReaderOptions {
    workspaceDir: string;
}
