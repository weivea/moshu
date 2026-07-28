import * as Diff from "diff";

export interface EditOperation {
	oldText: string;
	newText: string;
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const carriageReturnIndex = content.indexOf("\r\n");
	const lineFeedIndex = content.indexOf("\n");
	if (lineFeedIndex === -1 || carriageReturnIndex === -1) {
		return "\n";
	}
	return carriageReturnIndex < lineFeedIndex ? "\r\n" : "\n";
}

export function normalizeToLineFeed(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function replacementLineRange(
	lines: LineSpan[],
	replacement: TextReplacement,
): { startLine: number; endLine: number } {
	const replacementEnd = replacement.matchIndex + replacement.matchLength;
	const startLine = lines.findIndex(
		(line) => replacement.matchIndex >= line.start && replacement.matchIndex < line.end,
	);
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content");
	}
	let endLine = startLine;
	while ((lines[endLine]?.end ?? -1) < replacementEnd) {
		endLine += 1;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content");
	}
	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let index = replacements.length - 1; index >= 0; index -= 1) {
		const replacement = replacements[index];
		if (!replacement) {
			continue;
		}
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) +
			replacement.newText +
			result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Fuzzy-normalized content changed the file line count");
	}
	const groups: Array<{
		startLine: number;
		endLine: number;
		replacements: TextReplacement[];
	}> = [];
	for (const replacement of [...replacements].sort(
		(left, right) => left.matchIndex - right.matchIndex,
	)) {
		const range = replacementLineRange(baseLines, replacement);
		const current = groups.at(-1);
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
		} else {
			groups.push({ ...range, replacements: [replacement] });
		}
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");
		const groupStartOffset = baseLines[group.startLine]?.start;
		const groupEndOffset = baseLines[group.endLine - 1]?.end;
		if (groupStartOffset === undefined || groupEndOffset === undefined) {
			throw new Error("Fuzzy replacement range is outside the base content");
		}
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	return result + originalLines.slice(originalLineIndex).join("");
}

function fuzzyFindText(
	content: string,
	oldText: string,
): {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
} {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
		};
	}
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	return fuzzyIndex === -1
		? { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false }
		: {
				found: true,
				index: fuzzyIndex,
				matchLength: fuzzyOldText.length,
				usedFuzzyMatch: true,
			};
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	if (fuzzyOldText.length === 0) {
		return 0;
	}
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

export function applyEditOperations(
	content: string,
	operations: EditOperation[],
	path: string,
): { content: string; usedFuzzyMatch: boolean } {
	const edits = operations.map((edit) => ({
		oldText: normalizeToLineFeed(edit.oldText),
		newText: normalizeToLineFeed(edit.newText),
	}));
	for (const [index, edit] of edits.entries()) {
		if (edit.oldText.length === 0) {
			throw new Error(`edits[${index}].oldText must not be empty in ${path}`);
		}
	}
	const initialMatches = edits.map((edit) => fuzzyFindText(content, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBase = usedFuzzyMatch ? normalizeForFuzzyMatch(content) : content;
	const matchedEdits: MatchedEdit[] = [];

	for (const [index, edit] of edits.entries()) {
		const match = fuzzyFindText(replacementBase, edit.oldText);
		if (!match.found) {
			throw new Error(
				`Could not find edits[${index}] in ${path}. oldText must match exactly, including whitespace and newlines.`,
			);
		}
		const occurrences = countOccurrences(replacementBase, edit.oldText);
		if (occurrences > 1) {
			throw new Error(
				`Found ${occurrences} occurrences of edits[${index}] in ${path}. Provide more context to make oldText unique.`,
			);
		}
		matchedEdits.push({
			editIndex: index,
			matchIndex: match.index,
			matchLength: match.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((left, right) => left.matchIndex - right.matchIndex);
	for (let index = 1; index < matchedEdits.length; index += 1) {
		const previous = matchedEdits[index - 1];
		const current = matchedEdits[index];
		if (previous && current && previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}`,
			);
		}
	}
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(content, replacementBase, matchedEdits)
		: applyReplacements(replacementBase, matchedEdits);
	if (newContent === content) {
		throw new Error(`Edits produced no changes in ${path}`);
	}
	return { content: newContent, usedFuzzyMatch };
}

export function createEditDiff(
	filePath: string,
	oldContent: string,
	newContent: string,
): { displayDiff: string; unifiedPatch: string } {
	const parts = Diff.diffLines(oldContent, newContent);
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const lineNumberWidth = String(Math.max(oldLines.length, newLines.length)).length;
	const output: string[] = [];
	let oldLineNumber = 1;
	let newLineNumber = 1;
	let lastWasChange = false;

	for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
		const part = parts[partIndex];
		if (!part) {
			continue;
		}
		const lines = part.value.split("\n");
		if (lines.at(-1) === "") {
			lines.pop();
		}
		if (part.added || part.removed) {
			for (const line of lines) {
				if (part.added) {
					output.push(`+${String(newLineNumber).padStart(lineNumberWidth, " ")} ${line}`);
					newLineNumber += 1;
				} else {
					output.push(`-${String(oldLineNumber).padStart(lineNumberWidth, " ")} ${line}`);
					oldLineNumber += 1;
				}
			}
			lastWasChange = true;
			continue;
		}

		const next = parts[partIndex + 1];
		const nextIsChange = Boolean(next?.added || next?.removed);
		const start = lastWasChange ? 0 : Math.max(0, lines.length - 4);
		const end = nextIsChange ? lines.length : Math.min(lines.length, 4);
		if (!lastWasChange && start > 0) {
			oldLineNumber += start;
			newLineNumber += start;
			output.push(` ${"".padStart(lineNumberWidth, " ")} ...`);
		}
		for (const line of lines.slice(start, end)) {
			output.push(` ${String(oldLineNumber).padStart(lineNumberWidth, " ")} ${line}`);
			oldLineNumber += 1;
			newLineNumber += 1;
		}
		const skippedAfter = lines.length - end;
		if (skippedAfter > 0) {
			output.push(` ${"".padStart(lineNumberWidth, " ")} ...`);
			oldLineNumber += skippedAfter;
			newLineNumber += skippedAfter;
		}
		lastWasChange = false;
	}

	return {
		displayDiff: output.join("\n"),
		unifiedPatch: Diff.createTwoFilesPatch(
			filePath,
			filePath,
			oldContent,
			newContent,
			undefined,
			undefined,
			{ context: 4, headerOptions: Diff.FILE_HEADERS_ONLY },
		),
	};
}
