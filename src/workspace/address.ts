// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import type { NoustDomain, NoustNote } from './types.js';

export interface ParsedMcpCanvasAddress {
    raw: string;
    domainPosition?: number;
    entityKind: 'note' | 'sector' | 'cluster';
    noteRef?: string;
    sectorRef?: number;
    clusterRef?: number;
}

const BARE_NOTE_REGEX = /^[A-Z]+[0-9]$/i;
const BARE_SECTOR_REGEX = /^;[1-9][0-9]*([A-Z]+[0-9])?$/i;
const BARE_CLUSTER_REGEX = /^:[1-9][0-9]*([A-Z]+[0-9])?$/i;

const QUALIFIED_CANVAS_ADDRESS_REGEX =
    /^([1-9][0-9]*)(?:(;[1-9][0-9]*)(?:([A-Z]+[0-9]))?|(:[1-9][0-9]*)(?:([A-Z]+[0-9]))?|([A-Z]+[0-9]))$/i;

/**
 * Checks whether an input is a bare (unqualified) human reference that lacks a domain position.
 */
export function isBareHumanReference(raw: string): boolean {
    const trimmed = raw.trim();
    return (
        BARE_NOTE_REGEX.test(trimmed) ||
        BARE_SECTOR_REGEX.test(trimmed) ||
        BARE_CLUSTER_REGEX.test(trimmed)
    );
}

/**
 * Parses a domain-qualified canvas address (e.g. "1A1", "1:2A1", "1;2").
 * Returns null if the string is not a valid domain-qualified canvas address.
 */
export function parseQualifiedCanvasAddress(raw: string): ParsedMcpCanvasAddress | null {
    const trimmed = raw.trim();
    const match = trimmed.match(QUALIFIED_CANVAS_ADDRESS_REGEX);
    if (!match) return null;

    const domainPosition = parseInt(match[1], 10);
    const rawSector = match[2];
    const noteAfterSector = match[3];
    const rawCluster = match[4];
    const noteAfterCluster = match[5];
    const noteDirect = match[6];

    if (rawSector) {
        const sectorRef = parseInt(rawSector.slice(1), 10);
        if (noteAfterSector) {
            return {
                raw,
                domainPosition,
                entityKind: 'note',
                noteRef: noteAfterSector.toUpperCase(),
                sectorRef
            };
        }
        return {
            raw,
            domainPosition,
            entityKind: 'sector',
            sectorRef
        };
    }

    if (rawCluster) {
        const clusterRef = parseInt(rawCluster.slice(1), 10);
        if (noteAfterCluster) {
            return {
                raw,
                domainPosition,
                entityKind: 'note',
                noteRef: noteAfterCluster.toUpperCase(),
                clusterRef
            };
        }
        return {
            raw,
            domainPosition,
            entityKind: 'cluster',
            clusterRef
        };
    }

    if (noteDirect) {
        return {
            raw,
            domainPosition,
            entityKind: 'note',
            noteRef: noteDirect.toUpperCase()
        };
    }

    return null;
}

export interface ResolvedNoteReference<TDomain = NoustDomain, TNote = NoustNote> {
    domain: TDomain;
    domainIndex: number;
    note: TNote;
}

export interface BaseNoteTarget {
    id: string | number;
    humanRef?: string;
    [key: string]: unknown;
}

export interface BaseDomainTarget<TNote extends BaseNoteTarget = BaseNoteTarget> {
    id: string | number;
    title: string;
    notes?: TNote[];
    [key: string]: unknown;
}

/**
 * Resolves a note target ID (system ID or domain-qualified human ID) across domains.
 * Throws an explicit error if a bare human reference is supplied without a domain position.
 */
export function resolveNoteTarget<
    TDomain extends BaseDomainTarget<TNote>,
    TNote extends BaseNoteTarget = BaseNoteTarget
>(
    targetId: string | number,
    domains: TDomain[]
): ResolvedNoteReference<TDomain, TNote> | null {
    const targetStr = String(targetId).trim();
    if (!targetStr) return null;

    // 1. Strict check: Bare human IDs without domain prefix are explicitly rejected in MCP
    if (isBareHumanReference(targetStr)) {
        throw new Error(
            `Ambiguous human reference '${targetStr}': MCP operations strictly require a domain-qualified address (e.g. '1A1', '2A1', '1:1A1'). Please specify the domain position number before the reference.`
        );
    }

    // 2. Qualified canvas address check (e.g. 1A1, 2A1, 1:2A1)
    const qualified = parseQualifiedCanvasAddress(targetStr);
    if (qualified) {
        const domainIndex = qualified.domainPosition! - 1;
        if (domainIndex < 0 || domainIndex >= domains.length || !domains[domainIndex]) {
            throw new Error(
                `Domain position ${qualified.domainPosition} in address '${targetStr}' does not exist in workspace (workspace has ${domains.length} domain${domains.length === 1 ? '' : 's'}).`
            );
        }

        const domain = domains[domainIndex];
        const notes = Array.isArray(domain.notes) ? domain.notes : [];

        if (qualified.entityKind === 'note' && qualified.noteRef) {
            const found = notes.find((n: TNote) => {
                const hRef = n.humanRef ? String(n.humanRef).trim().toUpperCase() : '';
                return hRef === qualified.noteRef;
            });

            if (!found) {
                throw new Error(
                    `Note '${qualified.noteRef}' was not found in domain ${qualified.domainPosition} ('${domain.title}').`
                );
            }

            return { domain, domainIndex, note: found };
        }

        throw new Error(`Address '${targetStr}' targets a ${qualified.entityKind}, not an individual note.`);
    }

    // 3. Fallback: System ID lookup (unique ID / timestamp / UUID)
    for (let i = 0; i < domains.length; i++) {
        const domain = domains[i];
        if (!Array.isArray(domain.notes)) continue;
        const found = domain.notes.find((n: TNote) => String(n.id).trim() === targetStr);
        if (found) {
            return { domain, domainIndex: i, note: found };
        }
    }

    return null;
}
