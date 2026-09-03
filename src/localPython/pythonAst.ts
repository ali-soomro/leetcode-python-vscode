// Copyright (c) 2026 Ali Soomro. All rights reserved.
// Licensed under the MIT license.
/* tslint:disable:interface-name -- public parser models use descriptive names. */

import * as childProcess from "child_process";
import { ParsedStarter } from "./models";
import { normalizeStarterSource } from "./sourceTemplate";

/** The parsed result also returns the exact source that was passed to Python. */
export interface ClipboardStarterParseResult {
    normalizedSource: string;
    starter: ParsedStarter;
}

const parserProgram: string = String.raw`
import ast
import json
import sys

SUPPORTED_TYPING_NAMES = {"List", "Optional", "Dict"}

source = sys.stdin.read()
try:
    module = ast.parse(source, filename="<clipboard>")
    # ast.parse does not guarantee all compiler-level placement checks on all
    # supported Python releases. Compile without executing to validate them.
    compile(module, "<clipboard>", "exec")
except SyntaxError as error:
    print(json.dumps({"ok": False, "error": "Syntax error on line {}: {}".format(error.lineno, error.msg)}))
    raise SystemExit(0)

solution = next((node for node in module.body if isinstance(node, ast.ClassDef) and node.name == "Solution"), None)
if solution is None:
    print(json.dumps({"ok": False, "error": "Clipboard source has no top-level class Solution"}))
    raise SystemExit(0)

methods = [node for node in solution.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_")]
if len(methods) != 1:
    print(json.dumps({"ok": False, "error": "Solution must contain exactly one public method for local Python import"}))
    raise SystemExit(0)

method = methods[0]
if method.args.vararg is not None or method.args.kwarg is not None or method.args.kwonlyargs:
    print(json.dumps({"ok": False, "error": "The Solution method must use ordinary positional parameters for local Python import"}))
    raise SystemExit(0)

arguments = list(method.args.posonlyargs) + list(method.args.args)
if arguments and arguments[0].arg == "self":
    arguments = arguments[1:]

def render(node):
    if node is None:
        return None
    rendered = ast.get_source_segment(source, node)
    if rendered is not None:
        return rendered
    unparse = getattr(ast, "unparse", None)
    return unparse(node) if unparse is not None else None

typing_names = set()
for annotation in [argument.annotation for argument in arguments] + [method.returns]:
    if annotation is None:
        continue
    for descendant in ast.walk(annotation):
        if isinstance(descendant, ast.Name) and descendant.id in SUPPORTED_TYPING_NAMES:
            typing_names.add(descendant.id)

typing_imports = []
for node in module.body:
    if isinstance(node, ast.ImportFrom) and node.module == "typing":
        # A direct import is safe to merge. Preserve aliases/star imports and
        # let TypeScript add a second direct import only when one is needed.
        if all(alias.asname is None and alias.name != "*" for alias in node.names):
            typing_imports.append({"line": node.lineno, "endLine": node.end_lineno, "names": [alias.name for alias in node.names]})

insertion_line = 0
body = module.body
index = 0
if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) and isinstance(body[0].value.value, str):
    insertion_line = body[0].end_lineno
    index = 1
while index < len(body) and isinstance(body[index], ast.ImportFrom) and body[index].module == "__future__":
    insertion_line = body[index].end_lineno
    index += 1

parameters = []
for argument in arguments:
    parameter = {"name": argument.arg}
    annotation = render(argument.annotation)
    if annotation is not None:
        parameter["annotation"] = annotation
    parameters.append(parameter)

value = {
    "methodName": method.name,
    "parameters": parameters,
    "requiredTypingNames": sorted(typing_names),
    "typingImports": typing_imports,
    "insertionLine": insertion_line,
}
return_annotation = render(method.returns)
if return_annotation is not None:
    value["returnAnnotation"] = return_annotation

print(json.dumps({"ok": True, "value": value}))
`;

/**
 * Normalize LeetCode's blank copied scaffold, then use the configured Python
 * interpreter's `ast` module to derive its one public Solution method.
 */
export async function parseClipboardStarter(pythonPath: string, source: string): Promise<ClipboardStarterParseResult> {
    const normalizedSource: string = normalizeStarterSource(source);
    const starter: ParsedStarter = await parsePythonStarter(pythonPath, normalizedSource);
    return { normalizedSource, starter };
}

/**
 * Compatibility entry point for the import flow. It accepts raw clipboard
 * text, performs the same narrow blank-scaffold normalization, and returns
 * only method metadata. Use parseClipboardStarter when the normalized source
 * is also needed by the caller.
 */
export async function parseStarter(pythonPath: string, source: string): Promise<ParsedStarter> {
    const parsed: ClipboardStarterParseResult = await parseClipboardStarter(pythonPath, source);
    return parsed.starter;
}

/** Parse already-normalized source. Most callers should use parseClipboardStarter. */
export async function parsePythonStarter(pythonPath: string, source: string): Promise<ParsedStarter> {
    const interpreter: string = pythonPath.trim();
    if (!interpreter) {
        throw new Error("A Python interpreter is required to import a LeetCode starter. Select one and try again.");
    }

    const response: string = await runPythonParser(interpreter, source);
    let payload: ParserResponse;
    try {
        payload = JSON.parse(response) as ParserResponse;
    } catch (_error) {
        throw new Error("The selected Python interpreter did not return a valid starter parse result.");
    }
    if (!payload.ok || !payload.value) {
        throw new Error(payload.error || "Unable to parse clipboard source.");
    }
    return payload.value;
}

interface ParserResponse {
    ok: boolean;
    error?: string;
    value?: ParsedStarter;
}

function runPythonParser(pythonPath: string, source: string): Promise<string> {
    return new Promise<string>((resolve: (value: string) => void, reject: (reason: Error) => void) => {
        let stdout: string = "";
        let stderr: string = "";
        let settled: boolean = false;
        let child: childProcess.ChildProcess;

        const fail = (error: Error): void => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        };

        try {
            child = childProcess.spawn(pythonPath, ["-I", "-c", parserProgram], { stdio: ["pipe", "pipe", "pipe"] });
        } catch (error) {
            fail(new Error(`Could not start Python interpreter '${pythonPath}': ${error.message}`));
            return;
        }

        const stdoutStream: NodeJS.ReadableStream | null = child.stdout;
        const stderrStream: NodeJS.ReadableStream | null = child.stderr;
        const stdinStream: NodeJS.WritableStream | null = child.stdin;
        if (!stdoutStream || !stderrStream || !stdinStream) {
            fail(new Error("Unable to open standard streams for the selected Python interpreter."));
            return;
        }
        stdoutStream.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        stderrStream.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on("error", (error: Error) => {
            fail(new Error(`Could not start Python interpreter '${pythonPath}': ${error.message}`));
        });
        child.on("close", (code: number | null) => {
            if (settled) {
                return;
            }
            settled = true;
            if (code !== 0) {
                reject(new Error(stderr.trim() || `Python parser exited with status ${code}.`));
                return;
            }
            resolve(stdout);
        });
        stdinStream.end(source, "utf8");
    });
}
