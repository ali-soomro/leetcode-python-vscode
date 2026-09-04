const assert = require("assert");

const { preparePythonStarterForPylance } = require("../out/src/pythonStarter/pylancePreparation");

function testBlankPrimitiveStarter() {
    const source = [
        "# @lc app=leetcode id=20 lang=python3",
        "# @lc code=start",
        "class Solution:",
        "    def isValid(self, s: str) -> bool:",
        "# @lc code=end",
        "",
    ].join("\n");
    const prepared = preparePythonStarterForPylance(source);
    assert.match(prepared, /def isValid\(self, s: str\) -> bool:\n        pass\n# @lc code=end/);
    assert.ok(!prepared.includes("from typing import"));
}

function testPlatformTypesAndFutureImport() {
    const source = [
        "# @lc app=leetcode id=206 lang=python3",
        "from __future__ import annotations",
        "",
        "class Solution:",
        "    def transform(self, head: Optional[ListNode], values: List[int], counts: Dict[str, int]) -> Optional[TreeNode]:",
        "        pass",
        "",
    ].join("\n");
    const prepared = preparePythonStarterForPylance(source);
    assert.match(prepared, /^# @lc app=leetcode id=206 lang=python3\nfrom __future__ import annotations\nfrom typing import List, Optional, Dict/m);
    assert.match(prepared, /class ListNode:\n    def __init__\(self, val=0, next=None\):/);
    assert.match(prepared, /class TreeNode:\n    def __init__\(self, val=0, left=None, right=None\):/);
    assert.ok(prepared.indexOf("class ListNode") < prepared.indexOf("class Solution"));
    assert.strictEqual(preparePythonStarterForPylance(prepared), prepared);
}

function testExistingDefinitionsStayUntouched() {
    const source = [
        "from typing import List",
        "",
        "class ListNode:",
        "    pass",
        "",
        "class Solution:",
        "    def reverse(self, head: ListNode) -> List[int]:",
        "        return []",
        "",
    ].join("\n");
    assert.strictEqual(preparePythonStarterForPylance(source), source);
}

function testModuleDocstringPlacement() {
    const source = [
        "\"\"\"Local description.\"\"\"",
        "",
        "class Solution:",
        "    def total(self, values: List[int]) -> int:",
        "        return len(values)",
        "",
    ].join("\n");
    const prepared = preparePythonStarterForPylance(source);
    assert.match(prepared, /^\"\"\"Local description\.\"\"\"\nfrom typing import List\n/m);
    assert.ok(prepared.indexOf("from typing import List") < prepared.indexOf("class Solution"));
}

testBlankPrimitiveStarter();
testPlatformTypesAndFutureImport();
testExistingDefinitionsStayUntouched();
testModuleDocstringPlacement();
console.log("Python starter preparation tests passed");
