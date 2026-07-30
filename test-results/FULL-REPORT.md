# dbstudio — full-flow E2E report

Generated: 2026-07-30T18:28:33.321Z

- Passed: 86
- Failed: 0
- Known issues: 0

## All results

| Target | Phase | Case | Outcome |
|---|---|---|---|
| pg16 | driver | txn-commit-spans-statements | pass |
| pg16 | driver | txn-rollback-spans-statements | pass |
| pg16 | driver | temp-table-spans-statements | pass |
| pg16 | driver | cte-window-join | pass |
| pg16 | driver | multi-statement-returns-last | pass |
| pg16 | driver | error-surfaces | pass |
| pg16 | driver | ddl-then-reselect | pass |
| pg16 | driver | utility-statements | pass |
| pg16 | driver | apply-batch-failure-shape | pass |
| pg16 | driver | create-drop-database | pass |
| pg16 | schema-diff | create-table-enum-defaults | pass |
| pg16 | schema-diff | add-columns-json-and-string-default | pass |
| pg16 | schema-diff | add-indexes | pass |
| pg16 | schema-diff | drop-plain-index | pass |
| pg16 | schema-diff | drop-column | pass |
| pg16 | schema-diff | fk-ordered-create | pass |
| pg16 | schema-diff | hostile-identifiers | pass |
| pg16 | schema-diff | rename-column-preserves-data | pass |
| pg16 | schema-diff | rename-ambiguous-stays-drop-add | pass |
| pg16 | schema-diff | add-fk-with-actions | pass |
| pg16 | schema-diff | drop-fk | pass |
| pg16 | schema-diff | redefine-fk-action | pass |
| pg16 | schema-diff | create-view | pass |
| pg16 | schema-diff | drop-view-on-source | pass |
| pg16 | schema-diff | redefine-view | pass |
| pg16 | schema-diff | view-blocks-column-drop | pass |
| pg16 | schema-diff | drop-table-on-source | pass |
| pg16 | data-diff | diff-shape | pass |
| pg16 | data-diff | sync-converges | pass |
| mysql80 | driver | txn-commit-spans-statements | pass |
| mysql80 | driver | txn-rollback-spans-statements | pass |
| mysql80 | driver | temp-table-spans-statements | pass |
| mysql80 | driver | session-vars-prepare-execute | pass |
| mysql80 | driver | start-transaction-not-preparable-1295 | pass |
| mysql80 | driver | row-count-and-temp-table-backfill | pass |
| mysql80 | driver | cte-window-join | pass |
| mysql80 | driver | multi-statement-returns-last | pass |
| mysql80 | driver | error-surfaces | pass |
| mysql80 | driver | ddl-then-reselect | pass |
| mysql80 | driver | utility-statements | pass |
| mysql80 | driver | apply-batch-failure-shape | pass |
| mysql80 | driver | create-drop-database | pass |
| mysql80 | schema-diff | create-table-enum-defaults | pass |
| mysql80 | schema-diff | add-columns-json-and-string-default | pass |
| mysql80 | schema-diff | widen-enum-keep-default | pass |
| mysql80 | schema-diff | add-indexes | pass |
| mysql80 | schema-diff | drop-plain-index | pass |
| mysql80 | schema-diff | drop-fk-backing-index | pass |
| mysql80 | schema-diff | drop-column | pass |
| mysql80 | schema-diff | fk-ordered-create | pass |
| mysql80 | schema-diff | hostile-identifiers | pass |
| mysql80 | schema-diff | rename-column-preserves-data | pass |
| mysql80 | schema-diff | rename-ambiguous-stays-drop-add | pass |
| mysql80 | schema-diff | add-fk-with-actions | pass |
| mysql80 | schema-diff | drop-fk | pass |
| mysql80 | schema-diff | redefine-fk-action | pass |
| mysql80 | schema-diff | create-view | pass |
| mysql80 | schema-diff | drop-view-on-source | pass |
| mysql80 | schema-diff | redefine-view | pass |
| mysql80 | schema-diff | drop-table-on-source | pass |
| mysql80 | data-diff | diff-shape | pass |
| mysql80 | data-diff | sync-converges | pass |
| sqlite | driver | txn-commit-spans-statements | pass |
| sqlite | driver | txn-rollback-spans-statements | pass |
| sqlite | driver | temp-table-spans-statements | pass |
| sqlite | driver | cte-window-join | pass |
| sqlite | driver | multi-statement-returns-last | pass |
| sqlite | driver | error-surfaces | pass |
| sqlite | driver | ddl-then-reselect | pass |
| sqlite | driver | utility-statements | pass |
| sqlite | driver | apply-batch-failure-shape | pass |
| sqlite | schema-diff | create-table-enum-defaults | pass |
| sqlite | schema-diff | add-columns-json-and-string-default | pass |
| sqlite | schema-diff | add-indexes | pass |
| sqlite | schema-diff | drop-plain-index | pass |
| sqlite | schema-diff | drop-column | pass |
| sqlite | schema-diff | fk-ordered-create | pass |
| sqlite | schema-diff | hostile-identifiers | pass |
| sqlite | schema-diff | rename-column-preserves-data | pass |
| sqlite | schema-diff | rename-ambiguous-stays-drop-add | pass |
| sqlite | schema-diff | create-view | pass |
| sqlite | schema-diff | drop-view-on-source | pass |
| sqlite | schema-diff | redefine-view | pass |
| sqlite | schema-diff | drop-table-on-source | pass |
| sqlite | data-diff | diff-shape | pass |
| sqlite | data-diff | sync-converges | pass |