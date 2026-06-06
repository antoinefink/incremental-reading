import type { LibraryBrowseType, SearchableType } from "../lib/appApi";

export const SEARCHABLE_TYPES: readonly SearchableType[] = ["source", "extract", "card"];
export const BROWSE_TYPES: readonly LibraryBrowseType[] = [
  "source",
  "extract",
  "card",
  "topic",
  "synthesis_note",
  "task",
];
export const PRIORITIES = ["A", "B", "C", "D"] as const;

export type CollectionExplorerMode = "browse" | "search";
export type PriorityLetter = (typeof PRIORITIES)[number];

export interface CollectionExplorerFilters {
  readonly query?: string | undefined;
  readonly type?: LibraryBrowseType | null;
  readonly conceptId?: string | null;
  readonly priority?: PriorityLetter | null;
  readonly status?: string | null;
}

export function isSearchableType(type: string | null | undefined): type is SearchableType {
  return type === "source" || type === "extract" || type === "card";
}

export function parseBrowseType(value: unknown): LibraryBrowseType | null {
  if (typeof value !== "string") return null;
  return BROWSE_TYPES.includes(value as LibraryBrowseType) ? (value as LibraryBrowseType) : null;
}

export function parseSearchableType(value: unknown): SearchableType | null {
  return typeof value === "string" && isSearchableType(value) ? value : null;
}

export function parsePriority(value: unknown): PriorityLetter | null {
  return typeof value === "string" && PRIORITIES.includes(value as PriorityLetter)
    ? (value as PriorityLetter)
    : null;
}

export function parseStringParam(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function explorerSearchParams(
  mode: CollectionExplorerMode,
  filters: CollectionExplorerFilters,
): Record<string, string | undefined> {
  const query = filters.query?.trim();
  const type = filters.type ?? null;
  return {
    ...(query ? { q: query } : {}),
    ...(type && (mode === "browse" || isSearchableType(type)) ? { type } : {}),
    ...(filters.conceptId ? { conceptId: filters.conceptId } : {}),
    ...(filters.priority ? { priority: filters.priority } : {}),
    ...(mode === "browse" && filters.status ? { status: filters.status } : {}),
  };
}
