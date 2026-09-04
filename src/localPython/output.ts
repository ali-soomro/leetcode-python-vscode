// Copyright (c) 2026 Ali Soomro. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { ComparisonResult, LocalCase, PythonRunFailure, PythonRunSuccess } from "./models";

class LocalPythonOutput implements vscode.Disposable {
    private readonly channel: vscode.OutputChannel = vscode.window.createOutputChannel("LeetCode Python Local");

    public showSuccess(caseDefinition: LocalCase, result: PythonRunSuccess, comparison: ComparisonResult): void {
        this.channel.clear();
        this.channel.appendLine(comparison.label);
        if (comparison.detail) {
            this.channel.appendLine(comparison.detail);
        }
        this.channel.appendLine("");
        this.channel.appendLine(`Case: ${caseDefinition.name}`);
        this.channel.appendLine(`Input: ${JSON.stringify(caseDefinition.args)}`);
        this.channel.appendLine(`Returned: ${JSON.stringify(result.returnValue)}`);
        if (result.mutated) {
            this.channel.appendLine(`Post-call arguments: ${JSON.stringify(result.postArgs)}`);
        }
        if (result.stdout) {
            this.channel.appendLine("");
            this.channel.appendLine("Captured stdout:");
            this.channel.appendLine(result.stdout);
        }
        if (result.stderr) {
            this.channel.appendLine("");
            this.channel.appendLine("Captured stderr:");
            this.channel.appendLine(result.stderr);
        }
        this.channel.show(true);
    }

    public showFailure(caseDefinition: LocalCase, result: PythonRunFailure): void {
        this.channel.clear();
        this.channel.appendLine(`Local run failed: ${result.message}`);
        this.channel.appendLine("");
        this.channel.appendLine(`Case: ${caseDefinition.name}`);
        this.channel.appendLine(`Input: ${JSON.stringify(caseDefinition.args)}`);
        if (result.traceback) {
            this.channel.appendLine("");
            this.channel.appendLine(result.traceback);
        }
        if (result.stdout) {
            this.channel.appendLine("");
            this.channel.appendLine("Captured stdout:");
            this.channel.appendLine(result.stdout);
        }
        if (result.stderr) {
            this.channel.appendLine("");
            this.channel.appendLine("Captured stderr:");
            this.channel.appendLine(result.stderr);
        }
        this.channel.show(true);
    }

    public dispose(): void {
        this.channel.dispose();
    }
}

export const localPythonOutput: LocalPythonOutput = new LocalPythonOutput();
