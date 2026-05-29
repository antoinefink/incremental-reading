/**
 * `?` keyboard cheat sheet (T004).
 *
 * A modal reference grouping the app's shortcuts (rebuilt from the kit's
 * CheatSheet). Esc or a click on the backdrop / close button dismisses it.
 * Contents are static config from `nav.ts`.
 */
import { useEffect } from "react";
import { Icon } from "../components/Icon";
import { Kbd } from "./Kbd";
import { CHEAT_SHEET } from "./nav";

export type CheatSheetProps = {
  open: boolean;
  onClose: () => void;
};

export function CheatSheet({ open, onClose }: CheatSheetProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="shell-cheat-overlay" data-testid="cheat-sheet">
      {/* Backdrop is a real button so click-to-dismiss is keyboard-accessible
          (Esc also closes via the global handler above). */}
      <button
        type="button"
        className="shell-overlay-backdrop"
        aria-label="Close keyboard shortcuts"
        tabIndex={-1}
        onClick={onClose}
      />
      <div className="shell-cheat" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="shell-cheat__head">
          <h3>Keyboard shortcuts</h3>
          <button type="button" className="shell-cheat__close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="shell-cheat__grid">
          {CHEAT_SHEET.map((group) => (
            <div className="shell-cheat__group" key={group.group}>
              <h4>{group.group}</h4>
              {group.rows.map(([label, keys]) => (
                <div className="shell-cheat__row" key={label}>
                  <span>{label}</span>
                  <Kbd keys={keys} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
