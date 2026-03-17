/**
 * ForgeX CLI Output Formatting
 *
 * Supports JSON, Table, and Minimal output modes.
 * Agent mode defaults to JSON output for easy parsing.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import type { Command } from 'commander';
import { loadConfig } from './config.js';

// ============================================================
// Type Definitions
// ============================================================

export type OutputFormat = 'json' | 'table' | 'minimal';

export interface OutputOptions {
  format?: OutputFormat;
}

export interface TableColumn {
  key: string;
  header: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  formatter?: (value: unknown) => string;
}

// ============================================================
// Global Program Reference
// ============================================================

let _program: Command | null = null;

/** Bind Commander program instance so getOutputFormat can read --format global flag */
export function bindProgram(program: Command): void {
  _program = program;
}

// ============================================================
// Output Format Resolution
// ============================================================

/** Get current output format */
export function getOutputFormat(options?: OutputOptions): OutputFormat {
  // 1. Explicitly passed format has highest priority
  if (options?.format) return options.format;

  // 2. CLI --format global flag
  if (_program) {
    const cliFormat = _program.opts().format as string | undefined;
    if (cliFormat && ['json', 'table', 'minimal'].includes(cliFormat)) {
      return cliFormat as OutputFormat;
    }
  }

  // 3. outputFormat from config file
  const config = loadConfig();
  return config.outputFormat || 'json';
}

// ============================================================
// JSON Output
// ============================================================

/** Output JSON data */
export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// ============================================================
// Table Output
// ============================================================

/** Output table data */
export function outputTable(
  data: Record<string, unknown>[],
  columns: TableColumn[]
): void {
  const table = new Table({
    head: columns.map(col => chalk.cyan(col.header)),
    colWidths: columns.map(col => col.width || undefined),
    colAligns: columns.map(col => col.align || 'left'),
    style: {
      head: [],
      border: [],
    },
  });

  for (const row of data) {
    const cells = columns.map(col => {
      const value = row[col.key];
      if (col.formatter) return col.formatter(value);
      return value === null || value === undefined ? '-' : String(value);
    });
    table.push(cells);
  }

  console.log(table.toString());
}

// ============================================================
// Minimal Output
// ============================================================

/** Output minimal results */
export function outputMinimal(data: Record<string, unknown>): void {
  const rows = flattenToKeyValue(data);
  for (const { key, value } of rows) {
    if (value !== '-') {
      console.log(`${key}: ${value}`);
    }
  }
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Flatten a nested object into [{key, value}] array using dot-path keys.
 * e.g. { a: 1, b: { c: 2 } } => [{ key: 'a', value: '1' }, { key: 'b.c', value: '2' }]
 */
function flattenToKeyValue(
  obj: Record<string, unknown>,
  prefix = ''
): { key: string; value: string }[] {
  const result: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)) {
      result.push(...flattenToKeyValue(v as Record<string, unknown>, fullKey));
    } else {
      result.push({ key: fullKey, value: v === null || v === undefined ? '-' : String(v) });
    }
  }
  return result;
}

// ============================================================
// Unified Output Entry
// ============================================================

/** Output data based on format */
export function output(
  data: unknown,
  options?: OutputOptions & {
    columns?: TableColumn[];
  }
): void {
  const format = getOutputFormat(options);

  switch (format) {
    case 'json':
      outputJson(data);
      break;
    case 'table':
      if (Array.isArray(data) && options?.columns) {
        outputTable(data as Record<string, unknown>[], options.columns);
      } else if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        // Plain object auto-converted to key/value two-column table
        const rows = flattenToKeyValue(data as Record<string, unknown>);
        outputTable(rows, [
          { key: 'key', header: 'Key' },
          { key: 'value', header: 'Value' },
        ]);
      } else {
        outputJson(data);
      }
      break;
    case 'minimal':
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        outputMinimal(data as Record<string, unknown>);
      } else if (Array.isArray(data)) {
        data.forEach(item => {
          if (typeof item === 'object' && item !== null) {
            outputMinimal(item as Record<string, unknown>);
            console.log('---');
          } else {
            console.log(item);
          }
        });
      } else {
        console.log(data);
      }
      break;
  }
}

// ============================================================
// Status Messages
// ============================================================

/** Output success message (only shown in table/minimal mode) */
export function success(message: string): void {
  const format = getOutputFormat();
  if (format !== 'json') {
    console.log(chalk.green('✓'), message);
  }
}

/** Output error message */
export function error(message: string, details?: unknown): void {
  const format = getOutputFormat();
  if (format === 'json') {
    outputJson({ error: true, message, details: details || null });
  } else {
    console.error(chalk.red('✗'), message);
    if (details) {
      console.error(chalk.dim(JSON.stringify(details, null, 2)));
    }
  }
}

/** Output warning message */
export function warn(message: string): void {
  const format = getOutputFormat();
  if (format !== 'json') {
    console.warn(chalk.yellow('⚠'), message);
  }
}

/** Output info message */
export function info(message: string): void {
  const format = getOutputFormat();
  if (format !== 'json') {
    console.log(chalk.blue('ℹ'), message);
  }
}

// ============================================================
// Console Suppression (Bug 6: prevent SDK console.log from polluting JSON output)
// ============================================================

const _originalConsoleLog = console.log;
const _originalConsoleWarn = console.warn;
const _originalConsoleError = console.error;
let _consoleSuppressed = false;

/**
 * Temporarily suppress console.log/warn output.
 * Used to prevent SDK internal console.log from polluting output in JSON mode.
 * console.error is preserved for debugging.
 */
export function suppressConsole(): void {
  if (_consoleSuppressed) return;
  _consoleSuppressed = true;
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  // Preserve console.error so critical errors can still go to stderr
}

/**
 * Restore suppressed console output.
 * Safe to call even if suppressConsole was not called.
 */
export function restoreConsole(): void {
  if (!_consoleSuppressed) return;
  _consoleSuppressed = false;
  console.log = _originalConsoleLog;
  console.warn = _originalConsoleWarn;
  console.error = _originalConsoleError;
}
