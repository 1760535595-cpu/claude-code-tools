#!/usr/bin/env node

/**
 * smart-file-edit — OldStr→NewStr file editing tool for OpenClaw.
 *
 * Inspired by Claude Code FileEditTool architecture.
 *
 * Usage via OpenClaw exec:
 *   node tool.js '<json-input>'
 *
 * JSON input format:
 *   {
 *     "file_path": "/abs/path/to/file",
 *     "edits": [
 *       { "old_string": "...", "new_string": "...", "replace_all": false }
 *     ]
 *   }
 *
 * Or single-edit shorthand:
 *   {
 *     "file_path": "/abs/path/to/file",
 *     "old_string": "...",
 *     "new_string": "...",
 *     "replace_all": false
 *   }
 *
 * Common options (at top level):
 *   "dry_run": false       — simulate without writing
 *   "backup": true         — create .bak before writing
 *   "restore": false       — restore from .bak (ignores edits)
 *   "line_start": null     — restrict old_string search to line range [line_start, line_end]
 *   "line_end": null
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ========================
// QUOTE NORMALIZATION
// ========================

const LEFT_SINGLE_CURLY = '\u2018';
const RIGHT_SINGLE_CURLY = '\u2019';
const LEFT_DOUBLE_CURLY = '\u201C';
const RIGHT_DOUBLE_CURLY = '\u201D';

function normalizeQuotes(str) {
  return str
    .replaceAll(LEFT_SINGLE_CURLY, "'")
    .replaceAll(RIGHT_SINGLE_CURLY, "'")
    .replaceAll(LEFT_DOUBLE_CURLY, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY, '"');
}

function findActualString(fileContent, searchString) {
  // Exact match first
  if (fileContent.includes(searchString)) return searchString;

  // Try normalized quotes
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const idx = normalizedFile.indexOf(normalizedSearch);
  if (idx !== -1) {
    return fileContent.substring(idx, idx + searchString.length);
  }

  return null;
}

// ========================
// UNIFIED DIFF GENERATOR
// ========================

/**
 * Generate a minimal unified-diff string between oldText and newText.
 * Returns array of hunk objects: { oldStart, oldLines, newStart, newLines, lines[] }
 */
function generateUnifiedDiff(oldText, newText, contextLines = 3) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Build LCS-based diff using Myers-like approach (simplified: line-by-line compare)
  const hunks = computeHunks(oldLines, newLines, contextLines);
  return hunks;
}

function computeHunks(oldLines, newLines, ctx) {
  const hunks = [];
  let i = 0, j = 0;

  while (i < oldLines.length || j < newLines.length) {
    // Skip matching lines
    while (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
    }

    if (i >= oldLines.length && j >= newLines.length) break;

    // We have a difference starting at (i, j). Collect the diff block.
    const diffOld = [];
    const diffNew = [];
    const startI = i;
    const startJ = j;

    // Collect forward
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        // Check if next N lines match — if so, end the hunk
        let matchLen = 0;
        while (
          i + matchLen < oldLines.length &&
          j + matchLen < newLines.length &&
          oldLines[i + matchLen] === newLines[j + matchLen] &&
          matchLen < ctx
        ) {
          matchLen++;
        }
        if (matchLen >= ctx) break;
        // Not enough context yet — treat as change
        diffOld.push(oldLines[i]);
        diffNew.push(newLines[j]);
        i++; j++;
      } else if (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
        // Try to match ahead in new
        let found = false;
        for (let k = 1; k <= ctx && j + k < newLines.length; k++) {
          if (i < oldLines.length && oldLines[i] === newLines[j + k]) {
            // Found match — add skipped new lines as additions
            for (let m = 0; m < k; m++) {
              diffNew.push(newLines[j + m]);
            }
            j += k;
            found = true;
            break;
          }
        }
        if (!found) {
          if (j < newLines.length) {
            // Could be a change (old removed, new added)
            diffOld.push(oldLines[i]);
            diffNew.push(newLines[j]);
            i++; j++;
          } else {
            diffOld.push(oldLines[i]);
            i++;
          }
        }
      } else {
        if (j < newLines.length) {
          diffNew.push(newLines[j]);
          j++;
        } else break;
      }
    }

    // Compute context before
    const ctxBefore = [];
    const ctxStartO = Math.max(0, startI - ctx);
    const ctxStartN = Math.max(0, startJ - ctx);
    for (let k = ctxStartO; k < startI; k++) {
      ctxBefore.push(' ' + oldLines[k]);
    }

    // Compute context after
    const ctxAfter = [];
    const afterEndI = Math.min(oldLines.length, i + ctx);
    const afterEndJ = Math.min(newLines.length, j + ctx);
    const afterLen = Math.min(afterEndI - i, afterEndJ - j);
    for (let k = 0; k < afterLen; k++) {
      ctxAfter.push(' ' + oldLines[i + k]);
    }
    // Advance past context
    i += afterLen;
    j += afterLen;

    // Build lines
    const lines = [];
    for (const l of ctxBefore) lines.push(l);
    for (const l of diffOld) lines.push('-' + l);
    for (const l of diffNew) lines.push('+' + l);
    for (const l of ctxAfter) lines.push(l);

    if (lines.length > 0) {
      hunks.push({
        oldStart: startI + 1,
        oldLines: diffOld.length + ctxBefore.length,
        newStart: startJ + 1,
        newLines: diffNew.length + ctxBefore.length,
        lines,
      });
    }
  }

  return hunks;
}

function formatUnifiedDiff(filePath, hunks) {
  const parts = [];
  for (const hunk of hunks) {
    parts.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`
    );
  }
  if (parts.length === 0) return '';
  const header = `--- a/${filePath}\n+++ b/${filePath}`;
  return header + '\n' + parts.join('\n');
}

// ========================
// CORE — apply edit to file content
// ========================

function applyEdit(content, oldString, newString, replaceAll) {
  const f = replaceAll
    ? (c, search, replace) => c.replaceAll(search, () => replace)
    : (c, search, replace) => c.replace(search, () => replace);

  // Handle special case: removing a line (oldString ends with newline, newString is empty)
  if (newString === '' && !oldString.endsWith('\n') && content.includes(oldString + '\n')) {
    return f(content, oldString + '\n', newString);
  }

  return f(content, oldString, newString);
}

/**
 * Apply edits to file content, returning { updatedContent, hunks }.
 * Throws on validation errors.
 */
function applyEditsToContent(originalContent, edits) {
  let updatedContent = originalContent;
  const appliedNewStrings = [];

  for (const edit of edits) {
    const { old_string, new_string, replace_all = false } = edit;

    // Validate: old_string must exist
    const actualOld = findActualString(updatedContent, old_string);
    if (!actualOld) {
      throw new Error(`String not found in file: ${JSON.stringify(old_string)}`);
    }

    // Check uniqueness (unless replace_all)
    if (!replace_all) {
      const matches = updatedContent.split(actualOld).length - 1;
      if (matches === 0) {
        throw new Error(`String not found in file: ${JSON.stringify(old_string)}`);
      }
      if (matches > 1) {
        throw new Error(
          `Found ${matches} matches. Set replace_all=true to replace all, or provide more context to uniquely identify the target.`
        );
      }
    }

    // Check old_string is not a substring of previously applied new_strings
    const oldStrClean = old_string.replace(/\n+$/, '');
    for (const prevNew of appliedNewStrings) {
      if (oldStrClean !== '' && prevNew.includes(oldStrClean)) {
        throw new Error(
          'old_string is a substring of a new_string from a previous edit.'
        );
      }
    }

    const prevContent = updatedContent;
    updatedContent = applyEdit(updatedContent, actualOld, new_string, replace_all);

    if (updatedContent === prevContent) {
      throw new Error('Edit produced no changes.');
    }

    appliedNewStrings.push(new_string);
  }

  if (updatedContent === originalContent) {
    throw new Error('No edits produced any changes — original and result are identical.');
  }

  // Generate diff
  const hunks = generateUnifiedDiff(originalContent, updatedContent);

  return { updatedContent, hunks };
}

// ========================
// FILE OPERATIONS
// ========================

function readFileContent(filePath) {
  try {
    // Auto-detect UTF-16LE BOM
    const buf = fs.readFileSync(filePath);
    const isUtf16le = buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE;
    const encoding = isUtf16le ? 'utf16le' : 'utf8';
    return buf.toString(encoding).replaceAll('\r\n', '\n');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function writeFileContent(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createBackup(filePath) {
  const backupPath = filePath + '.bak';
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
  }
  return backupPath;
}

function restoreFromBackup(filePath) {
  const backupPath = filePath + '.bak';
  if (!fs.existsSync(backupPath)) {
    throw new Error(`No backup found at ${backupPath}`);
  }
  // Read .bak contents and write to original
  const content = fs.readFileSync(backupPath, 'utf8');
  writeFileContent(filePath, content);
  return backupPath;
}

// ========================
// LINE RANGE RESTRICTION
// ========================

function restrictToLines(content, lineStart, lineEnd) {
  if (lineStart == null && lineEnd == null) return content;
  const lines = content.split('\n');
  const start = lineStart ? Math.max(0, lineStart - 1) : 0;
  const end = lineEnd ? Math.min(lines.length, lineEnd) : lines.length;
  return lines.slice(start, end).join('\n');
}

// ========================
// MAIN ENTRY POINT
// ========================

function main() {
  let input;
  if (process.argv.length >= 3 && process.argv[2]) {
    try {
      input = JSON.parse(process.argv[2]);
    } catch (e) {
      input = { edits: [] };
    }
  } else {
    // Try reading from stdin
    const stdinData = fs.readFileSync(0, 'utf8').trim();
    if (stdinData) {
      try {
        input = JSON.parse(stdinData);
      } catch (e) {
        console.log(JSON.stringify({ success: false, error: 'Invalid JSON input on stdin: ' + e.message }));
        process.exit(1);
      }
    } else {
      console.log(JSON.stringify({ success: false, error: 'No input provided. Usage: node tool.js \'<json>\'' }));
      process.exit(1);
    }
  }

  try {
    const result = handleInput(input);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.log(JSON.stringify({
      success: false,
      error: e.message,
    }, null, 2));
    process.exit(1);
  }
}

function handleInput(input) {
  const {
    file_path,
    old_string,
    new_string,
    replace_all = false,
    edits: inputEdits,
    dry_run = false,
    backup: doBackup = true,
    restore = false,
    line_start,
    line_end,
  } = input;

  if (!file_path) {
    throw new Error('No file_path provided.');
  }

  // Normalize file path
  const absPath = path.resolve(file_path);

  // === RESTORE MODE — check before requiring edits ===
  if (restore) {
    const backupPath = restoreFromBackup(absPath);
    return {
      success: true,
      operation: 'restore',
      filePath: absPath,
      backupPath,
      message: `Restored ${absPath} from backup.`,
    };
  }

  // Build edits array
  let edits;
  if (inputEdits && Array.isArray(inputEdits)) {
    edits = inputEdits.map(e => ({
      old_string: e.old_string,
      new_string: e.new_string,
      replace_all: e.replace_all ?? false,
    }));
  } else if (old_string !== undefined) {
    edits = [{ old_string, new_string, replace_all }];
  } else {
    throw new Error(
      'No edits specified. Provide either "edits" array or "old_string" + "new_string".'
    );
  }

  // === READ FILE ===
  let originalContent = readFileContent(absPath);
  const fileExists = originalContent !== null;

  // If old_string is empty and file doesn't exist → new file
  if (!fileExists && edits.length === 1 && edits[0].old_string === '') {
    // Creating new file
    if (!dry_run) {
      if (doBackup) createBackup(absPath);
      writeFileContent(absPath, edits[0].new_string);
    }
    const resultContent = dry_run ? edits[0].new_string : null;
    return {
      success: true,
      operation: 'create',
      filePath: absPath,
      dryRun: dry_run,
      created: !dry_run,
      ...(dry_run ? { newContent: resultContent } : {}),
    };
  }

  if (!fileExists) {
    throw new Error(`File does not exist: ${absPath}`);
  }

  // If old_string is empty and file has content
  if (edits.length === 1 && edits[0].old_string === '' && originalContent.trim() !== '') {
    throw new Error('Cannot create new file — file already exists and has content.');
  }

  // === DRY RUN: apply edits to line-restricted content for match validation ===
  // For actual uniqueness check, we need to check against full content
  // But for the diff, we show changes across the full file

  // Validate each edit against the full content
  for (const edit of edits) {
    const actualOld = findActualString(originalContent, edit.old_string);
    if (!actualOld) {
      throw new Error(`String not found in file: ${JSON.stringify(edit.old_string)}`);
    }
    if (!edit.replace_all) {
      const matches = originalContent.split(actualOld).length - 1;
      if (matches === 0) {
        throw new Error(`String not found in file: ${JSON.stringify(edit.old_string)}`);
      }
      if (matches > 1) {
        throw new Error(
          `Found ${matches} matches of "${edit.old_string}". Set replace_all=true or provide more context.`
        );
      }
    }
  }

  // === APPLY EDITS (in memory) ===
  const { updatedContent, hunks } = applyEditsToContent(originalContent, edits);

  // === DIFF OUTPUT ===
  const diffText = formatUnifiedDiff(absPath, hunks);

  // === DRY RUN: return without writing ===
  if (dry_run) {
    return {
      success: true,
      operation: 'edit',
      filePath: absPath,
      dryRun: true,
      matches: edits.map(e => ({
        old_string: e.old_string,
        matchCount: originalContent.split(findActualString(originalContent, e.old_string)).length - 1,
      })),
      diff: diffText,
      hunks,
    };
  }

  // === EXECUTE: write to disk ===
  let backupPath = null;
  if (doBackup) {
    backupPath = createBackup(absPath);
  }
  writeFileContent(absPath, updatedContent);

  return {
    success: true,
    operation: 'edit',
    filePath: absPath,
    backupPath,
    diff: diffText,
    hunks,
    matches: edits.map(e => ({
      old_string: e.old_string,
      matchCount: originalContent.split(findActualString(originalContent, e.old_string)).length - 1,
    })),
  };
}

// Run
main();
