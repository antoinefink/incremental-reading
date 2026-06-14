import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_EMBEDDING_MODEL_ID } from "@interleave/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error build.mjs is an executable JavaScript build script with a small exported test seam.
import { stageEmbeddingModel } from "../../build.mjs";

/** Lay down a fake "already vendored" model tree (ready marker + q8 weights) under `dir`. */
async function stageFakeModel(dir: string, markerModelId: string = DEFAULT_EMBEDDING_MODEL_ID) {
  const modelsDir = path.join(dir, "models");
  const onnxDir = path.join(modelsDir, DEFAULT_EMBEDDING_MODEL_ID, "onnx");
  await mkdir(onnxDir, { recursive: true });
  await writeFile(path.join(onnxDir, "model_quantized.onnx"), "fake-weights");
  await writeFile(
    path.join(modelsDir, ".interleave-model-ready.json"),
    `${JSON.stringify({ modelId: markerModelId })}\n`,
  );
}

describe("desktop build script embedding model staging", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "interleave-embedding-build-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("skips model acquisition for ordinary dev builds", async () => {
    const pipeline = vi.fn();

    await stageEmbeddingModel(tempDir, {
      required: false,
      requested: false,
      transformers: { pipeline },
    });

    expect(pipeline).not.toHaveBeenCalled();
    expect(existsSync(path.join(tempDir, "models"))).toBe(true);
    expect(existsSync(path.join(tempDir, "models", ".interleave-model-ready.json"))).toBe(false);
  });

  it("fails required dist staging when the model cannot be acquired", async () => {
    const pipeline = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      stageEmbeddingModel(tempDir, {
        required: true,
        transformers: { pipeline },
      }),
    ).rejects.toThrow(/EmbeddingGemma model could not be staged/);
  });

  it("stages the requested model with build-time remote access and writes a ready marker", async () => {
    const env = {};
    const pipeline = vi.fn(async () => ({ dispose: vi.fn() }));

    await stageEmbeddingModel(tempDir, {
      required: true,
      transformers: { env, pipeline },
    });

    expect(env).toMatchObject({
      cacheDir: path.join(tempDir, "models"),
      localModelPath: path.join(tempDir, "models"),
      allowLocalModels: true,
      allowRemoteModels: true,
    });
    expect(pipeline).toHaveBeenCalledWith("feature-extraction", DEFAULT_EMBEDDING_MODEL_ID, {
      dtype: "q8",
    });
    const marker = JSON.parse(
      readFileSync(path.join(tempDir, "models", ".interleave-model-ready.json"), "utf8"),
    );
    expect(marker).toEqual({ modelId: DEFAULT_EMBEDDING_MODEL_ID });
  });

  it("preserves an already-vendored model on a flagless rebuild (no re-download)", async () => {
    await stageFakeModel(tempDir);
    const pipeline = vi.fn();

    await stageEmbeddingModel(tempDir, {
      required: false,
      requested: false,
      transformers: { pipeline },
    });

    // The model is sticky: a plain dev build neither re-downloads nor wipes it.
    expect(pipeline).not.toHaveBeenCalled();
    expect(existsSync(path.join(tempDir, "models", ".interleave-model-ready.json"))).toBe(true);
  });

  it("does not re-download when a valid model is already staged, even when requested", async () => {
    await stageFakeModel(tempDir);
    const pipeline = vi.fn(async () => ({ dispose: vi.fn() }));

    await stageEmbeddingModel(tempDir, { required: true, transformers: { env: {}, pipeline } });

    expect(pipeline).not.toHaveBeenCalled();
  });

  it("re-vendors when the staged marker records a different model id", async () => {
    await stageFakeModel(tempDir, "stale/old-model");
    const pipeline = vi.fn(async () => ({ dispose: vi.fn() }));

    await stageEmbeddingModel(tempDir, { required: true, transformers: { env: {}, pipeline } });

    // A model-id bump must not be masked by stale weights — re-acquire.
    expect(pipeline).toHaveBeenCalledWith("feature-extraction", DEFAULT_EMBEDDING_MODEL_ID, {
      dtype: "q8",
    });
  });
});
