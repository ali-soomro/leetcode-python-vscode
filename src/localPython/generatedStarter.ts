// Copyright (c) 2026 Ali Soomro. All rights reserved.
// Licensed under the MIT license.

import * as fse from "fs-extra";
import { CandidateASourcePreparation, prepareCandidateASourceDetailed } from "./sourceTemplate";
import { parseClipboardStarter } from "./pythonAst";

/**
 * Apply the E4-proven Candidate A preparation to a newly-created Python
 * starter. Callers must ensure the file is new: this helper intentionally
 * does not decide whether it is safe to rewrite a user's existing solution.
 */
export async function prepareNewPythonStarter(
    pythonPath: string,
    filePath: string,
): Promise<CandidateASourcePreparation> {
    const source: string = await fse.readFile(filePath, "utf8");
    const parsed = await parseClipboardStarter(pythonPath, source);
    const prepared: CandidateASourcePreparation = prepareCandidateASourceDetailed(parsed.normalizedSource, parsed.starter);
    if (prepared.source !== source) {
        await fse.writeFile(filePath, prepared.source, "utf8");
    }
    return prepared;
}
