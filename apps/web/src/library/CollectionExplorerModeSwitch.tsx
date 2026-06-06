import { Icon } from "../components/Icon";
import type { CollectionExplorerMode } from "./collectionExplorerState";

export function CollectionExplorerModeSwitch({
  mode,
  onBrowse,
  onSearch,
}: {
  readonly mode: CollectionExplorerMode;
  readonly onBrowse: () => void;
  readonly onSearch: () => void;
}) {
  return (
    <fieldset className="lib-mode">
      <legend className="lib-mode__legend">Collection Explorer mode</legend>
      <button
        type="button"
        aria-current={mode === "browse" ? "page" : undefined}
        className={`lib-mode__btn${mode === "browse" ? " lib-mode__btn--on" : ""}`}
        data-testid="collection-mode-browse"
        onClick={onBrowse}
      >
        <Icon name="library" size={14} />
        Browse
      </button>
      <button
        type="button"
        aria-current={mode === "search" ? "page" : undefined}
        className={`lib-mode__btn${mode === "search" ? " lib-mode__btn--on" : ""}`}
        data-testid="collection-mode-search"
        onClick={onSearch}
      >
        <Icon name="search" size={14} />
        Search
      </button>
    </fieldset>
  );
}
