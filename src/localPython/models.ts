// Copyright (c) 2026 Ali Soomro. All rights reserved.
// Licensed under the MIT license.
/* tslint:disable:interface-name -- public local-runner models use descriptive names. */

/** JSON-compatible values used at the extension/runner boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface PythonParameter {
    name: string;
    annotation?: string;
}

export interface TypingImport {
    line: number;
    endLine: number;
    names: string[];
}

export interface ParsedStarter {
    methodName: string;
    parameters: PythonParameter[];
    returnAnnotation?: string;
    requiredTypingNames: string[];
    typingImports: TypingImport[];
    insertionLine: number;
}

export type OracleKind = "execute-only" | "user-assertion" | "imported-explicit-sample" | "property" | "unsupported";

export type ComparatorKind =
    | "ordered-equality"
    | "unordered-sequence"
    | "set-equality"
    | "any-valid-index-pair"
    | "numeric-tolerance"
    | "manual-only";

export interface Comparator {
    kind: ComparatorKind;
    arrayArg?: number;
    targetArg?: number;
    absoluteTolerance?: number;
    relativeTolerance?: number;
}

export interface CaseOracle {
    kind: OracleKind;
    comparator?: Comparator;
    expected?: JsonValue;
    provenance: string;
}

export interface LocalCase {
    name: string;
    args: JsonValue[];
    oracle: CaseOracle;
    /** Reserved for an explicit post-call-input assertion in a later release. */
    expectedPostArgs?: JsonValue[];
}

export interface LocalCasesFile {
    formatVersion: 1;
    cases: LocalCase[];
}

export interface LocalProblemFile {
    formatVersion: 1;
    source: {
        kind: "clipboard" | "generated";
        importedAt: string;
        solutionPath?: string;
    };
    problem: {
        id: string | null;
        slug: string;
        title: string;
    };
    method: {
        name: string;
        params: PythonParameter[];
        return: { annotation?: string };
    };
    localSupport: {
        status: "ready" | "pending";
        reason: string;
    };
}

export interface ProblemLocation {
    directory: string;
    problemPath: string;
    casesPath: string;
    problem: LocalProblemFile;
}

export interface PythonRunRequest {
    solutionPath: string;
    methodName: string;
    args: JsonValue[];
}

export interface PythonRunSuccess {
    ok: true;
    returnValue: JsonValue;
    preArgs: JsonValue[];
    postArgs: JsonValue[];
    mutated: boolean;
    stdout: string;
    stderr: string;
}

export interface PythonRunFailure {
    ok: false;
    kind: "syntax-error" | "runtime-error" | "timeout" | "output-limit" | "runner-error";
    message: string;
    traceback?: string;
    stdout: string;
    stderr: string;
}

export type PythonRunResult = PythonRunSuccess | PythonRunFailure;

export interface ComparisonResult {
    label: string;
    passed?: boolean;
    detail?: string;
    qualified: boolean;
}
