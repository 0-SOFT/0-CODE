# Final verification

Read `.0-code/config.json`, `.0-code/AGENT.md`, the active prompt and all acceptance criteria. Resolve the reports, findings and state paths through roles. Use project checks identified by the inventory.

Run the checks required by the active prompt against the final implementation. Verify installation and lifecycle scenarios on supported platforms using isolated profiles. Never copy authentication or invoke a model merely to test a deterministic operation.

For framework compatibility, use Node 20/22/24 on Windows and Linux. Record exact versions,
executable paths, OS, revision and logs per cell. Before release, run three consecutive full
default suites with source coverage >=80% on each of Node 22/24 and smoke on both; verify a
clean public copy with the full suite and smoke on both. Node 20 requires at least process
and lifecycle CLI checks. Include all other supported runtimes installed locally. Obtain a
missing runtime only in scratch from an official archive with a verified SHA-256. Set PATH
for each child check and confirm version/path inside Bash before smoke. Do not reduce test
concurrency, treat absent CI as success, or claim untested cells. Reproduce Windows process
bugs on the old code and prove the fix with real children and complete output on 20/22/24.

Also check scan/install/doctor/uninstall from a clean public copy in the normal machine
environment under Node 22, with toolset disabled and a disposable project. Keep personal
profiles/authentication intact, check real doctor prerequisites and verify byte restoration.

Record commands, revision, input boundaries, results, coverage and material limits in the reports role. A failed check must be investigated and fixed or explicitly left unresolved. Do not claim completion until acceptance evidence is complete. Update the state atomically with a fresh task for the actual next phase.
