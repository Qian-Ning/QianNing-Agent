import { useEffect, useState } from "react";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { loadComposerCommands } from "./use-composer-autocomplete";
import {
  composerCommandCatalog,
  EMPTY_COMMAND_CATALOG,
  type ComposerCommandCatalog,
} from "../features/chat/composer/command-catalog";

export {
  composerCommandCatalog,
  EMPTY_COMMAND_CATALOG,
  type ComposerCommandCatalog,
  type ComposerCommandEntry,
} from "../features/chat/composer/command-catalog";

/**
 * Commands available to the composer, from the same cached source the slash
 * menu reads. A failed read leaves the catalog empty, which only means the
 * draft keeps plain text styling until the next read — never a blocked
 * composer.
 */
export function useComposerCommandCatalog(): ComposerCommandCatalog {
  const workspaceKey = useAppStore((state) => state.workspace?.path ?? "");
  const [catalog, setCatalog] = useState<ComposerCommandCatalog>(EMPTY_COMMAND_CATALOG);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void loadComposerCommands()
        .then((commands) => {
          if (!cancelled) setCatalog(composerCommandCatalog(commands));
        })
        .catch(() => {
          if (!cancelled) setCatalog(EMPTY_COMMAND_CATALOG);
        });
    };
    load();
    // Installing or removing a skill or plugin changes both the menu and the
    // painted tokens, so the catalog follows the plugin-changed notification.
    const unsubscribe = api.onPluginChanged?.(load);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [workspaceKey]);

  return catalog;
}
