/**
 * PdfRegionService (T065) — the local-first PDF region-extract orchestrator (main).
 *
 * In the PDF reader the user draws a rectangle over a figure/table; the RENDERER
 * crops that region from the page it already has on a `<canvas>` and ships the
 * small PNG `ArrayBuffer` + the normalized rect + page to MAIN. This service
 * composes the `ExtractionService` (the `media_fragment` region extract + its
 * `source_locations` page+region anchor + lineage + attention schedule) with the
 * T059 `AssetVaultService` (the cropped PNG streamed into the vault) so a region
 * extract becomes its own attention-scheduled topic with full lineage. It runs
 * ENTIRELY in the Electron main process — the renderer never resolves a vault path,
 * never writes bytes, never touches SQLite.
 *
 * ## Ordering (element row first, then streamed image asset)
 *
 * The `assets` row's FK requires the owning `media_fragment` element to exist, and
 * `importAsset` opens its OWN metadata transaction. So we (1) mint the element id
 * up front, (2) create the region extract (element + body + region anchor + edge +
 * schedule) in ONE transaction keyed by that id, then (3) `importAsset` the cropped
 * PNG keyed by the now-existing element. On an `importAsset` failure we best-effort
 * SOFT-DELETE the just-created element (so no orphan fragment lingers) and re-throw,
 * mirroring the rollback discipline of `PdfImportService` / `UrlImportService`. The
 * image bytes live in the vault (the canonical `media/<asset_id>/original.bin`
 * layout, mime `image/png`), NEVER SQLite.
 */

import { Readable } from "node:stream";
import {
  type BlockId,
  type ElementId,
  type PriorityLabel,
  priorityFromLabel,
  type RegionRect,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { type ExtractionService, newElementId, type Repositories } from "@interleave/local-db";
import type { AssetVaultService } from "./asset-vault-service";

/** Constructor dependencies (injected once; mirroring `PdfImportService`). */
export interface PdfRegionServiceDeps {
  /** The open Drizzle database (accepted for symmetry; the services own their tx). */
  readonly db: InterleaveDatabase;
  /** The repository bag bound to the same DB (for the source-priority lookup). */
  readonly repositories: Repositories;
  /** The extraction service (the `media_fragment` region extract path). */
  readonly extraction: ExtractionService;
  /** The T059 streamed asset importer (the cropped PNG goes through it). */
  readonly assetVault: AssetVaultService;
}

/** Arguments to {@link PdfRegionService.extractRegion}. */
export interface ExtractRegionInput {
  /** The PDF source element the region was drawn over (the lineage root). */
  readonly sourceElementId: ElementId;
  /** The 1-based page the region sits on. */
  readonly page: number;
  /** The page's heading/first stable block id — the region's jump anchor. */
  readonly pageBlockId: string;
  /** The normalized bounding box `{ x0, y0, x1, y1 }` (fractions 0–1). */
  readonly region: RegionRect;
  /** The cropped figure PNG bytes (produced in the renderer's `<canvas>`). */
  readonly imagePng: ArrayBuffer;
  /** An optional user caption; defaults to "Figure on page N" main-side. */
  readonly caption?: string | null;
  /** Optional A/B/C/D priority override; else INHERITS the source's priority. */
  readonly priority?: PriorityLabel;
}

/** The created region extract + its image asset (the IPC result builds from this). */
export interface ExtractRegionResult {
  /** The new `media_fragment` element id. */
  readonly id: string;
  /** A flat summary of the freshly created `media_fragment`. */
  readonly element: {
    readonly id: string;
    readonly type: string;
    readonly status: string;
    readonly stage: string;
    readonly priority: number;
    readonly title: string;
    readonly dueAt: string | null;
    readonly sourceId: string | null;
    readonly parentId: string | null;
  };
  /** The stored region source-location anchor. */
  readonly location: {
    readonly id: string;
    readonly sourceElementId: string;
    readonly page: number | null;
    readonly region: RegionRect | null;
    readonly label: string | null;
  };
  /** The cropped image asset (vault-relative path + id) for the inspector to display. */
  readonly asset: {
    readonly id: string;
    readonly relativePath: string;
  };
}

export class PdfRegionService {
  private readonly repositories: Repositories;
  private readonly extraction: ExtractionService;
  private readonly assetVault: AssetVaultService;

  constructor(deps: PdfRegionServiceDeps) {
    this.repositories = deps.repositories;
    this.extraction = deps.extraction;
    this.assetVault = deps.assetVault;
  }

  /**
   * Crop a PDF region into a `media_fragment` extract. See the file header for the
   * ordering + rollback contract. Throws if the source is missing/deleted; on an
   * image-import failure the just-created fragment is soft-deleted and the error
   * re-thrown (no orphan element/asset/file).
   */
  async extractRegion(input: ExtractRegionInput): Promise<ExtractRegionResult> {
    const sourceElementId = input.sourceElementId;
    const source = this.repositories.elements.findById(sourceElementId);
    if (!source || source.deletedAt) {
      throw new Error(`PdfRegionService.extractRegion: source ${sourceElementId} not found`);
    }
    // Inherit the source's numeric priority unless the renderer overrode it.
    const priority = input.priority ? priorityFromLabel(input.priority) : source.priority;

    // 1. Mint the element id up front so the asset is keyed by it and a failed
    //    import can soft-delete the exact element.
    const elementId = newElementId();

    // 2. Create the region extract (element + body + region anchor + edge +
    //    attention schedule) in ONE transaction keyed by the minted id.
    const { element, location } = this.extraction.createRegionExtract({
      elementId,
      sourceElementId,
      page: input.page,
      pageBlockId: input.pageBlockId as BlockId,
      region: input.region,
      priority,
      caption: input.caption ?? null,
    });

    // 3. Stream the cropped PNG into the vault keyed by the now-existing element.
    //    (Its own metadata transaction; bytes never touch SQLite.) On failure,
    //    soft-delete the fragment so no orphan element/location lingers.
    let assetId: string;
    let relativePath: string;
    try {
      const stream = Readable.from(Buffer.from(input.imagePng));
      const asset = await this.assetVault.importAsset({
        owningElementId: element.id as ElementId,
        kind: "image",
        source: stream,
        mime: "image/png",
        // Use the canonical media layout (`media/<asset_id>/original.bin`); the row
        // is mime-typed `image/png` so it reads back as the cropped figure.
      });
      assetId = asset.id;
      relativePath = asset.location.vaultPath.relativePath;
    } catch (err) {
      try {
        this.repositories.elements.softDelete(element.id as ElementId);
      } catch {
        // Best-effort: surface the original import error regardless.
      }
      throw err;
    }

    return {
      id: element.id,
      element: {
        id: element.id,
        type: element.type,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        title: element.title,
        dueAt: element.dueAt,
        sourceId: element.sourceId,
        parentId: element.parentId,
      },
      location: {
        id: location.id,
        sourceElementId: location.sourceElementId,
        page: location.page,
        region: location.region,
        label: location.label,
      },
      asset: { id: assetId, relativePath },
    };
  }
}
