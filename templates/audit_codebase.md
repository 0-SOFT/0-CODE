# Codebase audit

Read `.0-code/config.json`, `.0-code/AGENT.md` and the active prompt. Use configured roles for reports, findings and repair prompts; use the configured language for human artifacts.

Trace real code paths, data validation, filesystem boundaries, persistence, error handling, lifecycle transitions, permission decisions and engine adapters. Check owner data preservation and idempotence where relevant. Reproduce findings with real inputs. Inspect secrets handling without copying or printing credentials. Check KISS, DRY and SOLID against actual consequences.

Write a research report, machine ledger and ordered repair prompt. The production audit command defines the ledger contract. Name exact coverage and evidence; fixed and rejected findings need substantive grounds. Never downgrade severity to make a gate pass.
