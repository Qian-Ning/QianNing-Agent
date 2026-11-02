/**
 * The system file picker, as the composer's attach button needs it.
 *
 * The native plugin copies every picked document into the app's cache and hands
 * back its sandbox path, so what the agent later reads is a real file, not a
 * content URI that dies with the grant.
 */

export type PickedFile = {
  name: string;
  path: string;
  size: number;
  mimeType: string | null;
};

type FilesPluginApi = {
  pick(): Promise<{ files?: PickedFile[]; canceled?: boolean }>;
  readDataUrl(args: { path: string; mimeType?: string }): Promise<{
    kind: "image" | "missing" | "notImage" | "tooLarge";
    dataUrl?: string;
    size?: number;
  }>;
};

function plugin(): FilesPluginApi | null {
  if (typeof window === "undefined") return null;
  const capacitor = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  const found = capacitor?.Plugins?.QnFiles as FilesPluginApi | undefined;
  return found && typeof found.pick === "function" ? found : null;
}

export function hasFilePicker(): boolean {
  return plugin() !== null;
}

/** Opens the picker and returns what the user chose; an empty list on cancel. */
export async function pickDeviceFiles(): Promise<PickedFile[]> {
  const api = plugin();
  if (!api) return [];
  const result = await api.pick();
  if (!result || result.canceled) return [];
  return (result.files ?? []).filter((file) => Boolean(file?.path));
}

/** The bytes of a picked file, as the data URL the composer previews. */
export async function readDeviceDataUrl(
  path: string,
  mimeType?: string,
): Promise<{ kind: "image" | "missing" | "notImage" | "tooLarge"; dataUrl?: string; size?: number }> {
  const api = plugin();
  if (!api || typeof api.readDataUrl !== "function") return { kind: "missing" };
  try {
    return await api.readDataUrl({ path, ...(mimeType ? { mimeType } : {}) });
  } catch {
    return { kind: "missing" };
  }
}

/**
 * A picked file read as text.
 *
 * The device plugin answers with a data URL for any file it copied, so a JSON
 * bundle arrives the same way an image does — decode the base64 and let
 * TextDecoder handle the bytes, which atob alone would mangle above ASCII.
 */
export async function readDeviceText(path: string): Promise<string | null> {
  const read = await readDeviceDataUrl(path, "application/json");
  const dataUrl = read.dataUrl;
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
