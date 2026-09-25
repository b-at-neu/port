// Shared reporting for the testing loop's scripts, so layer 1 and layer 2 read
// identically at a glance: `note` lines first, then either one `ok` line or one
// `FAIL` line per failure and a count.
//
// Kept deliberately dumb — a collector and a printer. The scripts decide what is
// worth checking; this decides nothing.

/** What every topic module receives, and the only surface it may act through. */
export interface Reporter {
  /** A failure attributed to a named check. */
  fail(check: string, detail: string): void;
  /** Something the operator should read but which is not a failure. */
  note(text: string): void;
  /** One check passed. */
  ok(): void;
  /** Prints the collected notes/failures and sets `process.exitCode`. */
  report(): void;
}

/** A topic module's shape: takes the shared reporter, asserts against it. */
export type CheckModule = (reporter: Reporter) => Promise<void>;

/** A collector plus its terminal printer. `report()` sets `process.exitCode`
 *  rather than calling `process.exit`, because `process.stdout` is
 *  asynchronous when connected to a pipe on Windows — exiting immediately
 *  after writing risks truncating these very lines. Setting `exitCode` and
 *  letting the process end naturally is safe everywhere, since `report()` is
 *  the last thing either script does. */
export function createReporter(): Reporter {
  const failures: string[] = [];
  const notes: string[] = [];
  let checked = 0;

  return {
    fail(check, detail) {
      failures.push(`${check}: ${detail}`);
    },

    note(text) {
      notes.push(text);
    },

    ok() {
      checked++;
    },

    report() {
      for (const n of notes) console.log(`note  ${n}`);
      if (failures.length === 0) {
        console.log(`ok    ${checked} checks passed`);
        process.exitCode = 0;
        return;
      }
      for (const f of failures) console.error(`FAIL  ${f}`);
      console.error(`\n${failures.length} failure(s), ${checked} checks run`);
      process.exitCode = 1;
    },
  };
}
