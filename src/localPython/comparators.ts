// Copyright (c) 2026 Ali Soomro. All rights reserved.
// Licensed under the MIT license.

import { CaseOracle, Comparator, ComparisonResult, JsonValue, LocalCase, PythonRunSuccess } from "./models";

export function compareRun(caseDefinition: LocalCase, result: PythonRunSuccess): ComparisonResult {
    const oracle: CaseOracle = caseDefinition.oracle;
    if (oracle.kind === "execute-only") {
        return { label: "Ran locally", qualified: false };
    }
    if (oracle.kind === "unsupported" || oracle.kind === "property") {
        return { label: "Local runner does not support this case", qualified: false, detail: oracle.provenance };
    }
    if (oracle.expected === undefined) {
        return { label: "Local runner does not support this case", qualified: false, detail: "The assertion has no expected result." };
    }
    const comparator: Comparator = oracle.comparator || { kind: "ordered-equality" };
    if (result.mutated && !caseDefinition.expectedPostArgs && oracle.expected === null && comparator.kind === "ordered-equality") {
        return {
            label: "Local runner does not support this case",
            qualified: false,
            detail: "The solution mutated arguments, but this in-place result has no post-call assertion.",
        };
    }

    const matches: boolean = compareValue(result.returnValue, oracle.expected, comparator, caseDefinition.args);
    const source: string = oracle.kind === "imported-explicit-sample" ? "imported sample" : "local assertion";
    if (!matches) {
        return { label: `Failed ${source}`, passed: false, qualified: false };
    }
    if (result.mutated && !caseDefinition.expectedPostArgs) {
        return {
            label: `Passed ${source} (mutated arguments not asserted)`,
            passed: true,
            qualified: true,
            detail: "The returned value matches, but one or more input arguments changed.",
        };
    }
    return { label: `Passed ${source}`, passed: true, qualified: false };
}

function compareValue(actual: JsonValue, expected: JsonValue, comparator: Comparator, args: JsonValue[]): boolean {
    switch (comparator.kind) {
        case "ordered-equality":
            return stableKey(actual) === stableKey(expected);
        case "unordered-sequence":
            return compareUnordered(actual, expected, false);
        case "set-equality":
            return compareUnordered(actual, expected, true);
        case "numeric-tolerance":
            return compareNumber(actual, expected, comparator);
        case "any-valid-index-pair":
            return compareIndexPair(actual, args, comparator);
        case "manual-only":
            return true;
        default:
            return false;
    }
}

function compareUnordered(actual: JsonValue, expected: JsonValue, unique: boolean): boolean {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
        return false;
    }
    const actualKeys: string[] = actual.map(stableKey);
    const expectedKeys: string[] = expected.map(stableKey);
    const left: string[] = unique ? Array.from(new Set(actualKeys)) : actualKeys;
    const right: string[] = unique ? Array.from(new Set(expectedKeys)) : expectedKeys;
    return left.sort().join("\u0000") === right.sort().join("\u0000");
}

function compareNumber(actual: JsonValue, expected: JsonValue, comparator: Comparator): boolean {
    if (typeof actual !== "number" || typeof expected !== "number") {
        return false;
    }
    const absolute: number = typeof comparator.absoluteTolerance === "number" ? comparator.absoluteTolerance : 0;
    const relative: number = typeof comparator.relativeTolerance === "number" ? comparator.relativeTolerance : 0;
    const difference: number = Math.abs(actual - expected);
    return difference <= Math.max(absolute, relative * Math.max(Math.abs(actual), Math.abs(expected)));
}

function compareIndexPair(actual: JsonValue, args: JsonValue[], comparator: Comparator): boolean {
    if (!Array.isArray(actual) || actual.length !== 2 || !actual.every((value: JsonValue) => typeof value === "number" && Number.isInteger(value))) {
        return false;
    }
    const arrayIndex: number = typeof comparator.arrayArg === "number" ? comparator.arrayArg : 0;
    const targetIndex: number = typeof comparator.targetArg === "number" ? comparator.targetArg : 1;
    const values: JsonValue = args[arrayIndex];
    const target: JsonValue = args[targetIndex];
    if (!Array.isArray(values) || typeof target !== "number") {
        return false;
    }
    const first: number = actual[0] as number;
    const second: number = actual[1] as number;
    return first !== second && first >= 0 && second >= 0 && first < values.length && second < values.length &&
        typeof values[first] === "number" && typeof values[second] === "number" &&
        (values[first] as number) + (values[second] as number) === target;
}

function stableKey(value: JsonValue): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableKey).join(",")}]`;
    }
    const objectValue: { [key: string]: JsonValue } = value;
    return `{${Object.keys(objectValue).sort().map((key: string) => `${JSON.stringify(key)}:${stableKey(objectValue[key])}`).join(",")}}`;
}
