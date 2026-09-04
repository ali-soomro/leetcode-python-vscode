// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { codeLensController } from "./codelens/CodeLensController";
import * as cache from "./commands/cache";
import { switchDefaultLanguage } from "./commands/language";
import * as plugin from "./commands/plugin";
import * as session from "./commands/session";
import * as show from "./commands/show";
import * as star from "./commands/star";
import * as submit from "./commands/submit";
import * as test from "./commands/test";
import * as localPython from "./commands/localPython";
import { explorerNodeManager } from "./explorer/explorerNodeManager";
import { LeetCodeNode } from "./explorer/LeetCodeNode";
import { leetCodeTreeDataProvider } from "./explorer/LeetCodeTreeDataProvider";
import { leetCodeTreeItemDecorationProvider } from "./explorer/LeetCodeTreeItemDecorationProvider";
import { leetCodeChannel } from "./leetCodeChannel";
import { leetCodeExecutor } from "./leetCodeExecutor";
import { leetCodeManager } from "./leetCodeManager";
import { leetCodeStatusBarController } from "./statusbar/leetCodeStatusBarController";
import { DialogType, promptForOpenOutputChannel } from "./utils/uiUtils";
import { leetCodePreviewProvider } from "./webview/leetCodePreviewProvider";
import { leetCodeSolutionProvider } from "./webview/leetCodeSolutionProvider";
import { leetCodeSubmissionProvider } from "./webview/leetCodeSubmissionProvider";
import { markdownEngine } from "./webview/markdownEngine";
import TrackData from "./utils/trackingUtils";
import { globalState } from "./globalState";
import { localPythonOutput } from "./localPython/output";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // The Python-local workflow deliberately has no account, browser, or
    // bundled CLI dependency. Keep its activation separate from the inherited
    // remote bootstrap: invoking a local command must not install a plugin,
    // touch a LeetCode session, or remove the legacy CLI cache.
    context.subscriptions.push(
        localPythonOutput,
        codeLensController,
        vscode.commands.registerCommand("leetcodePythonLocal.importStarter", () => localPython.importStarterFromClipboard()),
        vscode.commands.registerCommand("leetcodePythonLocal.runLocal", (uri?: vscode.Uri) => localPython.runActivePythonSolution(uri)),
        vscode.commands.registerCommand("leetcodePythonLocal.addCase", (uri?: vscode.Uri) => localPython.addLocalAssertionCase(uri)),
    );

    // The inherited explorer is still available, but opening it is an explicit
    // request for the historical remote functionality and so initializes it on
    // demand. This is also what makes `onView:leetCodeExplorer` work without
    // bootstrapping that functionality for a local-only command.
    leetCodeTreeDataProvider.initialize(context, () => invokeInheritedFeature(context, async () => undefined));
    context.subscriptions.push(
        vscode.window.createTreeView("leetCodeExplorer", { treeDataProvider: leetCodeTreeDataProvider, showCollapseAll: true }),
        vscode.commands.registerCommand("leetcode.deleteCache", () => invokeInheritedFeature(context, () => cache.deleteCache())),
        vscode.commands.registerCommand("leetcode.toggleLeetCodeCn", () => invokeInheritedFeature(context, () => plugin.switchEndpoint())),
        vscode.commands.registerCommand("leetcode.signin", () => invokeInheritedFeature(context, () => leetCodeManager.signIn())),
        vscode.commands.registerCommand("leetcode.signout", () => invokeInheritedFeature(context, () => leetCodeManager.signOut())),
        vscode.commands.registerCommand("leetcode.manageSessions", () => invokeInheritedFeature(context, () => session.manageSessions())),
        vscode.commands.registerCommand("leetcode.previewProblem", (node: LeetCodeNode) => invokeInheritedFeature(context, async () => {
            TrackData.report({
                event_key: `vscode_open_problem`,
                type: "click",
                extra: JSON.stringify({
                    problem_id: node.id,
                    problem_name: node.name,
                }),
            });
            return show.previewProblem(node);
        })),
        vscode.commands.registerCommand("leetcode.showProblem", (node: LeetCodeNode) =>
            invokeInheritedFeature(context, () => show.showProblem(node))),
        vscode.commands.registerCommand("leetcode.pickOne", () => invokeInheritedFeature(context, () => show.pickOne())),
        vscode.commands.registerCommand("leetcode.searchProblem", () => invokeInheritedFeature(context, () => show.searchProblem())),
        vscode.commands.registerCommand("leetcode.showSolution", (input: LeetCodeNode | vscode.Uri) =>
            invokeInheritedFeature(context, () => show.showSolution(input))),
        vscode.commands.registerCommand("leetcode.refreshExplorer", () =>
            invokeInheritedFeature(context, () => leetCodeTreeDataProvider.refresh())),
        vscode.commands.registerCommand("leetcode.testSolution", (uri?: vscode.Uri) => invokeInheritedFeature(context, () => {
            TrackData.report({
                event_key: `vscode_runCode`,
                type: "click",
                extra: JSON.stringify({
                    path: uri?.path,
                }),
            });
            return test.testSolution(uri);
        })),
        vscode.commands.registerCommand("leetcode.submitSolution", (uri?: vscode.Uri) => invokeInheritedFeature(context, () => {
            TrackData.report({
                event_key: `vscode_submit`,
                type: "click",
                extra: JSON.stringify({
                    path: uri?.path,
                }),
            });
            return submit.submitSolution(uri);
        })),
        vscode.commands.registerCommand("leetcode.switchDefaultLanguage", () =>
            invokeInheritedFeature(context, () => switchDefaultLanguage())),
        vscode.commands.registerCommand("leetcode.addFavorite", (node: LeetCodeNode) =>
            invokeInheritedFeature(context, () => star.addFavorite(node))),
        vscode.commands.registerCommand("leetcode.removeFavorite", (node: LeetCodeNode) =>
            invokeInheritedFeature(context, () => star.removeFavorite(node))),
        vscode.commands.registerCommand("leetcode.problems.sort", () =>
            invokeInheritedFeature(context, () => plugin.switchSortingStrategy())),
    );
}

let inheritedInitialization: Promise<void> | undefined;
let inheritedSetupComplete: boolean = false;

async function invokeInheritedFeature<T>(
    context: vscode.ExtensionContext,
    action: () => Promise<T> | T,
): Promise<T | undefined> {
    try {
        await ensureInheritedFeatures(context);
        return await action();
    } catch (error) {
        leetCodeChannel.appendLine(String(error));
        await promptForOpenOutputChannel("Inherited LeetCode functionality could not start. Please open output for details.", DialogType.error);
        return undefined;
    }
}

function ensureInheritedFeatures(context: vscode.ExtensionContext): Promise<void> {
    if (!inheritedInitialization) {
        inheritedInitialization = initializeInheritedFeatures(context).catch((error: unknown) => {
            // A failed remote initialization must be retryable. Local features
            // were never part of this promise and remain unaffected.
            inheritedInitialization = undefined;
            throw error;
        });
    }
    return inheritedInitialization;
}

async function initializeInheritedFeatures(context: vscode.ExtensionContext): Promise<void> {
    if (!(await leetCodeExecutor.meetRequirements(context))) {
        throw new Error("The environment doesn't meet requirements.");
    }

    if (!inheritedSetupComplete) {
        leetCodeManager.on("statusChanged", () => {
            leetCodeStatusBarController.updateStatusBar(leetCodeManager.getStatus(), leetCodeManager.getUser());
            void leetCodeTreeDataProvider.refresh();
        });
        globalState.initialize(context);
        context.subscriptions.push(
            leetCodeStatusBarController,
            leetCodeChannel,
            leetCodePreviewProvider,
            leetCodeSubmissionProvider,
            leetCodeSolutionProvider,
            leetCodeExecutor,
            markdownEngine,
            explorerNodeManager,
            vscode.window.registerFileDecorationProvider(leetCodeTreeItemDecorationProvider),
            vscode.window.registerUriHandler({ handleUri: leetCodeManager.handleUriSignIn }),
        );
        inheritedSetupComplete = true;
    }

    await leetCodeExecutor.switchEndpoint(plugin.getLeetCodeEndpoint());
    await leetCodeManager.getLoginStatus();
}

export function deactivate(): void {
    // Do nothing.
}
