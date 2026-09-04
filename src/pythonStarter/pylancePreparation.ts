// Copyright (c) 2026 Ali Soomro. All rights reserved.
// Licensed under the MIT license.

/**
 * Makes a newly generated LeetCode Python starter analyzable by Pylance while
 * preserving a file that can be pasted back into LeetCode unchanged.
 *
 * This deliberately is not a general Python formatter or repair tool. It
 * handles only the platform scaffolding that LeetCode commonly omits from a
 * copied/generated starter: an empty method suite, bare typing names, and the
 * ListNode/TreeNode definitions referenced in a Solution signature.
 */

const TYPING_NAMES: string[] = ["List", "Optional", "Dict"];
const PLATFORM_TYPES: string[] = ["ListNode", "TreeNode"];

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

export function preparePythonStarterForPylance(source: string): string {
    let prepared: string = addPassToEmptyMethodSuites(source);
    const requiredTyping: string[] = referencedNames(prepared, TYPING_NAMES);
    prepared = addMissingTypingImports(prepared, requiredTyping);
    const requiredPlatformTypes: string[] = referencedNames(prepared, PLATFORM_TYPES)
        .filter((name: string) => !hasClassDefinition(prepared, name));
    return addPlatformDefinitions(prepared, requiredPlatformTypes);
}

/**
 * LeetCode occasionally generates an empty method suite. A comment does not
 * count as a Python suite, so add `pass` only when the next real line is not
 * nested beneath the method declaration.
 */
function addPassToEmptyMethodSuites(source: string): string {
    const lineEnding: string = getLineEnding(source);
    const lines: string[] = splitLines(source);

    for (let index: number = 0; index < lines.length; index += 1) {
        const match: RegExpExecArray | null = /^(\s*)(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(.*\)\s*(?:->\s*.*)?\s*:\s*(?:#.*)?$/.exec(lines[index]);
        if (!match) {
            continue;
        }

        const declarationIndent: number = match[1].length;
        let next: number = index + 1;
        while (next < lines.length && isBlankOrComment(lines[next])) {
            next += 1;
        }
        const nextIndent: number = next < lines.length ? leadingWhitespace(lines[next]).length : 0;
        if (next === lines.length || nextIndent <= declarationIndent) {
            lines.splice(index + 1, 0, `${match[1]}    pass`);
            index += 1;
        }
    }

    return lines.join(lineEnding);
}

function addMissingTypingImports(source: string, required: string[]): string {
    const missing: string[] = required.filter((name: string) => existingTypingNames(source).indexOf(name) === -1);
    if (missing.length === 0) {
        return source;
    }

    const lineEnding: string = getLineEnding(source);
    const lines: string[] = splitLines(source);
    const insertionIndex: number = importInsertionIndex(lines);
    lines.splice(insertionIndex, 0, `from typing import ${missing.join(", ")}`);
    return lines.join(lineEnding);
}

function addPlatformDefinitions(source: string, names: string[]): string {
    if (names.length === 0) {
        return source;
    }

    const lineEnding: string = getLineEnding(source);
    const lines: string[] = splitLines(source);
    let insertionIndex: number = lines.findIndex((line: string) => /^class\s+Solution\b/.test(line));
    if (insertionIndex === -1) {
        insertionIndex = importInsertionIndex(lines);
    }
    while (insertionIndex > 0 && /^\s*@/.test(lines[insertionIndex - 1])) {
        insertionIndex -= 1;
    }

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

function referencedNames(source: string, candidates: string[]): string[] {
    const code: string = splitLines(source)
        .filter((line: string) => !/^\s*(?:from\s+\S+\s+import|import\s+)/.test(line))
        .map(withoutComment)
        .join("\n");
    return candidates.filter((name: string) => new RegExp(`\\b${name}\\b`).test(code));
}

function existingTypingNames(source: string): string[] {
    const names: string[] = [];
    splitLines(source).forEach((line: string) => {
        const match: RegExpExecArray | null = /^\s*from\s+typing\s+import\s+(.+?)\s*(?:#.*)?$/.exec(line);
        if (!match) {
            return;
        }
        match[1].split(",").forEach((entry: string) => {
            const name: RegExpExecArray | null = /^\s*([A-Za-z_]\w*)\s*$/.exec(entry);
            if (name && names.indexOf(name[1]) === -1) {
                names.push(name[1]);
            }
        });
    });
    return names;
}

function hasClassDefinition(source: string, className: string): boolean {
    return splitLines(source).some((line: string) => new RegExp(`^\\s*class\\s+${className}\\b`).test(line));
}

function importInsertionIndex(lines: string[]): number {
    let lastFutureImport: number = -1;
    lines.forEach((line: string, lineIndex: number) => {
        if (/^\s*from\s+__future__\s+import\b/.test(line)) {
            lastFutureImport = lineIndex;
        }
    });
    if (lastFutureImport !== -1) {
        return lastFutureImport + 1;
    }

    let index: number = 0;
    while (index < lines.length && isBlankOrComment(lines[index])) {
        index += 1;
    }
    return skipModuleDocstring(lines, index);
}

function skipModuleDocstring(lines: string[], index: number): number {
    const match: RegExpExecArray | null = /^\s*('''|\"\"\")/.exec(lines[index] || "");
    if (!match) {
        return index;
    }
    const delimiter: string = match[1];
    const first: number = lines[index].indexOf(delimiter);
    if (lines[index].indexOf(delimiter, first + delimiter.length) !== -1) {
        return index + 1;
    }
    for (let cursor: number = index + 1; cursor < lines.length; cursor += 1) {
        if (lines[cursor].indexOf(delimiter) !== -1) {
            return cursor + 1;
        }
    }
    return index;
}

function withoutComment(line: string): string {
    const comment: number = line.indexOf("#");
    return comment === -1 ? line : line.substring(0, comment);
}

function isBlankOrComment(line: string): boolean {
    return line.trim() === "" || /^\s*#/.test(line);
}

function leadingWhitespace(line: string): string {
    const match: RegExpExecArray | null = /^\s*/.exec(line);
    return match ? match[0] : "";
}

function getLineEnding(source: string): string {
    return source.indexOf("\r\n") === -1 ? "\n" : "\r\n";
}

function splitLines(source: string): string[] {
    return source.split(/\r?\n/);
}
