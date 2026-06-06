import type { NavigateFn } from "@tanstack/react-router";
import type { QueueItemSummary } from "../../lib/appApi";

interface OpenQueueItemOptions {
  readonly item: QueueItemSummary;
  readonly navigate: NavigateFn;
  readonly select: (id: string) => void;
  readonly asOf?: string | undefined;
}

function routeToProcess(navigate: NavigateFn, asOf?: string): void {
  void navigate({ to: "/process", search: asOf ? { asOf } : {} });
}

function routeToReview(navigate: NavigateFn, asOf?: string): void {
  void navigate(asOf ? { to: "/review", search: { asOf } } : { to: "/review" });
}

function routeToElement(
  type: string | null,
  id: string,
  navigate: NavigateFn,
  asOf?: string,
  options: { linkedTaskTarget?: boolean } = {},
): void {
  if (type === "source" || (options.linkedTaskTarget && type === "topic")) {
    void navigate({ to: "/source/$id", params: { id } });
    return;
  }

  if (type === "extract") {
    void navigate({ to: "/extract/$id", params: { id } });
    return;
  }

  if (type === "card") {
    routeToReview(navigate, asOf);
    return;
  }

  routeToProcess(navigate, asOf);
}

/**
 * Open a due queue item in its work surface. Linked verification tasks open the element
 * they protect, while unlinked tasks stay in the process loop.
 */
export function openQueueItem({ item, navigate, select, asOf }: OpenQueueItemOptions): void {
  if (item.type === "task" && item.linkedElementId) {
    select(item.linkedElementId);
    routeToElement(item.linkedElementType, item.linkedElementId, navigate, asOf, {
      linkedTaskTarget: true,
    });
    return;
  }

  select(item.id);
  routeToElement(item.type, item.id, navigate, asOf);
}
