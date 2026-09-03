// Copyright (c) 2026 Ali Soomro. All rights reserved.
// Licensed under the MIT license.

import * as fse from "fs-extra";
import * as vscode from "vscode";
import { compareRun } from "../localPython/comparators";
import {
    CaseOracle,
    Comparator,
    JsonValue,
    LocalCase,
    LocalCasesFile,
    PythonRunFailure,
    PythonRunResult,
    PythonRunSuccess,
} from "../localPython/models";
import { localPythonOutput } from "../localPython/output";
import { prepareNewPythonStarter } from "../localPython/generatedStarter";
import {
    createClipboardProblemPackage,
    readCases,
    resolveProblemLocation,
    writeCases,
} from "../localPython/problemStore";
import { parseClipboardStarter, parsePythonStarter } from "../localPython/pythonAst";
import { LocalPythonRunResult, runLocalPython } from "../localPython/runner";
import { prepareCandidateASourceDetailed } from "../localPython/sourceTemplate";

export async function importStarterFromClipboard(): Promise<void> {
    const workspaceRoot: string | undefined = await getWorkspaceRoot();
    if (!workspaceRoot) {
        return;
    }
    const pythonPath: string = getPythonPath();
    const clipboard: string = await vscode.env.clipboard.readText();
    if (!clipboard.trim()) {
        await vscode.window.showErrorMessage("The clipboard is empty. Copy only the Python starter code, then try again.");
        return;
    }
    try {
        const parsed = await parseClipboardStarter(pythonPath, clipboard);
        const title: string | undefined = await vscode.window.showInputBox({
            prompt: "Problem title for this local package",
            value: parsed.starter.methodName,
            validateInput: (value: string): string | undefined => value.trim() ? undefined : "A title is required.",
            ignoreFocusOut: true,
        });
        if (!title) {
            return;
        }
        const candidateA = prepareCandidateASourceDetailed(parsed.normalizedSource, parsed.starter);
        const location = await createClipboardProblemPackage(workspaceRoot, title, candidateA.source, parsed.starter);
        await vscode.window.showTextDocument(vscode.Uri.file(`${location.directory}/solution.py`), { preview: false });
        const additions: string = candidateA.addedPlatformTypes.length ? ` Added local ${candidateA.addedPlatformTypes.join(" and ")} definitions.` : "";
        await vscode.window.showInformationMessage(`Created local Python problem package. The starter was parsed only on this computer.${additions}`);
    } catch (error) {
        await vscode.window.showErrorMessage(`Could not import starter: ${friendlyImportError(error)}`);
    }
}

/** Prepare an upstream-created Python starter only while it is still new. */
export async function prepareNewUpstreamPythonStarter(filePath: string): Promise<void> {
    await prepareNewPythonStarter(getPythonPath(), filePath);
}

export async function runActivePythonSolution(uri?: vscode.Uri): Promise<void> {
    const document: vscode.TextDocument | undefined = await getActivePythonDocument(uri);
    if (!document || !await ensureTrustedWorkspace()) {
        return;
    }
    const pythonPath: string = getPythonPath();
    try {
        const source: string = await fse.readFile(document.uri.fsPath, "utf8");
        const starter = await parsePythonStarter(pythonPath, source);
        const location = await resolveProblemLocation(document.uri.fsPath, workspaceRootFor(document.uri), starter);
        const cases: LocalCasesFile = await readCases(location);
        const selectedCase: LocalCase | undefined = await chooseCase(cases);
        if (!selectedCase) {
            return;
        }
        const rawResult: LocalPythonRunResult = await runLocalPython(
            pythonPath,
            { solutionPath: document.uri.fsPath, method: starter.methodName, args: selectedCase.args },
            { timeoutMs: getTimeoutMs(), outputLimitBytes: getOutputLimitBytes() },
        );
        const result: PythonRunResult = normalizeRunnerResult(rawResult);
        if (result.ok) {
            const comparison = compareRun(selectedCase, result);
            localPythonOutput.showSuccess(selectedCase, result, comparison);
            if (comparison.passed === false) {
                await vscode.window.showErrorMessage(comparison.label);
            } else if (comparison.label === "Ran locally") {
                await vscode.window.showInformationMessage(comparison.label);
            } else {
                await vscode.window.showInformationMessage(comparison.label);
            }
        } else {
            localPythonOutput.showFailure(selectedCase, result);
            await vscode.window.showErrorMessage(`Local run failed: ${result.message}`);
        }
    } catch (error) {
        await vscode.window.showErrorMessage(`Could not run locally: ${friendlyImportError(error)}`);
    }
}

export async function addLocalAssertionCase(uri?: vscode.Uri): Promise<void> {
    const document: vscode.TextDocument | undefined = await getActivePythonDocument(uri);
    if (!document || !await ensureTrustedWorkspace()) {
        return;
    }
    const pythonPath: string = getPythonPath();
    try {
        const starter = await parsePythonStarter(pythonPath, await fse.readFile(document.uri.fsPath, "utf8"));
        const location = await resolveProblemLocation(document.uri.fsPath, workspaceRootFor(document.uri), starter);
        const cases: LocalCasesFile = await readCases(location);
        const args: JsonValue[] | undefined = await promptArgs();
        if (!args) {
            return;
        }
        const comparator: Comparator | undefined = await chooseComparator();
        if (!comparator) {
            return;
        }
        const expected: JsonValue | undefined = await promptExpected(comparator);
        if (expected === undefined) {
            return;
        }
        const name: string | undefined = await vscode.window.showInputBox({
            prompt: "Case name",
            value: `Custom case ${cases.cases.length + 1}`,
            validateInput: (value: string): string | undefined => value.trim() ? undefined : "A case name is required.",
            ignoreFocusOut: true,
        });
        if (!name) {
            return;
        }
        const oracle: CaseOracle = {
            kind: "user-assertion",
            comparator,
            expected,
            provenance: "user-entered",
        };
        cases.cases.push({ name, args, oracle });
        await writeCases(location, cases);
        await vscode.window.showInformationMessage(`Saved local assertion case in ${location.casesPath}.`);
    } catch (error) {
        await vscode.window.showErrorMessage(`Could not add local case: ${friendlyImportError(error)}`);
    }
}

function getPythonPath(): string {
    return vscode.workspace.getConfiguration("leetcodePythonLocal").get<string>("pythonPath", "python3").trim() || "python3";
}

function getTimeoutMs(): number {
    return vscode.workspace.getConfiguration("leetcodePythonLocal").get<number>("timeoutMs", 3000);
}

function getOutputLimitBytes(): number {
    return vscode.workspace.getConfiguration("leetcodePythonLocal").get<number>("outputLimitBytes", 1024 * 1024);
}

async function getWorkspaceRoot(): Promise<string | undefined> {
    const opened: vscode.WorkspaceFolder | undefined = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (opened) {
        return opened.uri.fsPath;
    }
    const selected: vscode.Uri[] | undefined = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Use folder for local Python problems",
        title: "Choose a folder for local LeetCode Python problems",
    });
    return selected && selected[0] ? selected[0].fsPath : undefined;
}

async function getActivePythonDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    const editor: vscode.TextEditor | undefined = uri ? await vscode.window.showTextDocument(uri, { preview: false }) : vscode.window.activeTextEditor;
    if (!editor) {
        await vscode.window.showWarningMessage("Open a saved Python solution first.");
        return undefined;
    }
    if (editor.document.languageId !== "python") {
        await vscode.window.showWarningMessage("Local execution currently supports Python files only.");
        return undefined;
    }
    if (editor.document.isDirty && !await editor.document.save()) {
        await vscode.window.showWarningMessage("Save the solution before running it locally.");
        return undefined;
    }
    return editor.document;
}

async function ensureTrustedWorkspace(): Promise<boolean> {
    if (vscode.workspace.isTrusted) {
        return true;
    }
    await vscode.window.showWarningMessage("Local execution is disabled until you trust this workspace. It runs your Python code with your user permissions.");
    return false;
}

function workspaceRootFor(uri: vscode.Uri): string | undefined {
    const folder: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? folder.uri.fsPath : undefined;
}

async function chooseCase(cases: LocalCasesFile): Promise<LocalCase | undefined> {
    if (cases.cases.length === 1) {
        return cases.cases[0];
    }
    if (cases.cases.length > 1) {
        const selected = await vscode.window.showQuickPick(cases.cases.map((caseDefinition: LocalCase) => ({
            label: caseDefinition.name,
            description: caseDefinition.oracle.kind,
            value: caseDefinition,
        })), { placeHolder: "Choose a local case" });
        return selected ? selected.value : undefined;
    }
    const args: JsonValue[] | undefined = await promptArgs();
    return args ? {
        name: "Ad hoc local run",
        args,
        oracle: { kind: "execute-only", provenance: "entered for this local run" },
    } : undefined;
}

async function promptArgs(): Promise<JsonValue[] | undefined> {
    const source: string | undefined = await vscode.window.showInputBox({
        prompt: "Arguments as a JSON array",
        placeHolder: "Example: [\"()[]{}\"] or [[2,7,11,15],9]",
        validateInput: validateJsonArray,
        ignoreFocusOut: true,
    });
    if (source === undefined) {
        return undefined;
    }
    return JSON.parse(source) as JsonValue[];
}

async function promptExpected(comparator: Comparator): Promise<JsonValue | undefined> {
    if (comparator.kind === "any-valid-index-pair") {
        return null;
    }
    const source: string | undefined = await vscode.window.showInputBox({
        prompt: "Expected return value as JSON",
        value: "null",
        validateInput: validateJsonValue,
        ignoreFocusOut: true,
    });
    if (source === undefined) {
        return undefined;
    }
    return JSON.parse(source) as JsonValue;
}

async function chooseComparator(): Promise<Comparator | undefined> {
    const choices: Array<{ label: string; detail: string; value: Comparator }> = [
        { label: "Ordered equality", detail: "Default structural comparison", value: { kind: "ordered-equality" } },
        { label: "Unordered sequence", detail: "Order-insensitive; duplicate counts matter", value: { kind: "unordered-sequence" } },
        { label: "Set equality", detail: "Order- and duplicate-insensitive", value: { kind: "set-equality" } },
        { label: "Any valid index pair", detail: "Validates a pair against arguments 0 (array) and 1 (target)", value: { kind: "any-valid-index-pair", arrayArg: 0, targetArg: 1 } },
        { label: "Numeric tolerance", detail: "Uses an explicit absolute tolerance", value: { kind: "numeric-tolerance", absoluteTolerance: 0.000001, relativeTolerance: 0 } },
    ];
    const choice = await vscode.window.showQuickPick(choices, { placeHolder: "Choose how to compare this case" });
    return choice ? choice.value : undefined;
}

function validateJsonArray(value: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? undefined : "Arguments must be a JSON array.";
    } catch (error) {
        return error instanceof Error ? error.message : "Enter valid JSON.";
    }
}

function validateJsonValue(value: string): string | undefined {
    try {
        JSON.parse(value);
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : "Enter valid JSON.";
    }
}

function normalizeRunnerResult(result: LocalPythonRunResult): PythonRunResult {
    if (result.status === "ok") {
        const success: PythonRunSuccess = {
            ok: true,
            returnValue: result.returnValue,
            preArgs: result.argsBefore,
            postArgs: result.argsAfter,
            mutated: result.mutated,
            stdout: result.stdout,
            stderr: result.stderr,
        };
        return success;
    }
    const kind: PythonRunFailure["kind"] = result.status === "syntax-error" ? "syntax-error" :
        result.status === "timed-out" ? "timeout" :
            result.status === "output-limit" ? "output-limit" : "runtime-error";
    const traceback: string | undefined = result.syntaxTraceback || result.runtimeTraceback || undefined;
    const message: string = result.runnerError || traceback ||
        (result.status === "timed-out" ? "Local execution timed out." : "Local Python execution failed.");
    return { ok: false, kind, message, traceback, stdout: result.stdout, stderr: result.stderr };
}

function friendlyImportError(error: unknown): string {
    const message: string = error instanceof Error ? error.message : String(error);
    if (/leading zeros in decimal integer literals/i.test(message)) {
        return "The clipboard did not contain Python starter code. Copy the code inside the LeetCode Python editor, not the problem number or title.";
    }
    if (/expected an indented block after function definition/i.test(message)) {
        return "The starter has an empty method body. Copy the complete Python starter; blank LeetCode scaffolds are normalized during clipboard import.";
    }
    return message;
}
