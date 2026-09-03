// Copyright (c) 2026 Ali Soomro. All rights reserved.
// Licensed under the MIT license.
/* tslint:disable:interface-name -- public source-template models use descriptive names. */

import { ParsedStarter, TypingImport } from "./models";

const SUPPORTED_TYPING_NAMES: string[] = ["List", "Optional", "Dict"];
const PLATFORM_TYPE_NAMES: string[] = ["ListNode", "TreeNode"];

const PLATFORM_DEFINITIONS: { [name: string]: string[] } = {
    ListNode: [
        "class ListNode:",
        "    def __init__(self, val=0, next=None):",
        "        self.val = val",
        "        self.next = next",
    ],
    TreeNode: [
        "class TreeNode:",
        "    def __init__(self, val=0, left=None, right=None):",
        "        self.val = val",
        "        self.left = left",
        "        self.right = right",
    ],
};

/** Result of turning a copied LeetCode Python starter into Candidate A source. */
export interface CandidateASourcePreparation {
    source: string;
    requiredTypingNames: string[];
    addedPlatformTypes: string[];
}

/**
 * LeetCode's Copy control can yield an empty method suite. Python cannot
 * parse that scaffold until it has a body, so add `pass` to that one narrow
 * case. Deliberately do not attempt to repair any other syntax error.
 */
export function normalizeStarterSource(source: string): string {
    const lineEnding: string = getLineEnding(source);
    const lines: string[] = splitLines(source);

    for (let index: number = 0; index < lines.length; index += 1) {
        const header: RegExpExecArray | null = /^(\s*)(?:async\s+)?def\s+[A-Za-z_]\w*\s*\([^#]*\)\s*(?:->\s*[^:#]+)?\s*:\s*(?:#.*)?$/.exec(lines[index]);
        if (!header) {
            continue;
        }

        const indentation: number = header[1].length;
        let next: number = index + 1;
        while (next < lines.length && isBlankOrComment(lines[next])) {
            next += 1;
        }
        const nextIndentation: number = next < lines.length ? leadingWhitespaceLength(lines[next]) : 0;
        if (next === lines.length || nextIndentation <= indentation) {
            lines.splice(index + 1, 0, `${header[1]}    pass`);
            index += 1;
        }
    }

    return lines.join(lineEnding);
}

/** Backwards-compatible descriptive alias for the narrow normalization step. */
export const normalizeBlankDefScaffolds = normalizeStarterSource;

/**
 * Add the bare `typing` names present in a Solution signature. A direct,
 * non-aliased `from typing import ...` is merged when possible; alias/star
 * imports are preserved and a separate direct import is added instead.
 *
 * `insertionLine` is computed by the Python AST parser after a module
 * docstring and every legal `__future__` import, so this function never
 * displaces a future import from its required position.
 */
export function reconcileTypingImports(source: string, starter: ParsedStarter): string {
    const required: string[] = uniqueSupportedTypingNames(starter.requiredTypingNames);
    if (required.length === 0) {
        return source;
    }

    const lineEnding: string = getLineEnding(source);
    const lines: string[] = splitLines(source);
    // Prefer the source's current imports. Parsed line positions describe the
    // original clipboard source and may be stale on a second idempotent pass.
    const sourceImports: TypingImport[] = findDirectTypingImports(lines);
    const imports: TypingImport[] = sourceImports.length > 0
        ? sourceImports
        : starter.typingImports.filter((entry: TypingImport) => isValidRange(entry, lines));
    const available: string[] = uniqueNames(flatten(imports.map((entry: TypingImport) => entry.names)));
    const missing: string[] = required.filter((name: string) => available.indexOf(name) === -1);
    if (missing.length === 0) {
        return source;
    }

    const existing: TypingImport | undefined = imports.length > 0 ? imports[0] : undefined;
    if (existing) {
        const names: string[] = uniqueNames(existing.names.concat(missing)).sort();
        const indentation: string = leadingWhitespace(lines[existing.line - 1]);
        lines.splice(existing.line - 1, existing.endLine - existing.line + 1, `${indentation}from typing import ${names.join(", ")}`);
        return lines.join(lineEnding);
    }

    const insertionIndex: number = clamp(starter.insertionLine, 0, lines.length);
    lines.splice(insertionIndex, 0, `from typing import ${missing.join(", ")}`);
    return lines.join(lineEnding);
}

/**
 * Prepare the validated Candidate A layout. Call this with the normalized
 * source and metadata returned by `parseClipboardStarter`. It is idempotent:
 * rerunning it preserves imports and does not add duplicate platform classes.
 */
export function prepareCandidateASource(source: string, starter: ParsedStarter): string {
    return prepareCandidateASourceDetailed(source, starter).source;
}

/**
 * Variant of `prepareCandidateASource` that also reports the material it
 * added. The string-returning function is the integration default.
 */
export function prepareCandidateASourceDetailed(source: string, starter: ParsedStarter): CandidateASourcePreparation {
    const reconciled: string = reconcileTypingImports(source, starter);
    const requiredPlatformTypes: string[] = PLATFORM_TYPE_NAMES.filter((name: string) =>
        sourceReferencesIdentifier(reconciled, name) && !hasTopLevelClass(reconciled, name)
    );
    if (requiredPlatformTypes.length === 0) {
        return {
            source: reconciled,
            requiredTypingNames: uniqueSupportedTypingNames(starter.requiredTypingNames),
            addedPlatformTypes: [],
        };
    }

    return {
        source: insertPlatformDefinitions(reconciled, requiredPlatformTypes, starter.insertionLine),
        requiredTypingNames: uniqueSupportedTypingNames(starter.requiredTypingNames),
        addedPlatformTypes: requiredPlatformTypes,
    };
}

function insertPlatformDefinitions(source: string, names: string[], fallbackInsertionLine: number): string {
    const lineEnding: string = getLineEnding(source);
    const lines: string[] = splitLines(source);
    const solutionIndex: number = findSolutionDeclarationIndex(lines);
    const insertionIndex: number = solutionIndex === -1 ? clamp(fallbackInsertionLine, 0, lines.length) : solutionIndex;
    const definitions: string[] = [];

    names.forEach((name: string, index: number) => {
        if (index > 0) {
            definitions.push("");
        }
        definitions.push.apply(definitions, PLATFORM_DEFINITIONS[name]);
    });

    if (insertionIndex > 0 && lines[insertionIndex - 1].trim() !== "") {
        definitions.unshift("");
    }
    if (insertionIndex < lines.length && lines[insertionIndex].trim() !== "") {
        definitions.push("");
    }
    lines.splice(insertionIndex, 0, ...definitions);
    return lines.join(lineEnding);
}

function findSolutionDeclarationIndex(lines: string[]): number {
    let index: number = -1;
    for (let lineIndex: number = 0; lineIndex < lines.length; lineIndex += 1) {
        if (/^class\s+Solution\b/.test(lines[lineIndex])) {
            index = lineIndex;
            break;
        }
    }
    if (index === -1) {
        return -1;
    }
    while (index > 0 && /^\s*@/.test(lines[index - 1])) {
        index -= 1;
    }
    return index;
}

function sourceReferencesIdentifier(source: string, identifier: string): boolean {
    const expression: RegExp = new RegExp(`\\b${identifier}\\b`);
    return splitLines(source).some((line: string) => {
        if (/^\s*#/.test(line)) {
            return false;
        }
        const commentStart: number = line.indexOf("#");
        const code: string = commentStart === -1 ? line : line.substring(0, commentStart);
        return expression.test(code);
    });
}

function hasTopLevelClass(source: string, className: string): boolean {
    const expression: RegExp = new RegExp(`^class\\s+${className}\\b`);
    return splitLines(source).some((line: string) => expression.test(line));
}

function findDirectTypingImports(lines: string[]): TypingImport[] {
    const imports: TypingImport[] = [];
    lines.forEach((line: string, index: number) => {
        const match: RegExpExecArray | null = /^\s*from\s+typing\s+import\s+(.+?)\s*(?:#.*)?$/.exec(line);
        if (!match) {
            return;
        }
        const names: string[] = match[1].split(",").map((name: string) => name.trim());
        if (names.length === 0 || names.some((name: string) => !/^[A-Za-z_]\w*$/.test(name))) {
            return;
        }
        imports.push({ line: index + 1, endLine: index + 1, names });
    });
    return imports;
}

function uniqueSupportedTypingNames(names: string[]): string[] {
    return SUPPORTED_TYPING_NAMES.filter((name: string) => names.indexOf(name) !== -1);
}

function uniqueNames(names: string[]): string[] {
    return names.filter((name: string, index: number) => names.indexOf(name) === index);
}

function flatten(values: string[][]): string[] {
    return ([] as string[]).concat.apply([], values);
}

function isValidRange(entry: TypingImport, lines: string[]): boolean {
    return entry.line >= 1 && entry.endLine >= entry.line && entry.endLine <= lines.length;
}

function isBlankOrComment(line: string): boolean {
    return line.trim() === "" || /^\s*#/.test(line);
}

function leadingWhitespaceLength(line: string): number {
    return leadingWhitespace(line).length;
}

function leadingWhitespace(line: string): string {
    const match: RegExpExecArray | null = /^\s*/.exec(line);
    return match ? match[0] : "";
}

function getLineEnding(source: string): string {
    return source.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
}

function splitLines(source: string): string[] {
    return source.split(/\r?\n/);
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
}
