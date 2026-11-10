# Agent delegation

This context describes how the package defines agents, assigns them work, and observes their execution.

## Agent definitions

**Agent**:
A named specialist with instructions and optional settings. An agent can be selected to perform a task; it is not an execution.
_Avoid_: Worker

**Agent type**:
A category that identifies an agent's role and allows selection by role instead of by name.

**Agent scope**:
The set of agent definitions considered for a request, based on user and project sources.

**Subagent**:
An agent invoked by another agent to perform delegated work.
_Avoid_: Child agent

## Work and execution

**Task**:
A unit of work assigned to an agent. Each run handles one task.
_Avoid_: Job

**Run**:
One execution of an agent for a task. Separate executions are separate runs, even when they use the same agent and task.
_Avoid_: Invocation

**Single mode**:
A delegation mode that runs one task with one agent.

**Parallel mode**:
A delegation mode that runs multiple tasks at the same time. Each task has its own run.

**Chain**:
An ordered sequence of agent tasks. Each task can use the previous task's result as context.
_Avoid_: Pipeline

## Reports and outcomes

**Progress report**:
An update that a subagent sends to the calling agent while its run is active. A report does not request a reply and is separate from the run's final result.
_Avoid_: Result

**Run result**:
The final outcome of a run, including its execution status and output. A completed status means the execution ended; it does not establish the quality of the work.
_Avoid_: Report

**Result artifact**:
A saved record of a run's final output and execution details. It supports later review but does not prove that the work is correct.

**Run inspection**:
A read-only view of a run's status and visible activity. Inspection does not control the run or establish the quality of its work.
_Avoid_: Run control
