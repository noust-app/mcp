// Copyright (c) 2025 Lucas Vazzoller Marangoni (Noust.app). All rights reserved.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkspaceReader } from '../workspace/WorkspaceReader.js';

interface ParsedAsset {
    mimeType: string;
    cleanData: string;
    isSupportedImage: boolean;
    isSvg: boolean;
}

/**
 * Parses asset payload without running full-string regular expressions on large Base64 files.
 */
function parseAssetPayload(base64Data: string): ParsedAsset {
    let mimeType = 'image/png';
    let cleanData = base64Data;

    if (base64Data.startsWith('data:')) {
        const commaIndex = base64Data.indexOf(',');
        if (commaIndex !== -1) {
            const header = base64Data.slice(0, commaIndex);
            const mimeMatch = header.match(/^data:([^;]+);base64/i);
            if (mimeMatch) {
                mimeType = mimeMatch[1].toLowerCase().trim();
            }
            cleanData = base64Data.slice(commaIndex + 1);
        }
    } else {
        // Inspect only the first 32 characters for magic byte markers (avoids scanning entire payload)
        const prefix = base64Data.slice(0, 32).trim();
        if (prefix.startsWith('iVBORw0KGgo')) {
            mimeType = 'image/png';
        } else if (prefix.startsWith('/9j/')) {
            mimeType = 'image/jpeg';
        } else if (prefix.startsWith('UklGR')) {
            mimeType = 'image/webp';
        } else if (prefix.startsWith('R0lGOD')) {
            mimeType = 'image/gif';
        } else if (prefix.startsWith('PHN2Z') || prefix.startsWith('PD94b')) {
            mimeType = 'image/svg+xml';
        }
    }

    cleanData = cleanData.trim();
    const isSvg = mimeType.includes('svg') || cleanData.startsWith('PHN2Z') || cleanData.startsWith('PD94b');
    const isSupportedImage = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType) && !isSvg;

    return { mimeType, cleanData, isSupportedImage, isSvg };
}

/**
 * Registers `get_asset` MCP tool for multimodal AI agents.
 */
export function registerAssetsTools(server: McpServer, reader: WorkspaceReader): void {
    server.registerTool(
        'get_asset',
        {
            title: 'Get Embedded Asset by Hash',
            description:
                'Retrieves an embedded image or media asset from the workspace using its content hash reference. ' +
                'Delivers images directly for multimodal AI models (Claude 3.5 Sonnet, GPT-4o, Gemini) and text/XML for SVG graphics.',
            inputSchema: {
                hash: z.string().describe('The content hash reference of the asset (e.g. "hash_abc123" or sha256 hash)')
            }
        },
        async ({ hash }) => {
            const cleanHash = hash.trim();
            if (!cleanHash) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Asset hash cannot be empty.' }]
                };
            }

            try {
                const rawAsset = await reader.getAsset(cleanHash);
                if (!rawAsset || typeof rawAsset !== 'string') {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: `Asset with hash "${cleanHash}" not found in active workspace.`
                            }
                        ]
                    };
                }

                const { mimeType, cleanData, isSupportedImage, isSvg } = parseAssetPayload(rawAsset);

                // If SVG, deliver as readable XML text instead of image block to prevent LLM rejection
                if (isSvg) {
                    let decodedSvg: string;
                    try {
                        decodedSvg = Buffer.from(cleanData, 'base64').toString('utf-8');
                    } catch {
                        decodedSvg = cleanData;
                    }
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `[SVG Vector Graphic "${cleanHash}"]:\n\`\`\`xml\n${decodedSvg}\n\`\`\``
                            }
                        ]
                    };
                }

                // If standard raster image (PNG, JPEG, WEBP, GIF), deliver native MCP image block
                if (isSupportedImage) {
                    return {
                        content: [
                            {
                                type: 'image',
                                data: cleanData,
                                mimeType
                            },
                            {
                                type: 'text',
                                text: `Asset "${cleanHash}" retrieved successfully (${mimeType}).`
                            }
                        ]
                    };
                }

                // Generic binary/document asset fallback
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Asset "${cleanHash}" (${mimeType}) is available in Base64 format.`
                        }
                    ]
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Failed to retrieve asset: ${message}` }]
                };
            }
        }
    );
}
