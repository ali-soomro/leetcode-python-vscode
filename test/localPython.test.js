const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { compareRun } = require("../out/src/localPython/comparators");
const { runLocalPython } = require("../out/src/localPython/runner");
const { prepareCandidateASourceDetailed } = require("../out/src/localPython/sourceTemplate");
const { parseClipboardStarter } = require("../out/src/localPython/pythonAst");
const { prepareNewPythonStarter } = require("../out/src/localPython/generatedStarter");

const root = path.resolve(__dirname, "..");
const fixtures = path.join(root, "test", "fixtures");
const python = process.env.LEETCODE_PYTHON || "python3";

async function main() {
    await testPrimitiveRun();
    await testListNodeRun();
    await testTreeNodeRun();
    await testSyntaxError();
    await testTimeout();
    await testOutputLimit();
    await testClipboardParserAndCandidateA();
    await testGeneratedStarterPreparation();
    testCandidateASourceTemplate();
    testComparators();
    console.log("local Python tests passed");
}

async function testPrimitiveRun() {
    const result = await runLocalPython(
        python,
        {
            solutionPath: path.join(fixtures, "primitive_solution.py"),
            method: "twoSum",
            args: [[2, 7, 11, 15], 9],
        },
        { timeoutMs: 3000, outputLimitBytes: 1024 * 1024 },
    );
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(result.returnValue, [0, 1]);
    assert.strictEqual(result.mutated, false);
}

async function testListNodeRun() {
    const result = await runLocalPython(
        python,
        {
            solutionPath: path.join(fixtures, "listnode_solution.py"),
            method: "reverseList",
            args: [{ $type: "ListNode", values: [1, 2, 3] }],
        },
        { timeoutMs: 3000, outputLimitBytes: 1024 * 1024 },
    );
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(result.returnValue, { $type: "ListNode", values: [3, 2, 1] });
    assert.strictEqual(result.mutated, true);
}

async function testTreeNodeRun() {
    const result = await runLocalPython(
        python,
        {
            solutionPath: path.join(fixtures, "treenode_solution.py"),
            method: "maxDepth",
            args: [{ $type: "TreeNode", levelOrder: [3, 9, 20, null, null, 15, 7] }],
        },
        { timeoutMs: 3000, outputLimitBytes: 1024 * 1024 },
    );
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.returnValue, 3);
}

async function testSyntaxError() {
    const result = await runLocalPython(
        python,
        {
            solutionPath: path.join(fixtures, "syntax_error_solution.py"),
            method: "broken",
            args: [1],
        },
        { timeoutMs: 3000, outputLimitBytes: 1024 * 1024 },
    );
    assert.strictEqual(result.status, "syntax-error");
    assert.match(result.syntaxTraceback || "", /syntax_error_solution.py/);
}

async function testTimeout() {
    const result = await runLocalPython(
        python,
        {
            solutionPath: path.join(fixtures, "infinite_solution.py"),
            method: "spin",
            args: [],
        },
        { timeoutMs: 150, outputLimitBytes: 1024 * 1024 },
    );
    assert.strictEqual(result.status, "timed-out");
    assert.strictEqual(result.process.timedOut, true);
}

async function testOutputLimit() {
    const result = await runLocalPython(
        python,
        {
            solutionPath: path.join(fixtures, "output_flood_solution.py"),
            method: "flood",
            args: [],
        },
        { timeoutMs: 3000, outputLimitBytes: 4096 },
    );
    assert.strictEqual(result.status, "output-limit");
    assert.strictEqual(result.process.outputLimitExceeded, true);
}

async function testClipboardParserAndCandidateA() {
    const source = "from __future__ import annotations\n\nclass Solution:\n    def reverseList(self, head: Optional[ListNode]) -> Optional[ListNode]:\n";
    const parsed = await parseClipboardStarter(python, source);
    assert.strictEqual(parsed.starter.methodName, "reverseList");
    assert.deepStrictEqual(parsed.starter.requiredTypingNames, ["Optional"]);
    const prepared = prepareCandidateASourceDetailed(parsed.normalizedSource, parsed.starter);
    assert.match(prepared.source, /^from __future__ import annotations\nfrom typing import Optional/m);
    assert.match(prepared.source, /class ListNode:/);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leetcode-python-local-"));
    const solutionPath = path.join(directory, "solution.py");
    try {
        fs.writeFileSync(solutionPath, prepared.source, "utf8");
        const result = await runLocalPython(
            python,
            {
                solutionPath,
                method: "reverseList",
                args: [{ $type: "ListNode", values: [1, 2] }],
            },
            { timeoutMs: 3000, outputLimitBytes: 1024 * 1024 },
        );
        assert.strictEqual(result.status, "ok");
        assert.strictEqual(result.returnValue, null);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function testGeneratedStarterPreparation() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leetcode-python-generated-"));
    const solutionPath = path.join(directory, "solution.py");
    const source = "# @lc app=leetcode id=206 lang=python3\n# @lc code=start\nclass Solution:\n    def reverseList(self, head: Optional[ListNode]) -> Optional[ListNode]:\n# @lc code=end\n";
    try {
        fs.writeFileSync(solutionPath, source, "utf8");
        const prepared = await prepareNewPythonStarter(python, solutionPath);
        assert.deepStrictEqual(prepared.addedPlatformTypes, ["ListNode"]);
        const saved = fs.readFileSync(solutionPath, "utf8");
        assert.match(saved, /^# @lc app=leetcode id=206 lang=python3\n# @lc code=start\nfrom typing import Optional/m);
        assert.match(saved, /from typing import Optional/);
        assert.match(saved, /class ListNode:/);
        assert.match(saved, /        pass/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function testCandidateASourceTemplate() {
    const starter = {
        methodName: "reverseList",
        parameters: [{ name: "head", annotation: "Optional[ListNode]" }],
        returnAnnotation: "Optional[ListNode]",
        requiredTypingNames: ["Optional"],
        typingImports: [],
        insertionLine: 1,
    };
    const source = "from __future__ import annotations\n\nclass Solution:\n    def reverseList(self, head: Optional[ListNode]) -> Optional[ListNode]:\n        pass\n";
    const prepared = prepareCandidateASourceDetailed(source, starter);
    assert.match(prepared.source, /^from __future__ import annotations\nfrom typing import Optional/m);
    assert.match(prepared.source, /class ListNode:/);
    assert.deepStrictEqual(prepared.addedPlatformTypes, ["ListNode"]);
    assert.strictEqual(prepareCandidateASourceDetailed(prepared.source, starter).source, prepared.source);
}

function testComparators() {
    const caseDefinition = {
        name: "Two Sum accepts any valid pair",
        args: [[2, 7, 11, 15], 9],
        oracle: {
            kind: "user-assertion",
            comparator: { kind: "any-valid-index-pair", arrayArg: 0, targetArg: 1 },
            expected: null,
            provenance: "test",
        },
    };
    const result = {
        ok: true,
        returnValue: [1, 0],
        preArgs: [[2, 7, 11, 15], 9],
        postArgs: [[2, 7, 11, 15], 9],
        mutated: false,
        stdout: "",
        stderr: "",
    };
    assert.strictEqual(compareRun(caseDefinition, result).label, "Passed local assertion");

    const mutatedResult = Object.assign({}, result, { mutated: true, postArgs: [[7, 2, 11, 15], 9] });
    assert.match(compareRun(caseDefinition, mutatedResult).label, /mutated arguments not asserted/);
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
