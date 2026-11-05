import type { SkinImportAssetResult } from "@pi-desktop/shared";

/**
 * Ownership of background media during one editing session.
 *
 * The old editor imported a file the moment the user picked it and deleted it
 * the moment they pressed "remove", which got both directions wrong:
 *
 *   - cancel an edit that added media → the file stayed on disk forever,
 *   - remove media then cancel → the SAVED skin kept pointing at a file that no
 *     longer existed, so its wallpaper broke until the next edit.
 *
 * A session fixes the ordering: files imported during the edit are *pending*.
 * Nothing is deleted until the edit is committed (replace: delete the previous
 * file) or abandoned (cancel: delete everything adopted). Deleting always asks
 * the caller first, because a file may still be referenced by another skin.
 */
export type AssetSession = {
  /** Record a just-imported asset as owned by this edit. */
  adopt(result: SkinImportAssetResult): void;
  /** Forget a pending asset (it was replaced by another) and delete its file. */
  drop(assetId: string, ext: string): void;
  /** The edit was saved: pending files belong to the stored skin now. */
  commit(): void;
  /** The edit was abandoned: delete everything this edit imported. */
  discard(): Promise<void>;
  /** Pending assets, for tests and diagnostics. */
  pending(): readonly { assetId: string; ext: string }[];
};

export type DeleteAsset = (assetId: string, ext: string) => Promise<unknown>;

export function createAssetSession(deleteAsset: DeleteAsset): AssetSession {
  const owned = new Map<string, string>();

  const remove = (assetId: string, ext: string) => {
    owned.delete(assetId);
    return deleteAsset(assetId, ext).catch(() => undefined);
  };

  return {
    adopt(result) {
      owned.set(result.assetId, result.ext);
    },
    drop(assetId, ext) {
      if (!owned.has(assetId)) return;
      void remove(assetId, ext);
    },
    commit() {
      owned.clear();
    },
    async discard() {
      const entries = [...owned.entries()];
      owned.clear();
      await Promise.allSettled(entries.map(([assetId, ext]) => deleteAsset(assetId, ext)));
    },
    pending() {
      return [...owned.entries()].map(([assetId, ext]) => ({ assetId, ext }));
    },
  };
}
