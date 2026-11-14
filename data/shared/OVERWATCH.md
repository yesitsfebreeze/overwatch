# Shared Overwatch workflow

This file is maintained by Overwatch synchronization. Project instructions and extensions remain authoritative for their own scope.

## Establish current state

Before editing, identify the machine, repository, branch, exact commit, working tree, published tools, and active work. Read the project's AGENTS.md, SYSTEMS.md, WORK.md, and relevant instructions. A tool catalog or installed package version does not prove the running server's revision.

## Coordinate the work

Use the project's Overwatch ledger. Read the complete plan, claims, dependencies, and checks. Claim and load an available unit with a distinct owner. Preserve every other worker's tasks, guards, claims, staging, and changes. Different publications can share one project plan; serialize shared planning writes. A stale claim remains another owner's work until it is explicitly released.

## Implement and verify

Reproduce the issue, change its owning implementation, and run meaningful checks against the integrated result. Use supported background execution for long commands and inspect their completion status. Record only results demonstrated by the checked revision. Complete and publish only the changes authorized for the task.

## Synchronize shared infrastructure

Use sync_check, sync_migrate, and sync_verify, or the equivalent overwatch sync commands. The receipt in .overwatch/sync/state.json records the committed authority, migration and schema versions, shared-file ownership, and project extensions. Automatic checks run on initialization and reconnection.

Only committed source content is eligible for migration. Shared infrastructure and project-owned data have separate ownership. Project notes, live plans, claims, guards, custom MCP servers, workflows, credentials, and unrelated files are preserved. A conflict, active claim, dirty shared target, offline source, or incompatible schema is reported explicitly. Do not clear a lock, weaken a check, overwrite a customization, or replace project state to force synchronization.

A completed project migration and a loaded server revision are separate facts. Reconnect a server when its report requires a new runtime. Use exact Git commits for machine handoffs and verify the destination before claiming synchronization.
