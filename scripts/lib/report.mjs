// Shared reporting for the testing loop's scripts, so layer 1 and layer 2 read
// identically at a glance: `note` lines first, then either one `ok` line or one
// `FAIL` line per failure and a count.
//
// Kept deliberately dumb — a collector and a printer. The scripts decide what is
// worth checking; this decides nothing.

/** A collector plus its terminal printer. `report()` exits the process, because
 *  that is the last thing either script does and splitting the exit code away
 *  from the printing only invites a caller that forgets to use it. */
export function createReporter() {
  const failures = [];
  const notes = [];
  let checked = 0;

  return {
    /** A failure attributed to a named check. */
    fail(check, detail) {
      failures.push(`${check}: ${detail}`);
    },

    /** Something the operator should read but which is not a failure. */
    note(text) {
      notes.push(text);
    },

    /** One check passed. */
    ok() {
      checked++;
    },

    report() {
      for (const n of notes) console.log(`note  ${n}`);
      if (failures.length === 0) {
        console.log(`ok    ${checked} checks passed`);
        process.exit(0);
      }
      for (const f of failures) console.error(`FAIL  ${f}`);
      console.error(`\n${failures.length} failure(s), ${checked} checks run`);
      process.exit(1);
    },
  };
}
