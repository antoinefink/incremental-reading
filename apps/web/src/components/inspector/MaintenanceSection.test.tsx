/**
 * Inspector "Maintenance" section tests (T092).
 *
 * The verification-task create/list/complete/postpone all happen MAIN-side through the
 * typed `tasks.*` `window.appApi`; this asserts the RENDERER seam only:
 *  - the section lists the open tasks protecting the element (with the kind label);
 *  - "Create verification task" opens the picker and `tasks.create` is called with the
 *    chosen kind + the linked element id + the schedule choice;
 *  - completing a task calls `tasks.complete`.
 *
 * `appApi` is mocked so the test exercises only this component's wiring — no IPC/SQLite.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "../../lib/appApi";

const h = vi.hoisted(() => ({
  listTasks: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  postponeTask: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      listTasks: h.listTasks,
      createTask: h.createTask,
      completeTask: h.completeTask,
      postponeTask: h.postponeTask,
    },
  };
});

import { MaintenanceSection } from "./Inspector";

const TASK: TaskSummary = {
  id: "task-1",
  taskType: "verify_claim",
  title: "Verify the definition",
  note: "Check the 2024 revision",
  status: "scheduled",
  dueAt: "2026-06-04T00:00:00.000Z",
  priority: 0.875,
  linkedElement: { id: "card-1", type: "card", title: "A card" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.listTasks.mockResolvedValue({ tasks: [TASK] });
  h.createTask.mockResolvedValue({ task: TASK });
  h.completeTask.mockResolvedValue({ task: { ...TASK, status: "done" } });
});

describe("Inspector MaintenanceSection (T092)", () => {
  it("lists the open tasks protecting the element with the kind label", async () => {
    render(<MaintenanceSection elementId="card-1" onChanged={vi.fn()} />);
    await waitFor(() => {
      expect(h.listTasks).toHaveBeenCalledWith({ linkedElementId: "card-1" });
    });
    const row = await screen.findByTestId("maintenance-task");
    expect(row).toHaveAttribute("data-task-id", "task-1");
    expect(row).toHaveTextContent(/Verify claim/i);
    expect(row).toHaveTextContent(/Check the 2024 revision/);
    expect(screen.getByTestId("maintenance-count")).toHaveTextContent("1");
  });

  it("shows the empty state when there are no open tasks", async () => {
    h.listTasks.mockResolvedValue({ tasks: [] });
    render(<MaintenanceSection elementId="card-1" onChanged={vi.fn()} />);
    expect(await screen.findByTestId("maintenance-empty")).toBeInTheDocument();
  });

  it("creates a verification task with the chosen kind + linked id + schedule", async () => {
    h.listTasks.mockResolvedValue({ tasks: [] });
    const onChanged = vi.fn();
    render(<MaintenanceSection elementId="card-1" onChanged={onChanged} />);
    await screen.findByTestId("maintenance-empty");

    fireEvent.click(screen.getByTestId("maintenance-create"));
    fireEvent.change(screen.getByTestId("maintenance-type"), {
      target: { value: "find_better_source" },
    });
    fireEvent.change(screen.getByTestId("maintenance-note"), {
      target: { value: "swap the pre-print for the published version" },
    });
    fireEvent.change(screen.getByTestId("maintenance-due"), { target: { value: "nextWeek" } });
    fireEvent.click(screen.getByTestId("maintenance-create-save"));

    await waitFor(() => {
      expect(h.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: "find_better_source",
          linkedElementId: "card-1",
          note: "swap the pre-print for the published version",
          dueChoice: { kind: "nextWeek" },
        }),
      );
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("completes a task via tasks.complete", async () => {
    render(<MaintenanceSection elementId="card-1" onChanged={vi.fn()} />);
    const completeBtn = await screen.findByTestId("maintenance-complete");
    fireEvent.click(completeBtn);
    await waitFor(() => {
      expect(h.completeTask).toHaveBeenCalledWith({ id: "task-1" });
    });
  });
});
