// Copyright (c) 2026.
// Licensed under the MIT license.
/* tslint:disable:interface-name -- public runner models use descriptive names. */

/**
 * A deliberately VS Code-free bridge to a Python LeetCode solution.
 *
 * The Python program is supplied with a JSON request on stdin and writes one
 * marker-prefixed JSON result to stdout.  User output is captured inside the
 * Python process so it cannot corrupt that protocol.
 */

import * as childProcess from "child_process";
import * as path from "path";

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_OUTPUT_CAP_BYTES = 1_024 * 1_024;
const MIN_OUTPUT_CAP_BYTES = 4_096;
const DEFAULT_RECURSION_LIMIT = 2_000;
const MIN_RECURSION_LIMIT = 100;
const TERMINATION_GRACE_MS = 250;
const FORCE_SETTLE_AFTER_MS = 2_000;
const RESULT_MARKER = "__LEETCODE_PYTHON_LOCAL_RESULT__";

export type LocalPythonValue =
    | null
    | boolean
    | number
    | string
    | LocalPythonValue[]
    | { [key: string]: LocalPythonValue };

export type LocalPythonRunStatus =
    | "ok"
    | "syntax-error"
    | "runtime-error"
    | "timed-out"
    | "output-limit"
    | "runner-error";

export interface LocalPythonRunRequest {
    /** Absolute path to the selected Python interpreter. */
    readonly interpreterPath: string;
    /** Absolute path to the saved `solution.py` file. */
    readonly solutionPath: string;
    /** The method to invoke on `Solution`. */
    readonly method: string;
    /** JSON-compatible method arguments, including LeetCode node tags. */
    readonly args: LocalPythonValue[];
    /** Defaults to three seconds. Values below 100ms are clamped. */
    readonly timeoutMs?: number;
    /** Defaults to 1MiB across the child process's stdout and stderr pipes. */
    readonly outputCapBytes?: number;
    /** Defaults to 2,000 and is applied before user-module execution. */
    readonly recursionLimit?: number;
}

/** The request shape command code normally needs to construct. */
export interface PythonRunRequest {
    readonly solutionPath: string;
    readonly method: string;
    readonly args: LocalPythonValue[];
}

/** Optional execution limits for {@link runLocalPython}. */
export interface PythonRunOptions {
    readonly timeoutMs?: number;
    /** Maximum combined stdout/stderr pipe output; defaults to 1MiB. */
    readonly outputLimitBytes?: number;
    /** Python recursion limit for the local child process. */
    readonly recursionLimit?: number;
}

export interface LocalPythonProcessInfo {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly outputLimitExceeded: boolean;
    /** How a requested termination was attempted, if one was needed. */
    readonly termination: string;
    /** Stderr emitted outside the Python harness (normally empty). */
    readonly processStderr: string;
}

/**
 * This shape is intentionally JSON-compatible: command/UI code can write it
 * to a results panel without knowing anything about child processes.
 */
export interface LocalPythonRunResult {
    readonly status: LocalPythonRunStatus;
    readonly returnValue: LocalPythonValue;
    readonly argsBefore: LocalPythonValue[];
    readonly argsAfter: LocalPythonValue[];
    readonly mutated: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly syntaxTraceback: string | null;
    readonly runtimeTraceback: string | null;
    readonly runnerError: string | null;
    readonly process: LocalPythonProcessInfo;
}

export type PythonRunResult = LocalPythonRunResult;

interface PythonHarnessResult {
    readonly status: "ok" | "syntax-error" | "runtime-error" | "output-limit";
    readonly returnValue: LocalPythonValue;
    readonly argsBefore: LocalPythonValue[];
    readonly argsAfter: LocalPythonValue[];
    readonly mutated: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly syntaxTraceback: string | null;
    readonly runtimeTraceback: string | null;
    readonly runnerError: string | null;
}

interface HarnessRequest {
    readonly solutionPath: string;
    readonly method: string;
    readonly args: LocalPythonValue[];
    readonly captureLimitBytes: number;
    readonly protocolLimitBytes: number;
    readonly recursionLimit: number;
}

/**
 * Candidate A's normal import contract. The solution owns ListNode and
 * TreeNode definitions; the harness only looks them up after importing it.
 */
const PYTHON_HARNESS = String.raw`
import contextlib
import importlib.util
import json
import math
import os
import sys
import traceback
from collections import deque

RESULT_MARKER = "__LEETCODE_PYTHON_LOCAL_RESULT__"


class CappedTextBuffer:
    def __init__(self, limit):
        self._limit = max(0, int(limit))
        self._parts = []
        self._size = 0
        self._truncated = False

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        encoded = text.encode("utf-8", "replace")
        remaining = self._limit - self._size
        if remaining <= 0:
            self._truncated = True
            return len(text)
        if len(encoded) <= remaining:
            self._parts.append(text)
            self._size += len(encoded)
            return len(text)
        self._parts.append(encoded[:remaining].decode("utf-8", "ignore"))
        self._size = self._limit
        self._truncated = True
        return len(text)

    def flush(self):
        return None

    def getvalue(self):
        suffix = "\n[output truncated by local runner]" if self._truncated else ""
        return "".join(self._parts) + suffix


def empty_result():
    return {
        "status": "runtime-error",
        "returnValue": None,
        "argsBefore": [],
        "argsAfter": [],
        "mutated": False,
        "stdout": "",
        "stderr": "",
        "syntaxTraceback": None,
        "runtimeTraceback": None,
        "runnerError": None,
    }


def text_limit(value, limit):
    encoded = value.encode("utf-8", "replace")
    if len(encoded) <= limit:
        return value
    return encoded[:limit].decode("utf-8", "ignore") + "\n[truncated]"


def class_from_solution(module, name):
    candidate = getattr(module, name, None)
    if not isinstance(candidate, type):
        raise ValueError(
            "The input requires {0}, but solution.py does not define that class. "
            "Use the uncommented LeetCode starter definition locally.".format(name)
        )
    return candidate


def decode_value(raw, module):
    if isinstance(raw, list):
        return [decode_value(item, module) for item in raw]
    if not isinstance(raw, dict):
        return raw

    value_type = raw.get("$type")
    if value_type == "ListNode":
        node_class = class_from_solution(module, "ListNode")
        values = raw.get("values", [])
        if not isinstance(values, list):
            raise ValueError("ListNode values must be an array")
        head = None
        tail = None
        for raw_value in values:
            node = node_class(decode_value(raw_value, module))
            if head is None:
                head = node
            else:
                tail.next = node
            tail = node
        return head

    if value_type == "TreeNode":
        node_class = class_from_solution(module, "TreeNode")
        values = raw.get("levelOrder", [])
        if not isinstance(values, list):
            raise ValueError("TreeNode levelOrder must be an array")
        if not values or values[0] is None:
            return None
        root = node_class(decode_value(values[0], module))
        queue = deque([root])
        index = 1
        while queue and index < len(values):
            parent = queue.popleft()
            if index < len(values):
                left = values[index]
                index += 1
                if left is not None:
                    parent.left = node_class(decode_value(left, module))
                    queue.append(parent.left)
            if index < len(values):
                right = values[index]
                index += 1
                if right is not None:
                    parent.right = node_class(decode_value(right, module))
                    queue.append(parent.right)
        return root

    return {str(key): decode_value(value, module) for key, value in raw.items()}


def encode_list_node(head, classes):
    values = []
    seen = set()
    node = head
    while node is not None:
        node_id = id(node)
        if node_id in seen:
            return {"$type": "ListNode", "values": values, "cycleDetected": True}
        seen.add(node_id)
        values.append(encode_value(getattr(node, "val", None), classes, set()))
        node = getattr(node, "next", None)
    return {"$type": "ListNode", "values": values}


def encode_tree_node(root, classes):
    values = []
    queue = deque([root])
    seen = set()
    while queue:
        node = queue.popleft()
        if node is None:
            values.append(None)
            continue
        node_id = id(node)
        if node_id in seen:
            return {"$type": "TreeNode", "levelOrder": values, "cycleDetected": True}
        seen.add(node_id)
        values.append(encode_value(getattr(node, "val", None), classes, set()))
        queue.append(getattr(node, "left", None))
        queue.append(getattr(node, "right", None))
    while values and values[-1] is None:
        values.pop()
    return {"$type": "TreeNode", "levelOrder": values}


def encode_value(value, classes, active):
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        return {"$type": "float", "value": repr(value)}

    list_node_class = classes.get("ListNode")
    if list_node_class is not None and isinstance(value, list_node_class):
        return encode_list_node(value, classes)
    tree_node_class = classes.get("TreeNode")
    if tree_node_class is not None and isinstance(value, tree_node_class):
        return encode_tree_node(value, classes)

    value_id = id(value)
    if value_id in active:
        return {"$type": "cycle", "repr": safe_repr(value)}
    active.add(value_id)
    try:
        if isinstance(value, (list, tuple)):
            return [encode_value(item, classes, active) for item in value]
        if isinstance(value, dict):
            return {str(key): encode_value(item, classes, active) for key, item in value.items()}
        if isinstance(value, set):
            return {
                "$type": "set",
                "values": [encode_value(item, classes, active) for item in value],
            }
        return {"$type": "repr", "value": safe_repr(value)}
    finally:
        active.remove(value_id)


def safe_repr(value):
    try:
        return repr(value)
    except Exception:
        return "<unrepresentable value>"


def load_solution(solution_path):
    module_name = "_leetcode_local_solution"
    solution_dir = os.path.dirname(os.path.abspath(solution_path))
    if solution_dir not in sys.path:
        sys.path.insert(0, solution_dir)
    spec = importlib.util.spec_from_file_location(module_name, solution_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not create an import specification for solution.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def run(request):
    result = empty_result()
    capture_limit = max(0, int(request.get("captureLimitBytes", 65536)))
    recursion_limit = max(100, int(request.get("recursionLimit", 2000)))
    stdout_buffer = CappedTextBuffer(capture_limit)
    stderr_buffer = CappedTextBuffer(capture_limit)
    module = None
    args = None

    try:
        sys.setrecursionlimit(recursion_limit)
        solution_path = request["solutionPath"]
        method_name = request["method"]
        raw_args = request["args"]
        if not isinstance(solution_path, str) or not solution_path:
            raise ValueError("solutionPath must be a non-empty string")
        if not isinstance(method_name, str) or not method_name:
            raise ValueError("method must be a non-empty string")
        if not isinstance(raw_args, list):
            raise ValueError("args must be an array")

        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
            module = load_solution(solution_path)
            classes = {
                "ListNode": getattr(module, "ListNode", None),
                "TreeNode": getattr(module, "TreeNode", None),
            }
            args = [decode_value(item, module) for item in raw_args]
            result["argsBefore"] = encode_value(args, classes, set())
            solution_class = getattr(module, "Solution", None)
            if not isinstance(solution_class, type):
                raise ValueError("solution.py must define a Solution class")
            method = getattr(solution_class(), method_name, None)
            if not callable(method):
                raise ValueError("Solution does not define a callable {0} method".format(method_name))
            returned = method(*args)
            result["returnValue"] = encode_value(returned, classes, set())
            result["status"] = "ok"
    except SyntaxError:
        result["status"] = "syntax-error"
        result["syntaxTraceback"] = traceback.format_exc()
    except Exception:
        result["status"] = "runtime-error"
        result["runtimeTraceback"] = traceback.format_exc()
    finally:
        if module is not None and args is not None:
            try:
                classes = {
                    "ListNode": getattr(module, "ListNode", None),
                    "TreeNode": getattr(module, "TreeNode", None),
                }
                result["argsAfter"] = encode_value(args, classes, set())
                result["mutated"] = result["argsBefore"] != result["argsAfter"]
            except Exception:
                if result["runtimeTraceback"] is None:
                    result["status"] = "runtime-error"
                    result["runtimeTraceback"] = traceback.format_exc()
        result["stdout"] = stdout_buffer.getvalue()
        result["stderr"] = stderr_buffer.getvalue()
        result["syntaxTraceback"] = (
            text_limit(result["syntaxTraceback"], capture_limit)
            if result["syntaxTraceback"] is not None else None
        )
        result["runtimeTraceback"] = (
            text_limit(result["runtimeTraceback"], capture_limit)
            if result["runtimeTraceback"] is not None else None
        )
    return result


def fit_protocol_limit(result, limit):
    encoded = json.dumps(result, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode("utf-8")) <= limit:
        return encoded
    compact = empty_result()
    compact["status"] = "output-limit"
    compact["runnerError"] = "The encoded local-run result exceeded the output cap."
    encoded = json.dumps(compact, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
    return encoded


def main():
    protocol_stdout = sys.stdout
    try:
        request = json.loads(sys.stdin.read())
        if not isinstance(request, dict):
            raise ValueError("runner request must be a JSON object")
        result = run(request)
        protocol_limit = max(1024, int(request.get("protocolLimitBytes", 524288)))
    except Exception:
        result = empty_result()
        result["status"] = "runtime-error"
        result["runtimeTraceback"] = traceback.format_exc()
        protocol_limit = 524288
    protocol_stdout.write(RESULT_MARKER + fit_protocol_limit(result, protocol_limit) + "\n")
    protocol_stdout.flush()


if __name__ == "__main__":
    main()
`;

/**
 * Runs a saved Python solution without a shell. On POSIX the child is placed
 * in a new process group so a timeout can terminate helper subprocesses too.
 */
export async function runLocalPythonSolution(request: LocalPythonRunRequest): Promise<LocalPythonRunResult> {
    const timeoutMs = normaliseTimeout(request.timeoutMs);
    const outputCapBytes = normaliseOutputCap(request.outputCapBytes);
    const recursionLimit = normaliseRecursionLimit(request.recursionLimit);
    const harnessRequest: HarnessRequest = {
        solutionPath: request.solutionPath,
        method: request.method,
        args: request.args,
        // Keep the final protocol far below the Node-side pipe cap.
        captureLimitBytes: Math.max(256, Math.floor(outputCapBytes / 8)),
        protocolLimitBytes: Math.max(1_024, Math.floor(outputCapBytes / 2)),
        recursionLimit,
    };

    let child: childProcess.ChildProcess;
    try {
        child = childProcess.spawn(request.interpreterPath, ["-I", "-c", PYTHON_HARNESS], {
            cwd: path.dirname(request.solutionPath),
            detached: process.platform !== "win32",
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch (error) {
        return runnerFailure("Could not start the configured Python interpreter: " + errorMessage(error));
    }

    return new Promise<LocalPythonRunResult>((resolve) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let capturedBytes = 0;
        let timedOut = false;
        let outputLimitExceeded = false;
        let termination = "not requested";
        let spawnError: string | null = null;
        let closed = false;
        let terminationRequested = false;
        let forceSettleTimer: NodeJS.Timeout | undefined;
        let timeoutTimer: NodeJS.Timeout | undefined;

        const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
            if (closed) {
                return;
            }
            closed = true;
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
            }
            if (forceSettleTimer) {
                clearTimeout(forceSettleTimer);
            }
            const processInfo: LocalPythonProcessInfo = {
                exitCode,
                signal,
                timedOut,
                outputLimitExceeded,
                termination,
                processStderr: Buffer.concat(stderrChunks).toString("utf8"),
            };

            if (timedOut) {
                resolve(runnerFailure("Local execution timed out after " + timeoutMs + "ms.", processInfo, "timed-out"));
                return;
            }
            if (outputLimitExceeded) {
                resolve(runnerFailure("Local execution exceeded the " + outputCapBytes + " byte output cap.", processInfo, "output-limit"));
                return;
            }
            if (spawnError) {
                resolve(runnerFailure(spawnError, processInfo));
                return;
            }

            const payload = parseHarnessResult(Buffer.concat(stdoutChunks).toString("utf8"));
            if (!payload) {
                const exitDetail = exitCode === null ? "no exit code" : "exit code " + exitCode;
                resolve(runnerFailure(
                    "The Python runner did not return a structured result (" + exitDetail + ").",
                    processInfo,
                ));
                return;
            }
            resolve({ ...payload, process: processInfo });
        };

        const terminate = (reason: "timeout" | "output cap" | "request failure"): void => {
            if (closed || terminationRequested || !child.pid) {
                return;
            }
            terminationRequested = true;
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
            }
            if (process.platform === "win32") {
                termination = "requested taskkill /pid " + child.pid + " /T /F for " + reason;
                try {
                    const taskkill = childProcess.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                        detached: false,
                        shell: false,
                        stdio: "ignore",
                    });
                    taskkill.once("error", () => {
                        termination = "taskkill request failed for " + reason;
                    });
                } catch (_error) {
                    termination = "taskkill request failed for " + reason;
                }
            } else {
                try {
                    process.kill(-child.pid, "SIGTERM");
                    termination = "sent SIGTERM to detached process group for " + reason;
                } catch (_error) {
                    try {
                        child.kill("SIGTERM");
                        termination = "sent SIGTERM to child process for " + reason;
                    } catch (_childKillError) {
                        termination = "could not send SIGTERM for " + reason;
                    }
                }
                setTimeout(() => {
                    if (closed || !child.pid) {
                        return;
                    }
                    try {
                        process.kill(-child.pid, "SIGKILL");
                        termination = "sent SIGTERM then SIGKILL to detached process group for " + reason;
                    } catch (_error) {
                        try {
                            child.kill("SIGKILL");
                            termination = "sent SIGTERM then SIGKILL to child process for " + reason;
                        } catch (_childKillError) {
                            termination = "SIGTERM was sent; SIGKILL fallback failed for " + reason;
                        }
                    }
                }, TERMINATION_GRACE_MS);
            }
            forceSettleTimer = setTimeout(() => {
                finish(null, null);
            }, FORCE_SETTLE_AFTER_MS);
        };

        const appendChunk = (chunks: Buffer[], chunk: Buffer | string): void => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = outputCapBytes - capturedBytes;
            if (remaining > 0) {
                chunks.push(buffer.length <= remaining ? buffer : buffer.slice(0, remaining));
                capturedBytes += Math.min(buffer.length, remaining);
            }
            if (buffer.length > remaining && !outputLimitExceeded) {
                outputLimitExceeded = true;
                terminate("output cap");
            }
        };

        if (!child.stdout || !child.stderr || !child.stdin) {
            spawnError = "The configured Python process did not provide standard input/output pipes.";
            finish(child.exitCode, child.signalCode);
            return;
        }

        timeoutTimer = setTimeout(() => {
            if (!closed) {
                timedOut = true;
                terminate("timeout");
            }
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer | string) => appendChunk(stdoutChunks, chunk));
        child.stderr.on("data", (chunk: Buffer | string) => appendChunk(stderrChunks, chunk));
        child.once("error", (error: Error) => {
            spawnError = "Could not start the configured Python interpreter: " + error.message;
            finish(child.exitCode, child.signalCode);
        });
        child.stdout.once("error", (error: Error) => {
            spawnError = "Could not read local Python stdout: " + error.message;
            terminate("request failure");
        });
        child.stderr.once("error", (error: Error) => {
            spawnError = "Could not read local Python stderr: " + error.message;
            terminate("request failure");
        });
        child.stdin.once("error", (error: Error) => {
            spawnError = "Could not send the local-run request to Python: " + error.message;
            terminate("request failure");
        });
        child.once("close", finish);

        try {
            child.stdin.end(JSON.stringify(harnessRequest));
        } catch (error) {
            spawnError = "Could not send the local-run request to Python: " + errorMessage(error);
            terminate("request failure");
        }
    });
}

/**
 * Executes one saved Python LeetCode solution using the selected interpreter.
 * This is the integration-facing API; it never invokes a shell.
 */
export function runLocalPython(
    pythonPath: string,
    request: PythonRunRequest,
    options: PythonRunOptions = {},
): Promise<PythonRunResult> {
    return runLocalPythonSolution({
        interpreterPath: pythonPath,
        solutionPath: request.solutionPath,
        method: request.method,
        args: request.args,
        timeoutMs: options.timeoutMs,
        outputCapBytes: options.outputLimitBytes,
        recursionLimit: options.recursionLimit,
    });
}

function normaliseTimeout(value: number | undefined): number {
    if (value === undefined || !isFinite(value)) {
        return DEFAULT_TIMEOUT_MS;
    }
    return Math.max(100, Math.floor(value));
}

function normaliseOutputCap(value: number | undefined): number {
    if (value === undefined || !isFinite(value)) {
        return DEFAULT_OUTPUT_CAP_BYTES;
    }
    return Math.max(MIN_OUTPUT_CAP_BYTES, Math.floor(value));
}

function normaliseRecursionLimit(value: number | undefined): number {
    if (value === undefined || !isFinite(value)) {
        return DEFAULT_RECURSION_LIMIT;
    }
    return Math.max(MIN_RECURSION_LIMIT, Math.floor(value));
}

function parseHarnessResult(stdout: string): PythonHarnessResult | undefined {
    const markerIndex = stdout.lastIndexOf(RESULT_MARKER);
    if (markerIndex === -1) {
        return undefined;
    }
    const jsonStart = markerIndex + RESULT_MARKER.length;
    const lineEnd = stdout.indexOf("\n", jsonStart);
    const json = stdout.slice(jsonStart, lineEnd === -1 ? stdout.length : lineEnd).trim();
    if (!json) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(json);
        if (!isHarnessResult(parsed)) {
            return undefined;
        }
        return parsed;
    } catch (_error) {
        return undefined;
    }
}

function isHarnessResult(value: unknown): value is PythonHarnessResult {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value as { [key: string]: unknown };
    return (
        (candidate.status === "ok" ||
            candidate.status === "syntax-error" ||
            candidate.status === "runtime-error" ||
            candidate.status === "output-limit") &&
        Array.isArray(candidate.argsBefore) &&
        Array.isArray(candidate.argsAfter) &&
        typeof candidate.mutated === "boolean" &&
        typeof candidate.stdout === "string" &&
        typeof candidate.stderr === "string" &&
        (typeof candidate.syntaxTraceback === "string" || candidate.syntaxTraceback === null) &&
        (typeof candidate.runtimeTraceback === "string" || candidate.runtimeTraceback === null) &&
        (typeof candidate.runnerError === "string" || candidate.runnerError === null)
    );
}

function runnerFailure(
    runnerError: string,
    process?: LocalPythonProcessInfo,
    status: LocalPythonRunStatus = "runner-error",
): LocalPythonRunResult {
    return {
        status,
        returnValue: null,
        argsBefore: [],
        argsAfter: [],
        mutated: false,
        stdout: "",
        stderr: "",
        syntaxTraceback: null,
        runtimeTraceback: null,
        runnerError,
        process:
            process || {
                exitCode: null,
                signal: null,
                timedOut: false,
                outputLimitExceeded: false,
                termination: "not started",
                processStderr: "",
            },
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
