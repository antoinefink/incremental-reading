/**
 * Keyboard hint pill (T004).
 *
 * Renders one or more key caps in the design kit's `.kbd` style (mono, raised
 * bottom border). Used by the command bar, command palette, and cheat sheet.
 * Presentation-only.
 */

export type KbdProps = {
  /** A single key, or a sequence rendered as adjacent caps (e.g. ["⌘", "K"]). */
  keys: string | readonly string[];
};

export function Kbd({ keys }: KbdProps) {
  const list = Array.isArray(keys) ? keys : [keys as string];
  return (
    <span className="shell-kbd-group">
      {list.map((k, i) => (
        // Keys are static and may legitimately repeat (e.g. ["1","1"]); index is stable here.
        // biome-ignore lint/suspicious/noArrayIndexKey: static, never-reordered key caps
        <span className="shell-kbd" key={i}>
          {k}
        </span>
      ))}
    </span>
  );
}
