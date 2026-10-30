export type HydrationDatabaseOperation =
  | 'media-load'
  | 'transaction-begin'
  | 'ownership-check'
  | 'identity-lookup'
  | 'canonical-lookup'
  | 'canonical-save'
  | 'identity-insert'
  | 'transaction-completion'
  | 'unknown';

export interface HydrationOperationContext {
  operation: HydrationDatabaseOperation;
}

const operations = new Set<HydrationDatabaseOperation>([
  'media-load',
  'transaction-begin',
  'ownership-check',
  'identity-lookup',
  'canonical-lookup',
  'canonical-save',
  'identity-insert',
  'transaction-completion',
  'unknown',
]);

// SQLite primary result codes. Extended codes are normalized to this allowlist;
// arbitrary code strings and numeric values are never copied into diagnostics.
const recognizedCodes = new Set([
  'SQLITE_ERROR',
  'SQLITE_INTERNAL',
  'SQLITE_PERM',
  'SQLITE_ABORT',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_NOMEM',
  'SQLITE_READONLY',
  'SQLITE_INTERRUPT',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_NOTFOUND',
  'SQLITE_FULL',
  'SQLITE_CANTOPEN',
  'SQLITE_PROTOCOL',
  'SQLITE_EMPTY',
  'SQLITE_SCHEMA',
  'SQLITE_TOOBIG',
  'SQLITE_CONSTRAINT',
  'SQLITE_MISMATCH',
  'SQLITE_MISUSE',
  'SQLITE_NOLFS',
  'SQLITE_AUTH',
  'SQLITE_FORMAT',
  'SQLITE_RANGE',
  'SQLITE_NOTADB',
]);
type ConstraintCategory =
  | 'none'
  | 'unknown'
  | 'unique'
  | 'primary-key'
  | 'foreign-key'
  | 'not-null'
  | 'check'
  | 'datatype'
  | 'trigger';
const constraintCodes: Record<string, ConstraintCategory> = {
  SQLITE_CONSTRAINT_UNIQUE: 'unique',
  SQLITE_CONSTRAINT_ROWID: 'unique',
  SQLITE_CONSTRAINT_PRIMARYKEY: 'primary-key',
  SQLITE_CONSTRAINT_FOREIGNKEY: 'foreign-key',
  SQLITE_CONSTRAINT_NOTNULL: 'not-null',
  SQLITE_CONSTRAINT_CHECK: 'check',
  SQLITE_CONSTRAINT_DATATYPE: 'datatype',
  SQLITE_CONSTRAINT_TRIGGER: 'trigger',
};

const read = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

const sqliteCode = (error: object): string | undefined => {
  const code = read(error, 'code');
  if (
    typeof code === 'string' &&
    code.length <= 80 &&
    /^SQLITE_[A-Z]+(?:_[A-Z0-9]+)*$/.test(code)
  ) {
    const primary = code.split('_').slice(0, 2).join('_');
    if (recognizedCodes.has(primary)) return primary;
  }
  // A bare errno can also be a POSIX/provider error, so it is not SQLite proof.
  return undefined;
};

const constraintCategory = (error: object): ConstraintCategory => {
  const code = read(error, 'code');
  if (
    typeof code === 'string' &&
    code.length <= 80 &&
    Object.hasOwn(constraintCodes, code)
  )
    return constraintCodes[code];
  const message = read(error, 'message');
  if (typeof message !== 'string') return 'unknown';
  // Read only the fixed SQLite prefix. Never return the message, column names,
  // SQL, parameter values, provider payloads, or arbitrary constraint names.
  const prefix = message.slice(0, 100);
  if (/^SQLITE_CONSTRAINT: UNIQUE constraint failed\b/.test(prefix))
    return 'unique';
  if (/^SQLITE_CONSTRAINT: FOREIGN KEY constraint failed\b/.test(prefix))
    return 'foreign-key';
  if (/^SQLITE_CONSTRAINT: NOT NULL constraint failed\b/.test(prefix))
    return 'not-null';
  if (/^SQLITE_CONSTRAINT: CHECK constraint failed\b/.test(prefix))
    return 'check';
  return 'unknown';
};

export const describeHydrationFailure = (
  error: unknown,
  operation: HydrationDatabaseOperation = 'unknown'
): {
  operation: HydrationDatabaseOperation;
  sqliteCode: string;
  constraintCategory: ConstraintCategory;
  failureMessage: string;
} => {
  const safeOperation = operations.has(operation) ? operation : 'unknown';
  let code = 'unknown';
  let constraint: ConstraintCategory = 'none';
  const pending = [{ value: error, depth: 0 }];
  const seen = new Set<object>();
  // Both TypeORM driverError and Error.cause may wrap the underlying error.
  // Bound traversal even for cyclic, deeply nested, or hostile error objects.
  for (let visited = 0; pending.length > 0 && visited < 12; visited++) {
    const entry = pending.shift()!;
    if (
      !entry.value ||
      typeof entry.value !== 'object' ||
      seen.has(entry.value)
    )
      continue;
    seen.add(entry.value);
    const found = sqliteCode(entry.value);
    if (found && code === 'unknown') {
      code = found;
      constraint = code === 'SQLITE_CONSTRAINT' ? 'unknown' : 'none';
    }
    if (
      found === 'SQLITE_CONSTRAINT' &&
      code === found &&
      constraint === 'unknown'
    )
      constraint = constraintCategory(entry.value);
    if (entry.depth < 4) {
      pending.push(
        { value: read(entry.value, 'driverError'), depth: entry.depth + 1 },
        { value: read(entry.value, 'cause'), depth: entry.depth + 1 }
      );
    }
  }
  return {
    operation: safeOperation,
    sqliteCode: code,
    constraintCategory: constraint,
    failureMessage: (
      `Library hydration failed; operation=${safeOperation}; ` +
      `sqlite=${code}; constraint=${constraint}.`
    ).slice(0, 500),
  };
};
