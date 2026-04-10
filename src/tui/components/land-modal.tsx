import React from "react";
import { Box, Text } from "ink";
import type { LandPhase } from "../types.ts";
import type {
  LandPlan,
  LandProgressEvent,
  LandStep,
} from "../../commands/land.ts";

export interface LandModalProps {
  phase: LandPhase;
  /** Rows to shift the modal content upward (scroll down into long content). */
  scrollY?: number;
}

function stepKey(step: LandStep): string {
  if ("branch" in step) return `${step.kind}:${step.branch}`;
  return step.kind;
}

function formatEvent(e: LandProgressEvent): string {
  const marker = e.status === "ok"
    ? "\u2713"
    : e.status === "running"
    ? "\u22ef"
    : e.status === "skipped"
    ? "\u00b7"
    : "\u2717";
  const label = "branch" in e.step
    ? `${e.step.kind} ${e.step.branch}`
    : e.step.kind;
  return `${marker} ${label}${e.message ? ` - ${e.message}` : ""}`;
}

function PlanSummary({ plan }: { plan: LandPlan }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>
        Land stack {plan.stackName} ({plan.case})
      </Text>
      <Text>Base: {plan.baseBranch}</Text>
      <Text>Merged: {plan.mergedBranches.join(", ")}</Text>

      {plan.rebaseSteps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Rebase ({plan.rebaseSteps.length})</Text>
          {plan.rebaseSteps.map((s) => (
            <Box key={`r-${s.branch}`}>
              <Text>{s.branch} -&gt; {s.newTarget}</Text>
            </Box>
          ))}
        </Box>
      )}

      {plan.pushSteps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Push ({plan.pushSteps.length}, leaves-first)</Text>
          {plan.pushSteps.map((s) => (
            <Box key={`p-${s.branch}`}>
              <Text>{s.branch}</Text>
            </Box>
          ))}
        </Box>
      )}

      {plan.prUpdates.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>PR retargets ({plan.prUpdates.length})</Text>
          {plan.prUpdates.map((u) => (
            <Box key={`u-${u.prNumber}`}>
              <Text>
                #{u.prNumber} {u.branch}: base {u.oldBase} -&gt; {u.newBase}
                {u.flipToReady ? " (ready)" : ""}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {plan.worktreesToRemove.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            Delete worktree directories from disk
          </Text>
          {plan.worktreesToRemove.map((wt) => (
            <Box key={`wt-${wt.branch}`} flexDirection="column">
              <Text color="yellow">{wt.branch}</Text>
              <Text dimColor>{wt.worktreePath}</Text>
            </Box>
          ))}
        </Box>
      )}

      {plan.branchesToDelete.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Delete</Text>
          {plan.branchesToDelete.map((b) => (
            <Box key={`d-${b}`}>
              <Text>{b}</Text>
            </Box>
          ))}
        </Box>
      )}

      {plan.splitPreview.length > 1 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">Stack will split into:</Text>
          {plan.splitPreview.map((s) => (
            <Box key={`s-${s.stackName}`}>
              <Text>{s.stackName}: {s.branches.join(", ")}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

export function LandModal(
  { phase, scrollY = 0 }: LandModalProps,
): React.ReactElement | null {
  switch (phase.phase) {
    case "idle":
      return null;
    case "planning":
      return (
        <Box
          borderStyle="double"
          flexDirection="column"
          padding={1}
          overflowY="hidden"
        >
          <Box flexDirection="column" marginTop={-scrollY}>
            <Text>Computing land plan for stack {phase.stackName}...</Text>
          </Box>
        </Box>
      );
    case "confirming":
      return (
        <Box
          borderStyle="double"
          flexDirection="column"
          padding={1}
          overflowY="hidden"
        >
          <Box flexDirection="column" marginTop={-scrollY}>
            <PlanSummary plan={phase.plan} />
            <Box marginTop={1}>
              <Text dimColor>[y] confirm [n/esc] cancel</Text>
            </Box>
          </Box>
        </Box>
      );
    case "executing":
      return (
        <Box
          borderStyle="double"
          flexDirection="column"
          padding={1}
          overflowY="hidden"
        >
          <Box flexDirection="column" marginTop={-scrollY}>
            <Text bold>Executing land for stack {phase.plan.stackName}</Text>
            <Box flexDirection="column" marginTop={1}>
              {phase.events.map((e, i) => (
                <Box key={`e-${i}-${stepKey(e.step)}`}>
                  <Text>{formatEvent(e)}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      );
    case "done":
      return (
        <Box
          borderStyle="double"
          flexDirection="column"
          padding={1}
          overflowY="hidden"
        >
          <Box flexDirection="column" marginTop={-scrollY}>
            <Text color="green" bold>
              Landed stack {phase.result.plan.stackName}
            </Text>
            {phase.result.autoMergedBranches.length > 0 && (
              <Text>
                Auto-merged: {phase.result.autoMergedBranches.join(", ")}
              </Text>
            )}
            {phase.result.split.length > 1 && (
              <Box flexDirection="column" marginTop={1}>
                <Text>Split into:</Text>
                {phase.result.split.map((s) => (
                  <Box key={`ds-${s.stackName}`}>
                    <Text>{s.stackName}</Text>
                  </Box>
                ))}
              </Box>
            )}
            <Box marginTop={1}>
              <Text dimColor>[esc] dismiss</Text>
            </Box>
          </Box>
        </Box>
      );
    case "error":
      return (
        <Box
          borderStyle="double"
          flexDirection="column"
          padding={1}
          overflowY="hidden"
        >
          <Box flexDirection="column" marginTop={-scrollY}>
            <Text color="red" bold>Land failed</Text>
            <Text>{phase.message}</Text>
            {phase.events.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Steps</Text>
                {phase.events.map((e, i) => (
                  <Box key={`ee-${i}-${stepKey(e.step)}`}>
                    <Text>{formatEvent(e)}</Text>
                  </Box>
                ))}
              </Box>
            )}
            {phase.rollback && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Rollback</Text>
                {phase.rollback.commands.length > 0 && (
                  <Box flexDirection="column" marginTop={1}>
                    <Text bold>Commands</Text>
                    {phase.rollback.commands.map((cmd, i) => (
                      <Box key={i}>
                        <Text dimColor>$</Text>
                        <Text>{cmd}</Text>
                      </Box>
                    ))}
                  </Box>
                )}
                {phase.rollback.localRestored.length > 0 && (
                  <Text>
                    local restored: {phase.rollback.localRestored.join(", ")}
                  </Text>
                )}
                {phase.rollback.localFailed.length > 0 && (
                  <Text color="red">
                    local FAILED: {phase.rollback.localFailed
                      .map((f) => `${f.branch} (${f.reason})`)
                      .join("; ")}
                  </Text>
                )}
                {phase.rollback.remoteRestored.length > 0 && (
                  <Text>
                    remote restored: {phase.rollback.remoteRestored.join(", ")}
                  </Text>
                )}
                {phase.rollback.remoteFailed.length > 0 && (
                  <Text color="red">
                    remote FAILED: {phase.rollback.remoteFailed
                      .map((f) => `${f.branch} (${f.reason})`)
                      .join("; ")}
                  </Text>
                )}
                {phase.rollback.prFailed.length > 0 && (
                  <Text color="red">
                    pr FAILED: {phase.rollback.prFailed
                      .map((f) => `#${f.prNumber} (${f.reason})`)
                      .join("; ")}
                  </Text>
                )}
              </Box>
            )}
            <Box marginTop={1}>
              <Text dimColor>[esc] dismiss [↑/↓] scroll</Text>
            </Box>
          </Box>
        </Box>
      );
  }
}
