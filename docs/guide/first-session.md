---
title: Your first project session
description: Connect a model, bind a project, choose permissions, and complete one verifiable task in QianNing Agent.
---

# Your first project session

A useful first run proves four things: the provider works, the session points at the intended project, permission prompts are understandable, and the result can be verified.

## Connect a model

1. Open **Settings → Models**.
2. Add or select a provider.
3. Enter the endpoint and credential required by that provider.
4. Refresh or choose a model from the provider catalog.
5. Run the connection test before leaving Settings.

QianNing Agent supports built-in provider configurations, local endpoints, custom gateways, and OpenAI-compatible APIs. Endpoint shape, authentication, model catalog support, image input, reasoning levels, context size, and output limits vary by provider. Do not assume an OpenAI-compatible endpoint supports every OpenAI feature.

A provider key stays outside the renderer and transcript. The interface exposes configured/not-configured state, not the secret value.

## Create your first project session

1. Add or open a project from the sidebar.
2. Select the directory that contains the repository or working files.
3. Create a new session inside that project.
4. Check the active project name before sending the first task.

A durable session keeps its own project binding. Switching the visible sidebar project does not redirect a background session's tools. File tools resolve relative paths against the session's bound workspace; explicit paths outside the workspace require the active permission policy.

## Choose a permission mode

Use **Ask** for the first session. The host displays confirmation for operations that require it, and a denied or expired request does not execute.

| Permission mode | Practical use |
|---|---|
| **Ask** | Review tool requests before they run; recommended while learning the app |
| **Accept edits** | Streamline normal file edits while retaining prompts for other sensitive operations |
| **Auto** | Run permitted operations without confirmation; use only when you understand the workspace and tool boundary |

The durable session mode and the permission mode are different controls. Agent, Plan, and Goal define the work contract. Ask, Accept edits, and Auto define how host permission decisions are resolved.

## Complete a verifiable task

Start with a task that has a clear finish condition:

> Read this project, identify how tests are run, fix one failing unit test without changing public behavior, run the narrow test and typecheck, then report the modified files and commands.

A good result should leave evidence in the session:

1. the files or symbols inspected;
2. the exact tool calls and their output;
3. a reviewable record for successful Write or Edit operations;
4. the test or build command and exit result;
5. a final answer that states remaining blockers rather than implying success.

Use the work panel to inspect file changes and available rollback evidence. A later manual edit can invalidate rollback for the same file because host-core requires the current hash to match the post-tool hash.

## Use Plan or Goal when the task grows

Choose **Plan** when you want to approve the implementation route. The Agent may inspect the project, then submits an immutable `.pi/plan/*.md` artifact. Approval starts a new execution turn.

Choose **Goal** when you want to approve the result and boundaries while leaving implementation choices to the Agent. The contract records the outcome and objective acceptance criteria in `.pi/goal/*.md`.

A host restart interrupts pending or running contract work and does not replay it automatically.

## Let subagents handle bounded work

QianNing Agent includes built-in subagents for exploration, review, testing, fixing, and UI design. The parent Agent decides when a bounded independent task benefits from delegation. Delegates run in the background; the parent can continue, then receive the reports and incorporate them before finishing.

Use delegation for independent evidence, not for several agents editing the same file. The transcript card and the running panel show the subagent, model, status, elapsed time, and recent tool action.

## Stop, resume, and recover

- Stop interrupts the active turn and shuts down active command process trees.
- Completed transcript messages are stored in the session JSONL file.
- Streaming replies are checkpointed so a crash usually preserves all but the latest interval.
- Restarted sessions restore their project binding and stored transcript.
- Temporary scratch files belong to the session and are removed when the session is deleted; stale orphan scratch directories are swept at startup.

## Next step

Read [Data, privacy, and security](/guide/data-and-security), then explore [Scheduled tasks](/guide/automations), [MCP market](/guide/mcp-market), or [Plugin development](/plugin-development) according to the workflow you need.
