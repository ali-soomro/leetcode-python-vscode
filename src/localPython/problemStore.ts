// Copyright (c) 2026 Ali Soomro. All rights reserved.
// Licensed under the MIT license.

import * as fse from "fs-extra";
import * as path from "path";
import { LocalCasesFile, LocalProblemFile, ParsedStarter, ProblemLocation } from "./models";

const FORMAT_VERSION = 1 as const;

export function slugify(value: string): string {
    const slug: string = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "clipboard-problem";
}

export async function createClipboardProblemPackage(
    workspaceRoot: string,
    title: string,
    source: string,
    parsed: ParsedStarter,
): Promise<ProblemLocation> {
    const baseSlug: string = `local-${slugify(title)}`;
    const problemsRoot: string = path.join(workspaceRoot, ".leetcode-python", "problems");
    const directory: string = await reserveDirectory(problemsRoot, baseSlug);
    const now: string = new Date().toISOString();
    const problem: LocalProblemFile = {
        formatVersion: FORMAT_VERSION,
        source: { kind: "clipboard", importedAt: now, solutionPath: path.join(directory, "solution.py") },
        problem: { id: null, slug: path.basename(directory), title },
        method: {
            name: parsed.methodName,
            params: parsed.parameters,
            return: { annotation: parsed.returnAnnotation },
        },
        localSupport: { status: "ready", reason: "Imported from a clipboard Python starter." },
    };
    const location: ProblemLocation = pathsFor(directory, problem);
    await fse.ensureDir(directory);
    await Promise.all([
        fse.writeFile(path.join(directory, "solution.py"), source, "utf8"),
        writeJson(location.problemPath, problem),
        writeJson(location.casesPath, emptyCases()),
    ]);
    return location;
}

export async function resolveProblemLocation(
    solutionPath: string,
    workspaceRoot: string | undefined,
    parsed: ParsedStarter,
): Promise<ProblemLocation> {
    const adjacentProblemPath: string = path.join(path.dirname(solutionPath), "problem.json");
    if (await fse.pathExists(adjacentProblemPath)) {
        const adjacent: LocalProblemFile = await readProblem(adjacentProblemPath);
        return pathsFor(path.dirname(solutionPath), adjacent);
    }

    const source: string = await fse.readFile(solutionPath, "utf8");
    const identity: { id: string | null; slug: string; title: string } = identityFromSource(source, solutionPath);
    const root: string = workspaceRoot || path.dirname(solutionPath);
    const directory: string = path.join(root, ".leetcode-python", "problems", identity.slug);
    const problemPath: string = path.join(directory, "problem.json");
    let problem: LocalProblemFile;
    if (await fse.pathExists(problemPath)) {
        problem = await readProblem(problemPath);
    } else {
        problem = {
            formatVersion: FORMAT_VERSION,
            source: { kind: "generated", importedAt: new Date().toISOString(), solutionPath },
            problem: identity,
            method: {
                name: parsed.methodName,
                params: parsed.parameters,
                return: { annotation: parsed.returnAnnotation },
            },
            localSupport: { status: "ready", reason: "Derived from the active Python solution." },
        };
        await fse.ensureDir(directory);
        await writeJson(problemPath, problem);
    }
    const location: ProblemLocation = pathsFor(directory, problem);
    if (!await fse.pathExists(location.casesPath)) {
        await writeJson(location.casesPath, emptyCases());
    }
    return location;
}

export async function readCases(location: ProblemLocation): Promise<LocalCasesFile> {
    if (!await fse.pathExists(location.casesPath)) {
        return emptyCases();
    }
    const parsed: LocalCasesFile = await fse.readJson(location.casesPath);
    if (parsed.formatVersion !== FORMAT_VERSION || !Array.isArray(parsed.cases)) {
        throw new Error(`Unsupported cases file format: ${location.casesPath}`);
    }
    return parsed;
}

export async function writeCases(location: ProblemLocation, cases: LocalCasesFile): Promise<void> {
    await writeJson(location.casesPath, cases);
}

function pathsFor(directory: string, problem: LocalProblemFile): ProblemLocation {
    return {
        directory,
        problemPath: path.join(directory, "problem.json"),
        casesPath: path.join(directory, "cases.json"),
        problem,
    };
}

function emptyCases(): LocalCasesFile {
    return { formatVersion: FORMAT_VERSION, cases: [] };
}

async function reserveDirectory(root: string, base: string): Promise<string> {
    await fse.ensureDir(root);
    for (let suffix: number = 1; ; suffix += 1) {
        const candidate: string = path.join(root, suffix === 1 ? base : `${base}-${suffix}`);
        if (!await fse.pathExists(candidate)) {
            return candidate;
        }
    }
}

async function readProblem(problemPath: string): Promise<LocalProblemFile> {
    const parsed: LocalProblemFile = await fse.readJson(problemPath);
    if (parsed.formatVersion !== FORMAT_VERSION) {
        throw new Error(`Unsupported problem file format: ${problemPath}`);
    }
    return parsed;
}

async function writeJson(target: string, value: object): Promise<void> {
    await fse.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function identityFromSource(source: string, solutionPath: string): { id: string | null; slug: string; title: string } {
    const header: RegExpMatchArray | null = source.match(/@lc\s+app=.*?\s+id=([^\s]+)\s+lang=([^\s]+)/);
    if (header) {
        const id: string = header[1];
        const titleMatch: RegExpMatchArray | null = source.match(/^\s*#\s*\[?\d+\]?\s*([^\n]+)$/m);
        const title: string = titleMatch ? titleMatch[1].trim() : path.basename(solutionPath, path.extname(solutionPath));
        return { id, slug: `leetcode-${safePathPart(id)}`, title };
    }
    const base: string = path.basename(solutionPath, path.extname(solutionPath));
    return { id: null, slug: `local-${slugify(base)}`, title: base };
}

function safePathPart(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
